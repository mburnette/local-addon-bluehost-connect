'use strict';

const { shellQuote: q } = require('./transport');

/** Folders under a cPanel home that never hold a site, or hold too much to search (mail, logs, caches, trash). */
const PRUNE = ['mail', 'tmp', 'logs', '.trash', '.cpanel', '.cache', '.npm', '.composer', '.bluehost-connect', 'access-logs', 'etc', 'ssl'];

/** Picks a WP-CLI command for shell scripts: the server's `wp`, else the build this add-on downloaded earlier. */
const WP_CLI_DETECT = 'WPC=""; if command -v wp >/dev/null 2>&1; then WPC="wp"; '
	+ 'elif [ -f "$HOME/.bluehost-connect/wp-cli.phar" ] && command -v php >/dev/null 2>&1; then WPC="php $HOME/.bluehost-connect/wp-cli.phar"; fi;';

/**
 * Shell script that lists every WordPress install in a shared-hosting account. It prints cPanel's domain list
 * (`uapi DomainInfo domains_data`, JSON) between markers, then one `wp|<dir>|<home URL>` line per folder holding
 * wp-load.php. Plugin and upload folders are not searched.
 */
function listSitesScript() {
	const prune = PRUNE.map((d) => `-path "$HOME/${d}"`).join(' -o ');
	return [
		'echo "home=$(cd "$HOME" && pwd -P)";',
		'if command -v uapi >/dev/null 2>&1; then echo "---uapi"; uapi --output=json DomainInfo domains_data 2>/dev/null; echo; echo "---end"; fi;',
		WP_CLI_DETECT,
		'T=""; command -v timeout >/dev/null 2>&1 && T="timeout 20";',
		`find "$HOME" -maxdepth 5 \\( ${prune} -o -name wp-content -o -name node_modules -o -name .git \\) -prune -o -name wp-load.php -print 2>/dev/null |`,
		'while IFS= read -r f; do d="$(cd "$(dirname "$f")" && pwd -P)"; h="";',
		'if [ -n "$WPC" ]; then h="$(cd "$d" && $T $WPC option get home --skip-plugins --skip-themes </dev/null 2>/dev/null | head -n 1)"; fi;',
		'printf \'wp|%s|%s\\n\' "$d" "$h"; done; true',
	].join(' ');
}

const trimSlash = (p) => String(p || '').replace(/\/+$/, '');
const hostOf = (url) => String(url || '').replace(/^https?:\/\//i, '').replace(/^\/\//, '').split('/')[0].toLowerCase();

/** Reads cPanel's domain list into [{ domain, documentroot, type }] (parked domains share the main docroot). */
function parseUapiDomains(json) {
	let data;
	try {
		data = JSON.parse(json);
	} catch (e) {
		return [];
	}
	const d = (data && data.result && data.result.data) || (data && data.data) || {};
	const main = d.main_domain || null;
	const out = [];
	if (main && main.domain) out.push({ domain: main.domain, documentroot: trimSlash(main.documentroot), type: 'main' });
	[['addon_domains', 'addon'], ['sub_domains', 'subdomain']].forEach(([key, type]) => {
		(Array.isArray(d[key]) ? d[key] : []).forEach((entry) => {
			if (entry && entry.domain) out.push({ domain: entry.domain, documentroot: trimSlash(entry.documentroot), type });
		});
	});
	(Array.isArray(d.parked_domains) ? d.parked_domains : []).forEach((entry) => {
		const domain = typeof entry === 'string' ? entry : entry && entry.domain;
		if (domain && main) out.push({ domain, documentroot: trimSlash(main.documentroot), type: 'parked' });
	});
	return out;
}

/**
 * Turns listSitesScript() output into the sites a Local site can link to:
 * [{ webroot, home, label, domains, altDomains, isMain }], the account's main domain first.
 */
function parseSiteList(stdout) {
	const lines = stdout.split(/\r?\n/);
	const homeLine = lines.find((l) => l.startsWith('home='));
	const home = homeLine ? trimSlash(homeLine.slice(5)) : '';
	const start = lines.indexOf('---uapi');
	const end = start >= 0 ? lines.indexOf('---end', start) : -1;
	const domains = start >= 0 && end > start ? parseUapiDomains(lines.slice(start + 1, end).join('\n')) : [];

	// cPanel may report /home/user while `pwd -P` resolves /home2/user; compare paths relative to the home folder.
	const rel = (p) => {
		const clean = trimSlash(p);
		const m = /^\/home\d*\/[^/]+(\/.*)?$/.exec(clean);
		return m ? (m[1] || '') : clean;
	};

	const seen = new Set();
	const sites = [];
	lines.filter((l) => l.startsWith('wp|')).forEach((line) => {
		const [, webroot, siteHome = ''] = line.split('|');
		if (!webroot || seen.has(webroot)) return;
		seen.add(webroot);
		const own = domains.filter((dom) => dom.documentroot && rel(dom.documentroot) === rel(webroot));
		const homeHost = hostOf(siteHome);
		// New sites are often served from a subfolder of the temporary domain (example.abc.mybluehost.me/website_1234),
		// so the label keeps the path: the host alone would be the same for several sites.
		const homeLabel = String(siteHome).replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
		const primary = homeLabel || (own.find((dom) => dom.type !== 'parked') || own[0] || {}).domain || '';
		const relative = home && webroot.startsWith(`${home}/`) ? `~/${webroot.slice(home.length + 1)}` : webroot;
		sites.push({
			webroot,
			home: siteHome || null,
			label: primary || relative,
			path: relative,
			domains: own.map((dom) => dom.domain),
			altDomains: [...new Set(own.map((dom) => dom.domain.toLowerCase()))].filter((dom) => dom !== homeHost),
			// Without cPanel's list, ~/public_html is still the main domain's folder.
			isMain: own.some((dom) => dom.type === 'main') || (!domains.length && webroot === `${home}/public_html`),
		});
	});
	const named = (s) => Number(Boolean(s.home || s.domains.length));
	return sites.sort((a, b) => Number(b.isMain) - Number(a.isMain) || named(b) - named(a) || a.label.localeCompare(b.label));
}

/** "ssh-rsa AAAA… comment" -> "ssh-rsa AAAA…": the part that identifies a key regardless of its comment. */
const keyBody = (publicKey) => String(publicKey).trim().split(/\s+/).slice(0, 2).join(' ');

/** Adds a public key to ~/.ssh/authorized_keys once, with the permissions sshd requires. */
function installKeyScript(publicKey) {
	const f = '"$HOME/.ssh/authorized_keys"';
	return [
		'umask 077; mkdir -p "$HOME/.ssh" && touch', f, '&& chmod 700 "$HOME/.ssh" && chmod 600', f, '&&',
		`{ grep -qF ${q(keyBody(publicKey))} ${f} || {`,
		// Start on a fresh line if the file does not end with a newline.
		`if [ -s ${f} ] && [ -n "$(tail -c 1 ${f})" ]; then echo >> ${f}; fi;`,
		`printf '%s\\n' ${q(String(publicKey).trim())} >> ${f}; }; }`,
	].join(' ');
}

/** Removes a public key (matched without its comment) from ~/.ssh/authorized_keys. */
function removeKeyScript(publicKey) {
	const f = '"$HOME/.ssh/authorized_keys"';
	return [
		`[ -f ${f} ] || exit 0;`,
		`t="$(mktemp)" && grep -vF ${q(keyBody(publicKey))} ${f} > "$t";`,
		`cat "$t" > ${f}; rm -f "$t"`,
	].join(' ');
}

module.exports = {
	listSitesScript,
	parseUapiDomains,
	parseSiteList,
	installKeyScript,
	removeKeyScript,
	keyBody,
	hostOf,
};
