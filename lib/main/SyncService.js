'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { SYNC_EXCLUDES, SYNC_PROTECT, MANAGED_CORE_EXCLUDES, IGNORE_FILES, WP_CLI_PHAR_URL } = require('../constants');
const { Transport, TransportError, describeSshFailure, shellQuote: q, toPosixPath } = require('./transport');

/** WP-CLI on the server, without plugins or themes so a broken one cannot stop a transfer. */
const wpCommand = (remote) => `${remote.wp} --skip-plugins --skip-themes`;

/**
 * Shell snippet (run after `cd` into the webroot) that sets $p to the site's table prefix, $a to every table in its
 * database (one per line) and $o to the comma-separated tables with the prefix (empty when either is unknown). On
 * cPanel one database can hold several WordPress sites with different prefixes, so exports are limited to "$o" with
 * `${o:+--tables="$o"}`: a pull never downloads another site's tables, and the push backup holds only this site's.
 */
const tableListSnippet = (WP) => `{ p="$(${WP} config get table_prefix 2>/dev/null)"; `
	+ `a="$(${WP} db query 'SHOW TABLES' --skip-column-names 2>/dev/null)"; `
	+ `o="$(printf '%s\\n' "$a" | awk -v p="$p" 'p != "" && index($0, p) == 1' | paste -s -d , -)"; true; }`;
const PREFIX_TABLES_ARG = '${o:+--tables="$o"}';
/** A table name that is safe to put in a DROP TABLE statement between backticks. */
const SAFE_TABLE_NAME = /^[A-Za-z0-9_$-]+$/;
const REMOTE_BACKUP_NAME = 'local-backup-before-push.sql';
const LOCAL_BACKUP_NAME = 'local-backup-before-pull.sql';
/** Folder beside the Local webroot that keeps the files each pull replaced or deleted, and how many pulls to keep. */
const FILE_BACKUP_FOLDER = 'bluehost-backups';
const FILE_BACKUPS_KEPT = 3;
const MARIADB_SANDBOX_LINE = /^\/\*M!999999\\- enable the sandbox mode \*\/\s*$/;

const DEFAULT_OPTIONS = {
	push: {
		files: true,
		database: true,
		deleteRemote: true,
		purgeCache: true,
	},
	pull: {
		files: true,
		database: true,
		backupLocal: true,
		deleteLocal: true,
	},
};

const LABELS = {
	push: { status: 'pushing_v2', verb: 'push', gerund: 'pushing', preposition: 'to', done: 'pushed to' },
	pull: { status: 'pulling', verb: 'pull', gerund: 'pulling', preposition: 'from', done: 'pulled from' },
};

/**
 * Makes a dump importable on the other side. Local runs MySQL 8 and Bluehost servers may run MariaDB, and each side's
 * default collations (utf8mb4_0900_* / utf8mb4_uca1400_*) are unknown to the other. Newer MariaDB mysqldump also
 * writes a "sandbox mode" first line that the MySQL client rejects. Streams line by line so large dumps are not
 * loaded into memory.
 */
async function normalizeDumpForImport(file) {
	const tmp = `${file}.tmp`;
	const input = fs.createReadStream(file, { encoding: 'utf8' });
	const output = fs.createWriteStream(tmp, { encoding: 'utf8' });
	const rl = readline.createInterface({ input, crlfDelay: Infinity });
	for await (const line of rl) {
		if (MARIADB_SANDBOX_LINE.test(line)) continue;
		const fixed = line
			.replace(/utf8mb4_(?:0900|uca1400)_[a-z0-9_]+/g, 'utf8mb4_unicode_520_ci')
			.replace(/utf8mb3_uca1400_[a-z0-9_]+/g, 'utf8mb3_unicode_ci');
		if (!output.write(`${fixed}\n`)) {
			await new Promise((resolve) => output.once('drain', resolve));
		}
	}
	await new Promise((resolve, reject) => output.end((err) => (err ? reject(err) : resolve())));
	fs.renameSync(tmp, file);
}

/** Parses `key=value` lines printed by our remote helper commands. */
function parseKeyValues(stdout) {
	return stdout.split(/\r?\n/).reduce((acc, line) => {
		const i = line.indexOf('=');
		if (i > 0) acc[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		return acc;
	}, {});
}

/** A webroot-relative path from a comparison: no absolute paths, no "..", no empty segments. */
const isSafeRelativePath = (p) => typeof p === 'string'
	&& p.length > 0
	&& !p.startsWith('/')
	&& !/^[A-Za-z]:/.test(p)
	&& !p.includes('\0')
	&& p.split(/[\\/]/).every((seg) => seg && seg !== '..' && seg !== '.');

/** "https://example.com/blog/" -> "//example.com/blog" */
const schemeless = (url) => String(url || '').trim().replace(/\/+$/, '').replace(/^https?:/i, '');

/**
 * Search/replace pairs that move a site from one base URL to another, the same scheme-relative replacement
 * Local Connect uses for WP Engine, plus the JSON-escaped form block editors and page builders store, plus a
 * final scheme fix when the destination's scheme differs.
 */
function urlReplacements(fromBases, toUrl) {
	const to = schemeless(toUrl);
	const pairs = [];
	fromBases.map(schemeless).filter((from) => from && from !== to).forEach((from) => {
		pairs.push([from, to]);
		pairs.push([from.replace(/\//g, '\\/'), to.replace(/\//g, '\\/')]);
	});
	const host = to.replace(/^\/\//, '');
	if (/^https:/i.test(toUrl)) pairs.push([`http://${host}`, `https://${host}`]);
	else if (/^http:/i.test(toUrl)) pairs.push([`https://${host}`, `http://${host}`]);
	return pairs;
}

/**
 * Shell snippet that finds the WordPress webroot for the SSH user and a private working directory outside it for
 * backups, temporary dumps and a downloaded WP-CLI (never inside the webroot, so a dump is never
 * web-downloadable). Shared hosting (cPanel) serves the main domain from ~/public_html and other domains from
 * folders that are often nested inside it; Bluehost Cloud (WP Cloud) serves each site from /srv/htdocs.
 *
 * One cPanel account usually hosts several sites, so the private folder is per site: ~/.bluehost-connect/<slug>,
 * where the slug is the webroot's path inside the home folder with "/" turned into "_", plus a checksum of the full
 * path so two webroots never share a folder ("site-<checksum>" alone when the webroot is not inside the home folder).
 * It falls back to the folder above the webroot, unless that is a site's public folder or inside one, then to TMPDIR
 * with the user id in the folder name.
 *
 * It also prints `nested=<relative path>` for every other site inside the webroot (WordPress installs and cPanel
 * docroots), so transfers can exclude them: a push with --delete must never remove an addon domain's site.
 */
function discoverRemoteScript({ remotePath }) {
	// A stored or chosen path is used as is: falling back to another folder could push to the wrong site.
	const candidates = remotePath
		? [q(remotePath)]
		: ['"$HOME/public_html"', '"/srv/htdocs"', '"$HOME/htdocs"', '"$HOME"'];
	return [
		`for d in ${candidates.join(' ')}; do`,
		'if [ -f "$d/wp-config.php" ] || [ -f "$d/wp-load.php" ]; then',
		'cd "$d" && W="$(pwd -P)"; H="$(cd "$HOME" 2>/dev/null && pwd -P)"; T="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)"; P="";',
		// Per-site folder name: the webroot's path inside the home folder, made unique by a checksum of the full path
		// ("a/b_c" and "a_b/c" would otherwise both become "a_b_c").
		'K="$(printf %s "$W" | cksum | cut -d " " -f 1)";',
		'case "$W" in "$H"/*) S="$(printf %s "${W#"$H"/}" | tr / _)-$K";; *) S="site-$K";; esac;',
		'for b in "$H" "$(dirname "$W")" "$T"; do',
		'b="$(cd "$b" 2>/dev/null && pwd -P)"; [ -n "$b" ] || continue; case "$b/" in "$W"/*) continue;; esac;',
		// The folder above the webroot is skipped when it is a site's public folder or inside one (an addon domain or a
		// WordPress in a subfolder sits inside the main site's public_html, which would serve the dumps).
		'[ "$b" != "$H" ] && [ "$b" != "$T" ] && { [ -f "$b/wp-config.php" ] || [ -f "$b/wp-load.php" ] || case "$b/" in */public_html/*) true;; *) false;; esac; } && continue;',
		'c="$b/.bluehost-connect"; [ "$b" = "$T" ] && c="$b/.bluehost-connect-$(id -u)";',
		// Only folders this user owns: in a shared temp folder another user could have made (and could swap) the folder.
		'if (umask 077; mkdir -p "$c/$S") 2>/dev/null && [ -w "$c/$S" ] && [ -O "$c" ] && [ -O "$c/$S" ]; then chmod 700 "$c" "$c/$S" 2>/dev/null; P="$c/$S"; break; fi; done;',
		'echo "webroot=$W"; echo "private=$P";',
		'if command -v wp >/dev/null 2>&1; then echo "wpcli=wp";',
		'elif [ -n "$P" ] && [ -f "$P/wp-cli.phar" ] && command -v php >/dev/null 2>&1; then echo "wpcli=phar"; else echo "wpcli=no"; fi;',
		'if command -v php >/dev/null 2>&1; then echo "php=yes"; else echo "php=no"; fi;',
		'if command -v rsync >/dev/null 2>&1; then echo "rsync=yes"; else echo "rsync=no"; fi;',
		'find "$W" -maxdepth 4 \\( -name wp-content -o -name node_modules -o -name .git \\) -prune -o -name wp-load.php ! -path "$W/wp-load.php" -print 2>/dev/null',
		'| while IFS= read -r f; do r="$(dirname "$f")"; echo "nested=${r#"$W"/}"; done;',
		'if command -v uapi >/dev/null 2>&1; then',
		'uapi DomainInfo domains_data 2>/dev/null | sed -n "s/^ *documentroot: *//p" | while IFS= read -r r; do',
		'r="$(cd "$r" 2>/dev/null && pwd -P)"; case "$r" in "$W"/*) echo "nested=${r#"$W"/}";; esac; done; fi;',
		// Links that resolve outside the site are the platform's (WP Cloud's shared core, plugins and drop-ins).
		'find "$W" -maxdepth 3 \\( -name node_modules -o -name .git \\) -prune -o -type l -print 2>/dev/null | while IFS= read -r l; do',
		't="$(readlink -f "$l" 2>/dev/null)"; case "$t" in "$W"/*) ;; *) echo "managed=${l#"$W"/}";; esac; done;',
		'exit 0; fi; done;',
		'echo "home=$HOME"; exit 3',
	].join(' ');
}

/**
 * Symlinks in a Local site that rsync treats as unsafe (absolute, or climbing out of the webroot): typically a theme
 * or plugin developed in another folder and linked into wp-content. Paths are webroot-relative with "/" separators.
 * `external` links are pushed as the files they point to (--copy-unsafe-links) but never pulled into, so a pull can
 * neither replace the link nor write into the folder it points to. `broken` ones have no target and are skipped.
 */
function findExternalLinks(webRoot) {
	const external = [];
	const broken = [];
	let root;
	try {
		root = fs.realpathSync(webRoot);
	} catch (e) {
		return { external, broken };
	}
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			return;
		}
		entries.forEach((entry) => {
			const full = path.join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				const raw = fs.readlinkSync(full);
				const resolved = path.resolve(dir, raw);
				const unsafe = path.isAbsolute(raw) || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`));
				if (unsafe) (fs.existsSync(full) ? external : broken).push(relPath);
			} else if (entry.isDirectory()) {
				walk(full, relPath);
			}
		});
	};
	walk(root, '');
	return { external, broken };
}

/** Every `nested=` line from discoverRemoteScript(), de-duplicated, without nested sites inside other nested sites. */
function parseManaged(stdout) {
	return [...new Set(stdout.split(/\r?\n/)
		.filter((l) => l.startsWith('managed='))
		.map((l) => l.slice('managed='.length).replace(/^\/+|\/+$/g, ''))
		.filter((p) => isSafeRelativePath(p)))].sort();
}

function parseNested(stdout) {
	const all = [...new Set(stdout.split(/\r?\n/)
		.filter((l) => l.startsWith('nested='))
		.map((l) => l.slice('nested='.length).replace(/^\/+|\/+$/g, ''))
		.filter((p) => isSafeRelativePath(p)))];
	return all.filter((p) => !all.some((other) => other !== p && p.startsWith(`${other}/`))).sort();
}

/** Purges the Bluehost plugin's caches (page cache, Nginx, Cloudflare) through its Newfold performance module. */
const NEWFOLD_PURGE_PHP = String.raw`if (function_exists('NewfoldLabs\WP\ModuleLoader\container')) { $c = \NewfoldLabs\WP\ModuleLoader\container(); if ($c->has('cachePurger')) { $c->get('cachePurger')->purge_all(); } }`;

const COMPARE_FORMAT = '--out-format=BH|%i|%l|%M|%n';

/** rsync prints %M as "YYYY/MM/DD-HH:MM:SS" in local time. Returns epoch seconds, or null. */
function parseRsyncTime(value) {
	const m = /^(\d{4})\/(\d{2})\/(\d{2})-(\d{2}):(\d{2}):(\d{2})$/.exec(value || '');
	if (!m) return null;
	return Math.round(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000);
}

/**
 * Parses dry-run output written with COMPARE_FORMAT into { op, type, size, mtime, path } items, where op is
 * 'create' (missing on the receiver), 'update' (differs) or 'delete' (only on the receiver). Directories and
 * attribute-only differences are dropped: the comparison is about file contents.
 */
function parseItemized(stdout) {
	const items = [];
	stdout.split(/\r?\n/).forEach((line) => {
		if (!line.startsWith('BH|')) return;
		const parts = line.split('|');
		if (parts.length < 5) return;
		const code = parts[1];
		const filePath = parts.slice(4).join('|');
		if (!filePath || filePath.endsWith('/')) return;
		if (code.startsWith('*deleting')) {
			items.push({ op: 'delete', type: 'file', size: null, mtime: null, path: filePath });
			return;
		}
		const [transfer, kind] = code;
		if (transfer === '.' || kind === 'd') return;
		items.push({
			op: code.slice(2).startsWith('+++') ? 'create' : 'update',
			type: kind === 'L' ? 'symlink' : 'file',
			size: Number(parts[2]),
			mtime: parseRsyncTime(parts[3]),
			path: filePath,
		});
	});
	return items;
}

/**
 * Merges a Local -> Bluehost dry run with a Bluehost -> Local dry run into one list of differing files. The two
 * passes complement each other: each reports the sender's size and mtime, so together they describe both sides.
 */
function mergeComparison(pushItems, pullItems) {
	const byPath = new Map();
	const entry = (p) => {
		if (!byPath.has(p)) byPath.set(p, { path: p, type: 'file', status: null, local: null, remote: null });
		return byPath.get(p);
	};
	pushItems.forEach((item) => {
		const e = entry(item.path);
		if (item.op === 'delete') {
			e.status = e.status || 'remote-only';
			return;
		}
		e.type = item.type;
		e.status = item.op === 'create' ? 'local-only' : 'changed';
		e.local = { size: item.size, mtime: item.mtime };
	});
	pullItems.forEach((item) => {
		const e = entry(item.path);
		if (item.op === 'delete') {
			e.status = e.status || 'local-only';
			return;
		}
		e.type = e.local ? e.type : item.type;
		e.status = item.op === 'create' ? 'remote-only' : 'changed';
		e.remote = { size: item.size, mtime: item.mtime };
	});
	return [...byPath.values()]
		.map((e) => {
			let newer = null;
			if (e.status === 'changed' && e.local && e.remote && e.local.mtime && e.remote.mtime) {
				newer = e.local.mtime > e.remote.mtime ? 'local' : e.remote.mtime > e.local.mtime ? 'remote' : 'same';
			}
			return { ...e, newer };
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** What cPanel prints, instead of running the command, when the account has no shell (SFTP only). */
const SHELL_DISABLED_RE = /shell access is (?:disabled|not enabled)|this account is currently not available/i;

class ShellAccessDisabledError extends Error {
	constructor() {
		super('SSH shell access is turned off for this Bluehost account, so rsync and WP-CLI cannot run. In the Bluehost '
			+ 'Portal, open Hosting → My Plans → SSH Management and turn on Shell Access, then try again.');
		this.name = 'ShellAccessDisabledError';
	}
}

/** Pushes Local sites to, and pulls them from, a linked Bluehost site. */
class SyncService {
	constructor({ store, keys, workDir, services, sendIPCEvent, logger }) {
		this._store = store;
		this._keys = keys;
		this._workDir = workDir;
		this._siteData = services.siteData;
		this._siteDatabase = services.siteDatabase;
		this._siteProcessManager = services.siteProcessManager;
		this._wpCli = services.wpCli;
		this._send = sendIPCEvent;
		this._logger = logger;
		/** siteId -> 'push' | 'pull' | 'compare' */
		this._active = new Map();
		/** siteId -> Map(path -> status) from the latest comparison; selective transfers may only touch these. */
		this._compared = new Map();
	}

	activity(siteId) {
		return this._active.get(siteId) || null;
	}

	transportFor(link) {
		return new Transport({
			host: link.host,
			port: link.port,
			username: link.username,
			privateKeyPath: link.authType === 'password' ? null : this._keys.privateKeyPath,
			password: link.authType === 'password' ? link.password : null,
			workDir: this._workDir,
			logger: this._logger,
		});
	}

	/** Connects, finds the webroot, and checks the server has what a push or pull needs. */
	async discoverRemote(transport, { remotePath } = {}) {
		const { code, stdout, stderr } = await transport.exec(discoverRemoteScript({ remotePath }), { allowFailure: true });
		// ssh itself exits 255 when it cannot connect or log in; report that, not a missing WordPress.
		if (code === 255 && !/^webroot=/m.test(stdout)) throw new TransportError(describeSshFailure(code, stderr, transport), code, stderr);
		if (SHELL_DISABLED_RE.test(`${stdout}\n${stderr}`)) {
			throw new ShellAccessDisabledError();
		}
		const info = parseKeyValues(stdout);
		if (code === 3 || !info.webroot) {
			throw new Error(
				`Connected, but could not find a WordPress install under ${info.home || 'the home directory'}. ` +
				'Set the remote path to the folder containing wp-config.php (usually ~/public_html, or a folder inside it).',
			);
		}
		if (code !== 0) {
			throw new Error(`Unexpected response from the server while locating WordPress (exit ${code}).`);
		}
		if (!info.private) {
			throw new Error('Connected, but found no writable folder outside the webroot for temporary database dumps.');
		}
		return this._withWp({
			remotePath: info.webroot,
			privateDir: info.private,
			wpCli: info.wpcli,
			hasPhp: info.php === 'yes',
			hasRsync: info.rsync === 'yes',
			nested: parseNested(stdout),
			managed: parseManaged(stdout),
		});
	}

	_withWp(remote) {
		const wp = remote.wpCli === 'wp' ? 'wp' : remote.wpCli === 'phar' ? `php ${q(`${remote.privateDir}/wp-cli.phar`)}` : null;
		return { ...remote, wp, hasWpCli: Boolean(wp) };
	}

	/**
	 * Downloads the official WP-CLI build into the private folder when the server has no `wp` command, so database
	 * transfers still work on plans without it. Returns the updated remote info (unchanged if WP-CLI is present).
	 */
	async ensureWpCli(transport, remote) {
		if (remote.hasWpCli || !remote.hasPhp) return remote;
		const dir = q(remote.privateDir);
		const url = q(WP_CLI_PHAR_URL);
		await transport.exec([
			`cd ${dir} &&`,
			`{ curl -fsSL ${url} -o wp-cli.phar.tmp 2>/dev/null || wget -q -O wp-cli.phar.tmp ${url}; } &&`,
			'php wp-cli.phar.tmp --info >/dev/null && mv wp-cli.phar.tmp wp-cli.phar; s=$?; rm -f wp-cli.phar.tmp; exit $s',
		].join(' '), { allowFailure: true });
		const check = await transport.exec(`[ -f ${q(`${remote.privateDir}/wp-cli.phar`)} ] && echo ok`, { allowFailure: true });
		return /ok/.test(check.stdout) ? this._withWp({ ...remote, wpCli: 'phar' }) : remote;
	}

	_message(siteId, label, progressText) {
		this._send('updateSiteMessage', siteId, {
			label,
			stripes: true,
			progressText,
			truncateProgressText: Boolean(progressText),
		});
	}

	/**
	 * Lists files that differ between Local and Bluehost without transferring anything, like MagicSync's
	 * preview. Uses rsync's quick check (size + modification time) unless `checksum` is set.
	 */
	async compare(siteId, { checksum = false } = {}) {
		const site = this._siteData.getSite(siteId);
		if (!site) throw new Error('Local site not found.');
		const link = this._store.getLink(siteId);
		if (!link) throw new Error('This site is not linked to Bluehost yet.');
		if (this._active.has(siteId)) {
			throw new Error(`A Bluehost ${this._active.get(siteId)} is already running for this site.`);
		}
		this._active.set(siteId, 'compare');
		const transport = this.transportFor(link);
		try {
			const remote = await this.discoverRemote(transport, { remotePath: link.remotePath });
			if (!remote.hasRsync) throw new Error('rsync was not found on the server, so files cannot be compared.');
			const args = [
				'--recursive',
				'--links',
				'--copy-unsafe-links',
				'--times',
				'--omit-dir-times',
				'--dry-run',
				'--delete',
				COMPARE_FORMAT,
				...(checksum ? ['--checksum'] : []),
			];
			const pushArgs = [...args, ...this._excludeArgs(site, ['push', 'pull'], remote, 'push')];
			const pullArgs = [...args, ...this._excludeArgs(site, ['push', 'pull'], remote, 'pull')];
			const pushOut = await transport.rsyncUp({ source: `${site.paths.webRoot}${path.sep}`, destination: `${remote.remotePath}/`, extraArgs: pushArgs });
			const pullOut = await transport.rsyncDown({ source: `${remote.remotePath}/`, destination: `${site.paths.webRoot}${path.sep}`, extraArgs: pullArgs });
			const entries = mergeComparison(parseItemized(pushOut), parseItemized(pullOut));
			this._compared.set(siteId, new Map(entries.map((e) => [e.path, e.status])));
			return { at: new Date().toISOString(), checksum, remotePath: remote.remotePath, entries };
		} finally {
			this._active.delete(siteId);
			await transport.close();
		}
	}

	push(siteId, options = {}) {
		return this._run(siteId, 'push', options, (ctx) => this._push(ctx));
	}

	pull(siteId, options = {}) {
		return this._run(siteId, 'pull', options, (ctx) => this._pull(ctx));
	}

	/**
	 * Shared lifecycle for both directions, mirroring Local Connect: site status overlay, progress messages,
	 * completion/error banners, one transfer per site at a time.
	 */
	async _run(siteId, direction, options, body) {
		const labels = LABELS[direction];
		const opts = { ...DEFAULT_OPTIONS[direction], ...options };
		const site = this._siteData.getSite(siteId);
		if (!site) throw new Error('Local site not found.');
		const link = this._store.getLink(siteId);
		if (!link) throw new Error('This site is not linked to Bluehost yet.');
		if (opts.fileList) {
			const compared = this._compared.get(siteId);
			if (!Array.isArray(opts.fileList) || !opts.fileList.length) throw new Error('Select at least one file.');
			if (!compared || opts.fileList.some((p) => !compared.has(p) || !isSafeRelativePath(p))) {
				throw new Error('The file list is out of date. Compare again, then choose files.');
			}
			// Files that exist only on the receiving side are deleted there rather than transferred.
			const onlyOnReceiver = direction === 'push' ? 'remote-only' : 'local-only';
			opts.selection = {
				transfer: opts.fileList.filter((p) => compared.get(p) !== onlyOnReceiver),
				remove: opts.fileList.filter((p) => compared.get(p) === onlyOnReceiver),
			};
			opts.files = true;
			opts.database = false;
		}
		if (!opts.files && !opts.database) throw new Error(`Choose files, database, or both to ${labels.verb}.`);
		if (this._active.has(siteId)) {
			throw new Error(`A Bluehost ${this._active.get(siteId)} is already running for this site.`);
		}

		this._active.set(siteId, direction);
		this._send('updateSiteStatus', siteId, labels.status);
		const startedAt = Date.now();
		const warnings = [];
		const destination = link.label || link.domain || link.host;

		const transport = this.transportFor(link);
		try {
			this._message(siteId, 'Connecting to Bluehost');
			let remote = await this.discoverRemote(transport, { remotePath: link.remotePath });
			if (opts.database && !remote.hasWpCli && remote.hasPhp) {
				this._message(siteId, 'Installing WP-CLI on the server');
				remote = await this.ensureWpCli(transport, remote);
			}
			if (opts.database && !remote.hasWpCli) {
				throw new Error(`WP-CLI was not found on the server, so the database cannot be ${labels.done.split(' ')[0]}.`);
			}
			if (opts.files && !remote.hasRsync) {
				throw new Error(`rsync was not found on the server, so files cannot be ${labels.done.split(' ')[0]}.`);
			}

			const notes = [];
			await body({ site, link, opts, transport, remote, warnings, notes });

			const summary = {
				at: new Date().toISOString(),
				files: opts.files,
				database: opts.database,
				selectedFiles: opts.fileList ? opts.fileList.length : undefined,
				seconds: Math.round((Date.now() - startedAt) / 1000),
			};
			this._store.updateLink(siteId, {
				[direction === 'push' ? 'lastPush' : 'lastPull']: summary,
				remotePath: remote.remotePath,
				privateDir: remote.privateDir,
				nested: remote.nested,
				managed: remote.managed,
			});

			this._send('clearConnectBanners', siteId);
			this._send('showSiteBanner', {
				siteID: siteId,
				id: `bluehost-site-${direction}ed`,
				title: `${direction === 'push' ? 'Push' : 'Pull'} complete!`,
				message: `${site.name} has been ${labels.done} Bluehost (${destination}).${[...warnings, ...notes].map((m) => ` ${m}`).join('')}`,
				variant: warnings.length ? 'warning' : 'success',
			});
			if (direction === 'pull') this._send('refreshSiteVersions');
			return { ok: true, summary, warnings };
		} catch (e) {
			this._logger.error(`Bluehost ${direction} failed: ${e.message}`, { stack: e.stack, stderr: e.stderr });
			this._send('clearConnectBanners', siteId);
			this._send('showSiteBanner', {
				siteID: siteId,
				id: `bluehost-${labels.gerund}-error`,
				title: `Uh-oh! We ran into an issue when ${labels.gerund} ${labels.preposition} Bluehost.`,
				message: e.message,
				variant: 'error',
			});
			throw e;
		} finally {
			this._active.delete(siteId);
			this._compared.delete(siteId);
			await transport.close();
			const status = this._siteProcessManager ? this._siteProcessManager.getSiteStatus(site) : 'running';
			this._send('updateSiteStatus', siteId, status === labels.status ? 'running' : status);
			this._send('getAttention');
		}
	}

	async _ensureLocalSiteRunning(site, direction) {
		if (this._siteProcessManager && this._siteProcessManager.getSiteStatus(site) !== 'running') {
			this._message(site.id, 'Starting the Local site to access its database');
			await this._siteProcessManager.start(site);
			this._send('updateSiteStatus', site.id, LABELS[direction].status);
		}
	}

	/** Excludes for a transfer in the `side` direction ('push' or 'pull'), plus the ignore files of `directions`. */
	_excludeArgs(site, directions, remote, side) {
		const args = SYNC_EXCLUDES.map((pattern) => `--exclude=${pattern}`);
		// Other sites served from inside this webroot (addon domains, subdomains) are never transferred or deleted.
		(remote.nested || []).forEach((p) => args.push(`--exclude=/${p}/`));
		// WP Cloud serves WordPress core from a shared copy (/srv/htdocs/__wp__): each side keeps its own core.
		if ((remote.managed || []).includes('__wp__')) args.push(...MANAGED_CORE_EXCLUDES.map((pattern) => `--exclude=${pattern}`));
		// Platform-managed links are never replaced by a push; a pull brings their contents down as real files.
		if (side === 'push') (remote.managed || []).forEach((p) => args.push(`--exclude=/${p}`));
		const links = findExternalLinks(site.paths.webRoot);
		if (links.broken.length) this._logger.warn(`Skipping broken symlinks in ${site.name}: ${links.broken.join(', ')}`);
		(side === 'pull' ? [...links.external, ...links.broken] : links.broken).forEach((p) => args.push(`--exclude=/${p}`));
		args.push(...SYNC_PROTECT);
		directions.forEach((direction) => {
			const ignoreFile = path.join(site.paths.webRoot, IGNORE_FILES[direction]);
			if (fs.existsSync(ignoreFile)) args.push(`--exclude-from=${toPosixPath(ignoreFile)}`);
		});
		return args;
	}

	/**
	 * rsync flags for a transfer. With a file list (selective sync) only those paths move. Deletions for a
	 * selection are done separately (see _push/_pull): rsync 3.1's --delete-missing-args aborts when a listed
	 * file's parent folder is also missing on the sender. Returns a cleanup function for the temporary list file.
	 */
	_fileSyncArgs(site, direction, remote, { deleteExtraneous, fileList, backupDir }) {
		// --copy-unsafe-links: a symlink pointing outside the site (a theme or plugin developed in another folder and
		// linked into wp-content) is sent as the files it points to; the other side has no such folder. Links within the
		// site stay links.
		// No --perms: existing files and folders keep the receiver's permissions, and --chmod alone sets them for new
		// ones. On WP Cloud, htdocs, wp-content and plugins are owned by root; forcing permissions there fails, and
		// the server's rsync 3.5 reports that with a message Local's bundled rsync 3.1.3 cannot decode ("unexpected
		// tag"), which aborts the whole transfer.
		const args = [
			'--links',
			'--copy-unsafe-links',
			'--times',
			'--omit-dir-times',
			'--compress',
			'--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r',
			'--verbose',
			'--out-format=Changed:%n',
		];
		let listFile = null;
		if (fileList) {
			listFile = path.join(os.tmpdir(), `bluehost-files-${site.id}-${crypto.randomBytes(6).toString('hex')}.txt`);
			fs.writeFileSync(listFile, fileList.join('\0'));
			args.push(`--files-from=${toPosixPath(listFile)}`, '--from0');
		} else {
			args.push('--recursive');
			if (deleteExtraneous) args.push('--delete');
		}
		args.push(...this._excludeArgs(site, [direction], remote, direction));
		// Files the transfer replaces or deletes are moved here instead of being lost (a pull into Local by mistake).
		if (backupDir) args.push('--backup', `--backup-dir=${toPosixPath(backupDir)}`);
		return { args, cleanup: () => listFile && fs.rmSync(listFile, { force: true }) };
	}

	_fileProgress(siteId, label) {
		let lastUpdate = 0;
		return (file) => {
			const now = Date.now();
			if (now - lastUpdate < 150) return;
			lastUpdate = now;
			this._message(siteId, label, file);
		};
	}

	async _rsyncFiles(site, direction, transport, remote, { deleteExtraneous, fileList, backupDir }) {
		const { args, cleanup } = this._fileSyncArgs(site, direction, remote, { deleteExtraneous, fileList, backupDir });
		const localRoot = `${site.paths.webRoot}${path.sep}`;
		const remoteRoot = `${remote.remotePath}/`;
		try {
			if (direction === 'push') {
				await transport.rsyncUp({ source: localRoot, destination: remoteRoot, extraArgs: args, onFile: this._fileProgress(site.id, 'Uploading files') });
			} else {
				await transport.rsyncDown({ source: remoteRoot, destination: localRoot, extraArgs: args, onFile: this._fileProgress(site.id, 'Downloading files') });
			}
		} finally {
			cleanup();
		}
	}

	_tempName(site, kind) {
		const token = crypto.randomBytes(6).toString('hex');
		return { token, local: path.join(os.tmpdir(), `bluehost-${kind}-${site.id}-${token}.sql`) };
	}

	async _getLocalTablePrefix(site) {
		try {
			return await this._siteDatabase.getTablePrefix(site);
		} catch (e) {
			this._logger.warn(`Could not read the local table prefix: ${e.message}`);
			return null;
		}
	}

	// ---------------------------------------------------------------- push

	async _push({ site, link, opts, transport, remote, warnings }) {
		if (opts.files && opts.selection) {
			const { transfer, remove } = opts.selection;
			this._message(site.id, `Syncing ${opts.fileList.length} selected file(s) to Bluehost`);
			if (transfer.length) await this._rsyncFiles(site, 'push', transport, remote, { fileList: transfer });
			for (let i = 0; i < remove.length; i += 200) {
				await transport.exec(`cd ${q(remote.remotePath)} && rm -f -- ${remove.slice(i, i + 200).map(q).join(' ')}`);
			}
		} else if (opts.files) {
			this._message(site.id, 'Uploading files to Bluehost');
			await this._rsyncFiles(site, 'push', transport, remote, { deleteExtraneous: opts.deleteRemote });
		}

		if (opts.database) {
			await this._pushDatabase(site, link, transport, remote, warnings);
		}

		if (opts.purgeCache) {
			this._message(site.id, 'Clearing caches on Bluehost');
			// The Bluehost plugin must load for its purge, so that call runs WP-CLI with plugins. Removing the page-cache
			// folders afterwards covers sites where the plugin is inactive or older.
			const steps = remote.wp
				? [`${wpCommand(remote)} cache flush`, `${remote.wp} eval ${q(NEWFOLD_PURGE_PHP)}`]
				: [];
			steps.push('rm -rf wp-content/newfold-page-cache wp-content/endurance-page-cache');
			await transport.exec(`cd ${q(remote.remotePath)} && (${steps.join('; ')}) >/dev/null 2>&1; true`, {
				allowFailure: true,
			});
		}
	}

	async _pushDatabase(site, link, transport, remote, warnings) {
		const cd = `cd ${q(remote.remotePath)}`;
		const WP = wpCommand(remote);
		await this._ensureLocalSiteRunning(site, 'push');

		this._message(site.id, 'Exporting the Local database');
		const { token, local: localDump } = this._tempName(site, 'push');
		const remoteDump = `${remote.privateDir}/local-push-${token}.sql`;
		const remoteBackup = `${remote.privateDir}/${REMOTE_BACKUP_NAME}`;

		try {
			await this._siteDatabase.dump(site, localDump);
			await normalizeDumpForImport(localDump);

			this._message(site.id, 'Backing up the Bluehost database');
			const state = parseKeyValues((await transport.exec(
				`${cd} && umask 077 && ${tableListSnippet(WP)} && ` +
				`${WP} db export ${q(remoteBackup)} ${PREFIX_TABLES_ARG} --no-tablespaces=true >/dev/null && ` +
				'echo "table_prefix=$p" && echo "tables=$(printf \'%s\' "$a" | tr \'\\n\' \' \')" && ' +
				`echo "home=$(${WP} option get home 2>/dev/null)"`,
			)).stdout);
			const remotePrefix = state.table_prefix || null;
			const remoteHome = state.home || (link.domain ? `//${link.domain}` : '');
			const localPrefix = await this._getLocalTablePrefix(site);

			// A cPanel database can hold several WordPress sites (an addon domain installed into the main site's database,
			// say), told apart by their table prefixes. `wp db reset` would drop the whole database, so then only this
			// site's tables are replaced, and a Local prefix that matches another site's tables stops the push before
			// anything changes.
			const tables = String(state.tables || '').split(/\s+/).filter(Boolean);
			const ownTables = remotePrefix ? tables.filter((t) => t.startsWith(remotePrefix)) : [];
			const otherTables = remotePrefix ? tables.filter((t) => !t.startsWith(remotePrefix)) : [];
			const shared = otherTables.length > 0;
			if (shared) {
				const clash = localPrefix ? otherTables.filter((t) => t.startsWith(localPrefix)) : otherTables;
				if (!localPrefix || clash.length) {
					throw new Error(`The Bluehost database also holds tables of another site (${otherTables.slice(0, 3).join(', ')}${otherTables.length > 3 ? ', …' : ''}), `
						+ `and ${localPrefix ? `this Local site's table prefix (${localPrefix}) would overwrite ${clash.slice(0, 3).join(', ')}` : 'the Local table prefix could not be read'}. `
						+ `Change the Local site's table prefix to ${remotePrefix} (or push files only); the database was not changed.`);
				}
				if (ownTables.some((t) => !SAFE_TABLE_NAME.test(t))) {
					throw new Error('The Bluehost database is shared with another site and has table names the add-on can\'t drop safely; the database was not changed.');
				}
			}
			const dropOwn = ownTables.length
				? `${WP} db query ${q(`DROP TABLE IF EXISTS ${ownTables.map((t) => `\`${t}\``).join(', ')}`)} && `
				: '';
			const clearForImport = shared ? dropOwn : `${WP} db reset --yes && `;

			this._message(site.id, 'Uploading the database');
			await transport.rsyncUp({ source: localDump, destination: remoteDump, extraArgs: ['--compress', '--times'] });

			this._message(site.id, 'Importing the database on Bluehost');
			try {
				await transport.exec(`${cd} && ${clearForImport}${WP} db import ${q(remoteDump)}`);
			} catch (importError) {
				this._message(site.id, 'Import failed, restoring the previous Bluehost database');
				// The backup holds only this site's tables (each dropped and recreated by the import) when others share the database.
				const restore = await transport.exec(`${cd} && ${shared ? '' : `${WP} db reset --yes && `}${WP} db import ${q(remoteBackup)}`, { allowFailure: true });
				if (restore.code !== 0) {
					throw new Error(`Database import failed, and restoring the previous database also failed. The backup is on the server at ${remoteBackup}. ${importError.message}`);
				}
				throw new Error(`Database import failed and the previous database was restored. ${importError.message}`);
			}

			if (localPrefix && localPrefix !== remotePrefix) {
				this._message(site.id, 'Updating the remote table prefix to match Local');
				await transport.exec(`${cd} && ${WP} config set table_prefix ${q(localPrefix)}`);
			}

			if (!site.domain || !remoteHome) {
				warnings.push('Could not determine the Bluehost URL, so Local URLs were not replaced.');
				return;
			}
			this._message(site.id, 'Replacing Local URLs with the Bluehost URL');
			// In a shared database --all-tables would also rewrite the other sites' tables.
			const tableScope = shared ? '--all-tables-with-prefix' : '--all-tables';
			for (const [from, to] of urlReplacements([`//${site.domain}`], remoteHome)) {
				await transport.exec(`${cd} && ${WP} search-replace ${q(from)} ${q(to)} ${tableScope} --precise --skip-columns=guid --report-changed-only`);
			}
		} finally {
			fs.rmSync(localDump, { force: true });
			fs.rmSync(`${localDump}.tmp`, { force: true });
			await transport.exec(`rm -f ${q(remoteDump)}`, { allowFailure: true }).catch(() => {});
		}
	}

	// ---------------------------------------------------------------- pull

	/**
	 * A new folder for the Local files this pull replaces or deletes, beside the webroot (app/bluehost-backups/<time>).
	 * Older ones beyond FILE_BACKUPS_KEPT are removed.
	 */
	_newFileBackupDir(site) {
		const parent = path.join(path.dirname(path.resolve(site.paths.webRoot)), FILE_BACKUP_FOLDER);
		fs.mkdirSync(parent, { recursive: true });
		const existing = fs.readdirSync(parent).filter((d) => /^pull-/.test(d)).sort();
		existing.slice(0, Math.max(0, existing.length - (FILE_BACKUPS_KEPT - 1))).forEach((d) => {
			fs.rmSync(path.join(parent, d), { recursive: true, force: true });
		});
		return path.join(parent, `pull-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	}

	/** Reports where a pull saved the Local files it replaced, or removes the folder if it saved none. */
	_finishFileBackup(site, backupDir, notes) {
		if (!fs.existsSync(backupDir)) return;
		if (!fs.readdirSync(backupDir).length) {
			fs.rmSync(backupDir, { recursive: true, force: true });
			return;
		}
		const shown = path.relative(path.dirname(path.dirname(path.resolve(site.paths.webRoot))), backupDir);
		notes.push(`Local files it replaced or deleted were saved in ${shown}.`);
	}

	async _pull({ site, link, opts, transport, remote, warnings, notes = [] }) {
		if (opts.files) {
			const backupDir = this._newFileBackupDir(site);
			try {
				if (opts.selection) {
					const { transfer, remove } = opts.selection;
					this._message(site.id, `Syncing ${opts.fileList.length} selected file(s) from Bluehost`);
					if (transfer.length) await this._rsyncFiles(site, 'pull', transport, remote, { fileList: transfer, backupDir });
					const root = path.resolve(site.paths.webRoot);
					remove.forEach((p) => {
						const target = path.resolve(root, p);
						if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target)) return;
						const saved = path.join(backupDir, path.relative(root, target));
						fs.mkdirSync(path.dirname(saved), { recursive: true });
						fs.renameSync(target, saved);
					});
				} else {
					this._message(site.id, 'Downloading files from Bluehost');
					fs.mkdirSync(site.paths.webRoot, { recursive: true });
					await this._rsyncFiles(site, 'pull', transport, remote, { deleteExtraneous: opts.deleteLocal, backupDir });
				}
			} finally {
				this._finishFileBackup(site, backupDir, notes);
			}
		}

		if (opts.database) {
			// WP-CLI needs WordPress core to import; stop before touching the database rather than half-way through.
			const core = ['wp-load.php', 'wp-settings.php', path.join('wp-includes', 'version.php')];
			const missing = core.filter((f) => !fs.existsSync(path.join(site.paths.webRoot, f)));
			if (missing.length) {
				throw new Error(`WordPress core is missing from the Local site (${missing.join(', ')}), so the database was not changed. `
					+ 'Reinstall core (for example with "wp core download --skip-content" in Local\'s site shell), then pull again.');
			}
			await this._pullDatabase(site, link, transport, remote, opts, warnings);
		}
	}

	/** Runs WP-CLI against the Local site through Local's own WP-CLI service (right PHP, MySQL socket, config). */
	async _localWp(site, args) {
		const out = await this._wpCli.run(site, args);
		return String(out === null || out === undefined ? '' : (out.stdout !== undefined ? out.stdout : out)).trim();
	}

	async _pullDatabase(site, link, transport, remote, opts, warnings) {
		const cd = `cd ${q(remote.remotePath)}`;
		const WP = wpCommand(remote);
		await this._ensureLocalSiteRunning(site, 'pull');

		const { token, local: localDump } = this._tempName(site, 'pull');
		const remoteDump = `${remote.privateDir}/local-pull-${token}.sql`;
		const localBackup = path.join(site.paths.sql || path.dirname(site.paths.webRoot), LOCAL_BACKUP_NAME);
		// Local's WP-CLI service runs through the Windows shell there, so quote paths ourselves.
		const cliPath = (p) => (process.platform === 'win32' ? `"${p}"` : p);

		try {
			this._message(site.id, 'Exporting the Bluehost database');
			const state = parseKeyValues((await transport.exec(
				// Only this site's tables: another site sharing the database never ends up on this computer.
				`${cd} && umask 077 && ${tableListSnippet(WP)} && ` +
				`${WP} db export ${q(remoteDump)} ${PREFIX_TABLES_ARG} --no-tablespaces=true --single-transaction --quick --lock-tables=false >/dev/null && ` +
				'echo "table_prefix=$p" && ' +
				`echo "home=$(${WP} option get home 2>/dev/null)" && ` +
				`echo "wp_version=$(${WP} core version 2>/dev/null)"`,
			)).stdout);
			const remotePrefix = state.table_prefix || null;
			const remoteHome = state.home || (link.domain ? `//${link.domain}` : '');
			// Each side keeps its own core when the server manages it, so the database may come from a newer WordPress.
			const localVersion = await this._localWp(site, ['core', 'version']).catch(() => '');
			if (state.wp_version && localVersion && state.wp_version !== localVersion) {
				warnings.push(`Bluehost runs WordPress ${state.wp_version} and this Local site has ${localVersion}; update Local's WordPress to match.`);
			}

			this._message(site.id, 'Downloading the database');
			await transport.rsyncDown({ source: remoteDump, destination: localDump, extraArgs: ['--compress', '--times'] });
			await normalizeDumpForImport(localDump);

			const localHome = (await this._localWp(site, ['option', 'get', 'home']).catch(() => '')) || `http://${site.domain}`;

			if (opts.backupLocal) {
				this._message(site.id, 'Backing up the Local database');
				fs.mkdirSync(path.dirname(localBackup), { recursive: true });
				await this._siteDatabase.dump(site, localBackup);
			}

			this._message(site.id, 'Importing the database into Local');
			try {
				await this._localWp(site, ['db', 'reset', '--yes']);
				await this._localWp(site, ['db', 'import', cliPath(localDump)]);
			} catch (importError) {
				if (opts.backupLocal) {
					this._message(site.id, 'Import failed, restoring the previous Local database');
					try {
						await this._localWp(site, ['db', 'reset', '--yes']);
						await this._localWp(site, ['db', 'import', cliPath(localBackup)]);
					} catch (restoreError) {
						throw new Error(`Database import failed, and restoring the previous Local database also failed. The backup is at ${localBackup}. ${importError.message}`);
					}
					throw new Error(`Database import failed and the previous Local database was restored. ${importError.message}`);
				}
				throw new Error(`Database import failed. ${importError.message}`);
			}

			const localPrefix = await this._getLocalTablePrefix(site);
			if (remotePrefix && localPrefix !== remotePrefix) {
				this._message(site.id, 'Updating the Local table prefix to match Bluehost');
				await this._localWp(site, ['config', 'set', 'table_prefix', remotePrefix]);
			}

			if (!remoteHome) {
				warnings.push('Could not determine the Bluehost URL, so its URLs were not replaced.');
				return;
			}
			this._message(site.id, 'Replacing Bluehost URLs with the Local URL');
			// Other domains served from the same folder (a temporary *.mybluehost.me address, parked domains) often linger in
			// content built before the main domain went live.
			const fromBases = [remoteHome, ...(link.altDomains || []).map((d) => `//${d}`)];
			for (const [from, to] of urlReplacements(fromBases, localHome)) {
				await this._localWp(site, ['search-replace', from, to, '--all-tables', '--precise', '--skip-columns=guid', '--report-changed-only']);
			}
			await this._localWp(site, ['cache', 'flush']).catch(() => {});
		} finally {
			fs.rmSync(localDump, { force: true });
			fs.rmSync(`${localDump}.tmp`, { force: true });
			await transport.exec(`rm -f ${q(remoteDump)}`, { allowFailure: true }).catch(() => {});
		}
	}
}

module.exports = {
	SyncService,
	ShellAccessDisabledError,
	SHELL_DISABLED_RE,
	DEFAULT_OPTIONS,
	discoverRemoteScript,
	parseNested,
	parseManaged,
	findExternalLinks,
	NEWFOLD_PURGE_PHP,
	parseKeyValues,
	normalizeDumpForImport,
	urlReplacements,
	parseItemized,
	mergeComparison,
};
