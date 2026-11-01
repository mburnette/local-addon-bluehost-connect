'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	discoverRemoteScript, parseKeyValues, parseNested, parseManaged, findExternalLinks, normalizeDumpForImport, urlReplacements, parseItemized, mergeComparison,
	SyncService, ShellAccessDisabledError,
} = require('../lib/main/SyncService');
const { SshKeyStore, fingerprint } = require('../lib/main/sshKey');
const { Store } = require('../lib/main/store');
const { shellQuote, describeSshFailure } = require('../lib/main/transport');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-connect-test-'));
const posixOnly = { skip: process.platform === 'win32' };

/** A folder of fake commands to put first on PATH: { name: 'shell script body' }. */
const fakeBin = (scripts) => {
	const dir = tmp();
	Object.entries(scripts).forEach(([name, body]) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }));
	return dir;
};
const runSh = (script, { home, bin, env = {} } = {}) => execFileSync('sh', ['-c', script], {
	env: { ...process.env, ...env, HOME: home, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH },
	encoding: 'utf8',
});

test('generated public key is valid OpenSSH and fingerprints match ssh-keygen', posixOnly, () => {
	const dir = tmp();
	const store = new SshKeyStore(path.join(dir, 'ssh'));
	const pub = store.ensure('local-test@host');
	assert.match(pub, /^ssh-rsa AAAA[0-9A-Za-z+/=]+ local-test@host$/);

	const out = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', store.publicKeyPath], { encoding: 'utf8' });
	assert.ok(out.includes(fingerprint(pub)), `ssh-keygen printed ${out}`);

	// The private key must be readable by OpenSSH and correspond to the public key.
	const derived = execFileSync('ssh-keygen', ['-y', '-f', store.privateKeyPath], { encoding: 'utf8' }).trim();
	assert.equal(derived.split(' ').slice(0, 2).join(' '), pub.split(' ').slice(0, 2).join(' '));
	assert.equal(fs.statSync(store.privateKeyPath).mode & 0o777, 0o600);

	// Idempotent: a second call keeps the same key.
	assert.equal(store.ensure('other'), pub);
});

test('discover script finds the cPanel main site and keeps dumps in a per-site private folder in $HOME', posixOnly, () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, 'public_html'));
	fs.writeFileSync(path.join(home, 'public_html', 'wp-config.php'), '<?php');
	const info = parseKeyValues(runSh(discoverRemoteScript({}), { home }));
	assert.equal(info.webroot, fs.realpathSync(path.join(home, 'public_html')));
	assert.match(info.private, new RegExp(`^${fs.realpathSync(home)}/\\.bluehost-connect/public_html-\\d+$`));
	assert.equal(fs.statSync(info.private).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.dirname(info.private)).mode & 0o777, 0o700);
	assert.ok(['wp', 'phar', 'no'].includes(info.wpcli));
	assert.ok(['yes', 'no'].includes(info.rsync));
});

test('discover script lists addon-domain sites inside the webroot so transfers can exclude them', posixOnly, () => {
	const home = tmp();
	const web = path.join(home, 'public_html');
	fs.mkdirSync(path.join(web, 'shop.example.com'), { recursive: true });
	fs.mkdirSync(path.join(web, 'website_8a3f', 'blog'), { recursive: true });
	fs.mkdirSync(path.join(web, 'static-site'), { recursive: true });
	fs.mkdirSync(path.join(web, 'wp-content', 'plugins', 'bundled'), { recursive: true });
	fs.writeFileSync(path.join(web, 'wp-config.php'), '<?php');
	fs.writeFileSync(path.join(web, 'shop.example.com', 'wp-load.php'), '<?php');
	fs.writeFileSync(path.join(web, 'website_8a3f', 'wp-load.php'), '<?php');
	fs.writeFileSync(path.join(web, 'website_8a3f', 'blog', 'wp-load.php'), '<?php');
	// A plugin shipping its own WordPress copy is not a site.
	fs.writeFileSync(path.join(web, 'wp-content', 'plugins', 'bundled', 'wp-load.php'), '<?php');
	// cPanel also knows a non-WordPress addon domain served from inside public_html.
	const bin = fakeBin({
		uapi: `printf '%s\\n' '---' 'result:' '  data:' '    main_domain:' '      documentroot: ${web}' '    addon_domains:' '      -' '        documentroot: ${web}/static-site' '        domain: static.example.com' '      -' '        documentroot: ${home}/other.example.com'`,
	});
	const out = runSh(discoverRemoteScript({}), { home, bin });
	assert.deepEqual(parseNested(out), ['shop.example.com', 'static-site', 'website_8a3f']);
});

test('discover script uses an explicit remote path as is, never falling back to another site', posixOnly, () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, 'public_html'));
	fs.writeFileSync(path.join(home, 'public_html', 'wp-config.php'), '<?php');
	const custom = path.join(home, "my 'site'", 'web');
	fs.mkdirSync(custom, { recursive: true });
	fs.writeFileSync(path.join(custom, 'wp-load.php'), '<?php');
	assert.equal(parseKeyValues(runSh(discoverRemoteScript({ remotePath: custom }), { home })).webroot, fs.realpathSync(custom));
	assert.throws(
		() => runSh(discoverRemoteScript({ remotePath: path.join(home, 'gone') }), { home }),
		(e) => e.status === 3,
	);
});

test('discover script exits 3 when no WordPress is found', posixOnly, () => {
	const home = tmp();
	assert.throws(
		() => execFileSync('sh', ['-c', discoverRemoteScript({})], { env: { ...process.env, HOME: home }, stdio: 'pipe' }),
		(e) => e.status === 3 && /home=/.test(e.stdout.toString()),
	);
});

test('never picks the webroot itself, or a folder inside it, for dumps', posixOnly, () => {
	// Like a WP Cloud SSH user whose home is the webroot.
	const parent = tmp();
	const home = path.join(parent, 'htdocs');
	fs.mkdirSync(home);
	fs.writeFileSync(path.join(home, 'wp-config.php'), '<?php');
	const info = parseKeyValues(runSh(discoverRemoteScript({}), { home }));
	assert.equal(info.webroot, fs.realpathSync(home));
	assert.ok(info.private && !info.private.startsWith(`${info.webroot}/`) && info.private !== info.webroot);
	assert.match(info.private, new RegExp(`^${fs.realpathSync(parent)}/\\.bluehost-connect/site-\\d+$`));
});

test('every site of a cPanel account gets its own private folder, so one push never overwrites another site\'s backup', posixOnly, () => {
	const home = tmp();
	const sites = ['public_html', 'public_html/shop.example.com', 'other.example.com', 'public_html/x_y', 'public_html/x/y'];
	sites.forEach((s) => {
		fs.mkdirSync(path.join(home, s), { recursive: true });
		fs.writeFileSync(path.join(home, s, 'wp-config.php'), '<?php');
	});
	const privates = sites.map((s) => parseKeyValues(runSh(discoverRemoteScript({ remotePath: path.join(home, s) }), { home })).private);
	assert.equal(new Set(privates).size, sites.length, privates.join('\n'));
	privates.forEach((p) => assert.equal(path.dirname(p), path.join(fs.realpathSync(home), '.bluehost-connect')));
	assert.match(path.basename(privates[1]), /^public_html_shop\.example\.com-\d+$/);
	assert.match(path.basename(privates[2]), /^other\.example\.com-\d+$/);
	// Turning "/" into "_" alone would give "x_y" and "x/y" the same folder; the checksum keeps them apart.
	assert.notEqual(privates[3], privates[4]);
	// The same site always gets the same folder.
	assert.equal(parseKeyValues(runSh(discoverRemoteScript({ remotePath: path.join(home, sites[1]) }), { home })).private, privates[1]);
});

test('never writes into a site\'s public_html for a WordPress installed in a subfolder or an addon domain inside it', posixOnly, () => {
	const root = tmp();
	const web = path.join(root, 'public_html');
	const sub = path.join(web, 'shop.example.com');
	const deep = path.join(web, 'apps', 'store');
	[sub, deep].forEach((d) => {
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'wp-config.php'), '<?php');
	});
	// A home folder that can't take the private folder: the next candidate, the folder above the webroot, is (or is
	// inside) the main site's public folder, which serves anything put there; TMPDIR is used instead.
	const lockedHome = path.join(tmp(), 'locked');
	fs.mkdirSync(lockedHome, { mode: 0o500 });
	const tmpDir = tmp();
	const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
	try {
		[sub, deep].forEach((d) => {
			const info = parseKeyValues(runSh(discoverRemoteScript({ remotePath: d }), { home: lockedHome, env: { TMPDIR: tmpDir } }));
			assert.equal(info.webroot, fs.realpathSync(d));
			assert.match(info.private, new RegExp(`^${fs.realpathSync(tmpDir)}/\\.bluehost-connect-${uid}/site-\\d+$`));
		});
	} finally {
		fs.chmodSync(lockedHome, 0o700);
	}
	assert.ok(!fs.existsSync(path.join(web, '.bluehost-connect')));
	assert.ok(!fs.existsSync(path.join(web, 'apps', '.bluehost-connect')));
});

test('finds symlinks that point outside the site, and broken ones, but not links within it', posixOnly, () => {
	const root = tmp();
	const web = path.join(root, 'public');
	fs.mkdirSync(path.join(web, 'wp-content', 'themes'), { recursive: true });
	fs.mkdirSync(path.join(web, 'wp-content', 'uploads', '2026'), { recursive: true });
	fs.mkdirSync(path.join(root, 'dev', 'theme'), { recursive: true });
	fs.symlinkSync(path.join(root, 'dev', 'theme'), path.join(web, 'wp-content', 'themes', 'mine'));
	fs.symlinkSync('../../dev/theme', path.join(web, 'wp-content', 'relative-out'));
	fs.symlinkSync('2026', path.join(web, 'wp-content', 'uploads', 'latest'));
	fs.symlinkSync(path.join(root, 'nope'), path.join(web, 'wp-content', 'themes', 'gone'));
	const links = findExternalLinks(web);
	assert.deepEqual(links.external.sort(), ['wp-content/relative-out', 'wp-content/themes/mine']);
	assert.deepEqual(links.broken, ['wp-content/themes/gone']);
	assert.deepEqual(findExternalLinks(path.join(root, 'missing')), { external: [], broken: [] });
});

test('discover script reports links that resolve outside the site as platform-managed', posixOnly, () => {
	const root = tmp();
	const web = path.join(root, 'htdocs');
	fs.mkdirSync(path.join(root, 'wordpress', 'core', 'latest'), { recursive: true });
	fs.mkdirSync(path.join(web, 'wp-content', 'plugins', 'mine'), { recursive: true });
	fs.mkdirSync(path.join(web, 'wp-content', 'uploads', '2026'), { recursive: true });
	fs.writeFileSync(path.join(root, 'wordpress', 'core', 'latest', 'wp-load.php'), '<?php');
	fs.symlinkSync('../wordpress/core/latest', path.join(web, '__wp__'));
	fs.symlinkSync('__wp__/wp-load.php', path.join(web, 'wp-load.php'));
	fs.symlinkSync('2026', path.join(web, 'wp-content', 'uploads', 'latest'));
	fs.writeFileSync(path.join(web, 'wp-config.php'), '<?php');
	const out = runSh(discoverRemoteScript({ remotePath: web }), { home: root });
	assert.deepEqual(parseManaged(out), ['__wp__', 'wp-load.php']);
});

test('uses the WP-CLI build the add-on downloaded when the server has no wp command', async () => {
	const service = new SyncService({ services: {}, logger: {} });
	const transport = { exec: async () => ({ code: 0, stdout: 'webroot=/home/u/public_html\nprivate=/home/u/.bluehost-connect\nwpcli=phar\nphp=yes\nrsync=yes\n', stderr: '' }) };
	const remote = await service.discoverRemote(transport, {});
	assert.equal(remote.wp, "php '/home/u/.bluehost-connect/wp-cli.phar'");
	assert.equal(remote.hasWpCli, true);
	assert.deepEqual(remote.nested, []);
});

test('rsync sends remote paths through the protocol, so a folder with a space is not split by the server\'s shell', async () => {
	const { Transport } = require('../lib/main/transport');
	const transport = new Transport({ host: 'box1234.bluehost.com', username: 'exampleu', privateKeyPath: '/k', workDir: tmp(), logger: {} });
	const runs = [];
	transport._bin = () => '/fake/rsync-3.1.3';
	transport._spawn = async (cmd, args) => {
		if (args[0] === '--version') return { code: 0, stdout: 'rsync  version 3.1.3  protocol version 31\n', stderr: '' };
		runs.push(args);
		return { code: 0, stdout: '', stderr: '' };
	};
	await transport.rsyncUp({ source: '/local/', destination: '/home2/exampleu/public_html/old site/', extraArgs: ['--delete'] });
	await transport.rsyncDown({ source: '/home2/exampleu/public_html/old site/', destination: '/local/' });
	runs.forEach((args) => assert.ok(args.includes('--protect-args'), args.join(' ')));
	assert.equal(runs[0][runs[0].length - 1], 'exampleu@box1234.bluehost.com:/home2/exampleu/public_html/old site/');
});

test('an rsync without --protect-args (macOS openrsync) is asked once, and refuses remote paths the shell could split', async () => {
	const { Transport } = require('../lib/main/transport');
	const transport = new Transport({ host: 'box1234.bluehost.com', username: 'exampleu', privateKeyPath: '/k', workDir: tmp(), logger: {} });
	transport._bin = () => '/fake/openrsync';
	const runs = [];
	transport._spawn = async (cmd, args) => {
		runs.push(args);
		if (args[0] === '--version') return { code: 0, stdout: 'openrsync: protocol version 29\nrsync version 2.6.9 compatible\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	};
	await transport.rsyncUp({ source: '/local/', destination: '/home2/exampleu/public_html/', extraArgs: ['--delete'] });
	await transport.rsyncDown({ source: '/home2/exampleu/public_html/', destination: '/local/' });
	await assert.rejects(transport.rsyncUp({ source: '/local/', destination: '/home2/exampleu/public_html/old site/' }), /too old/);
	assert.equal(runs.filter((a) => a[0] === '--version').length, 1);
	runs.filter((a) => a[0] !== '--version').forEach((args) => assert.ok(!args.includes('--protect-args'), args.join(' ')));
	assert.equal(runs.length, 3);
});

test('shellQuote survives a round trip through sh', posixOnly, () => {
	const nasty = `it's "quoted" $HOME \`date\` ; echo nope`;
	assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(nasty)}`], { encoding: 'utf8' }), nasty);
});

test('normalizes dumps in both directions: MySQL 8 -> MariaDB and MariaDB 11 -> MySQL', async () => {
	const file = path.join(tmp(), 'dump.sql');
	fs.writeFileSync(file, [
		'/*M!999999\\- enable the sandbox mode */ ',
		'CREATE TABLE `wp_posts` (x int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
		'CREATE TABLE `wp_terms` (x int) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;',
		"INSERT INTO `wp_options` VALUES (1,'blogname','Hi','yes');",
		'`c` varchar(1) COLLATE utf8mb4_0900_as_cs NOT NULL,',
		'`d` varchar(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_uca1400_ai_ci NOT NULL',
	].join('\n'));
	await normalizeDumpForImport(file);
	const out = fs.readFileSync(file, 'utf8');
	assert.ok(!out.includes('sandbox mode'), 'MariaDB sandbox line breaks the MySQL client');
	assert.ok(!/0900|uca1400/.test(out));
	assert.equal((out.match(/utf8mb4_unicode_520_ci/g) || []).length, 3);
	assert.ok(out.includes('utf8mb3_unicode_ci'));
	assert.ok(out.startsWith('CREATE TABLE `wp_posts`'));
	assert.ok(out.includes("'blogname','Hi'"));
});

test('url replacements for push (Local -> https Bluehost)', () => {
	assert.deepEqual(urlReplacements(['//shop.local'], 'https://shop.example.com/'), [
		['//shop.local', '//shop.example.com'],
		['\\/\\/shop.local', '\\/\\/shop.example.com'],
		['http://shop.example.com', 'https://shop.example.com'],
	]);
});

test('url replacements for pull (Bluehost + temporary domain -> http Local)', () => {
	assert.deepEqual(urlReplacements(['https://shop.example.com', '//abc.xyz.mybluehost.me'], 'http://shop.local'), [
		['//shop.example.com', '//shop.local'],
		['\\/\\/shop.example.com', '\\/\\/shop.local'],
		['//abc.xyz.mybluehost.me', '//shop.local'],
		['\\/\\/abc.xyz.mybluehost.me', '\\/\\/shop.local'],
		['https://shop.local', 'http://shop.local'],
	]);
});

test('url replacements skip a source that already equals the destination', () => {
	assert.deepEqual(urlReplacements(['https://shop.local'], 'https://shop.local'), [['http://shop.local', 'https://shop.local']]);
});

test('store encrypts secrets and never exposes them to the renderer', () => {
	const dir = tmp();
	const fakeSafeStorage = {
		isEncryptionAvailable: () => true,
		encryptString: (s) => Buffer.from([...s].reverse().join('')),
		decryptString: (b) => [...b.toString()].reverse().join(''),
	};
	const store = new Store(dir, fakeSafeStorage);
	store.setAccount({ host: 'example.com', port: 22, username: 'exampleu', authType: 'password', password: 'account-secret' });
	store.setLink('site1', { mode: 'manual', host: 'h', username: 'u', password: 'pw' });

	const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
	assert.ok(!raw.includes('account-secret'));
	assert.ok(!raw.includes('"pw"'));

	const reopened = new Store(dir, fakeSafeStorage);
	assert.equal(reopened.getAccount().password, 'account-secret');
	assert.equal(reopened.getLink('site1').password, 'pw');
	assert.deepEqual(reopened.getPublicAccount(), { host: 'example.com', port: 22, username: 'exampleu', authType: 'password', hasPassword: true });
	const pub = reopened.getPublicLink('site1');
	assert.equal(pub.password, undefined);
	assert.equal(pub.hasPassword, true);
});

test('parses rsync itemized dry-run output, including odd file names', () => {
	const out = [
		'BH|*deleting  |0|1969/12/31-19:00:00|gone/f.txt',
		'BH|*deleting  |0|1969/12/31-19:00:00|gone/',
		'BH|<f.st......|14|2026/10/30-16:27:38|changed.txt',
		'BH|cL+++++++++|8|2026/10/30-16:27:38|link',
		'BH|<f+++++++++|4|2026/10/30-16:27:38|pipe|name.txt',
		'BH|cd+++++++++|0|2026/10/30-16:27:38|newdir/',
		'BH|.f...p.....|9|2026/10/30-16:27:38|perm-only.txt',
		'sending incremental file list',
	].join('\n');
	const items = parseItemized(out);
	assert.deepEqual(items.map((i) => [i.op, i.type, i.path]), [
		['delete', 'file', 'gone/f.txt'],
		['update', 'file', 'changed.txt'],
		['create', 'symlink', 'link'],
		['create', 'file', 'pipe|name.txt'],
	]);
	assert.equal(items[1].size, 14);
	assert.equal(items[1].mtime, Math.round(new Date(2026, 9, 30, 16, 27, 38).getTime() / 1000));
});

test('merges both dry runs into one comparison with sides and the newer copy', () => {
	const pushItems = [
		{ op: 'update', type: 'file', size: 10, mtime: 200, path: 'a.php' },
		{ op: 'update', type: 'file', size: 10, mtime: 100, path: 'b.php' },
		{ op: 'create', type: 'file', size: 5, mtime: 50, path: 'local.txt' },
		{ op: 'delete', type: 'file', size: null, mtime: null, path: 'remote.txt' },
	];
	const pullItems = [
		{ op: 'update', type: 'file', size: 12, mtime: 100, path: 'a.php' },
		{ op: 'update', type: 'file', size: 12, mtime: 300, path: 'b.php' },
		{ op: 'create', type: 'file', size: 7, mtime: 70, path: 'remote.txt' },
		{ op: 'delete', type: 'file', size: null, mtime: null, path: 'local.txt' },
	];
	const merged = mergeComparison(pushItems, pullItems);
	assert.deepEqual(merged.map((e) => [e.path, e.status, e.newer]), [
		['a.php', 'changed', 'local'],
		['b.php', 'changed', 'remote'],
		['local.txt', 'local-only', null],
		['remote.txt', 'remote-only', null],
	]);
	assert.deepEqual(merged[0].local, { size: 10, mtime: 200 });
	assert.deepEqual(merged[0].remote, { size: 12, mtime: 100 });
	assert.deepEqual(merged[2].local, { size: 5, mtime: 50 });
	assert.equal(merged[2].remote, null);
	assert.deepEqual(merged[3].remote, { size: 7, mtime: 70 });
});

test('recognizes a cPanel account without shell access instead of reporting a missing WordPress', async () => {
	const service = new SyncService({ services: {}, logger: {} });
	const transport = { exec: async () => ({ code: 1, stdout: 'Shell access is not enabled on your account!\n', stderr: '' }) };
	await assert.rejects(service.discoverRemote(transport, {}), (e) => e instanceof ShellAccessDisabledError && /turn on Shell Access/.test(e.message));
});

test('only real SSH login failures are reported as a refused key', () => {
	const t = { username: 'u', host: 'h', port: 22, password: null, knownHostsPath: '/k' };
	assert.match(describeSshFailure(255, 'u@h: Permission denied (publickey,password).', t), /refused the SSH key/);
	const remote = "mysqldump: Can't create/write to file '/home/u/.bluehost-connect/local-backup-before-push.sql' (Errcode: 13 \"Permission denied\")";
	const msg = describeSshFailure(1, remote, t);
	assert.doesNotMatch(msg, /refused the SSH key/);
	assert.match(msg, /A command failed on the Bluehost server \(exit 1\).*Can't create\/write/);
});

const WEBROOT = '/home2/exampleu/public_html/shop.example.com';
const PRIVATE = '/home2/exampleu/.bluehost-connect/public_html_shop.example.com-123';
const WP = 'wp --skip-plugins --skip-themes';

/** Records every ssh command and rsync call; `respond(command)` gives a command's stdout. */
function fakeTransport({ respond = () => '' } = {}) {
	const calls = [];
	return {
		calls,
		execs: () => calls.filter(([kind]) => kind === 'exec').map(([, c]) => c),
		async exec(command) {
			calls.push(['exec', command]);
			if (command.startsWith('for d in ')) {
				return { code: 0, stdout: `webroot=${WEBROOT}\nprivate=${PRIVATE}\nwpcli=wp\nphp=yes\nrsync=yes\n`, stderr: '' };
			}
			return { code: 0, stdout: respond(command) || '', stderr: '' };
		},
		async rsyncUp(args) {
			calls.push(['up', args]);
			return '';
		},
		async rsyncDown(args) {
			calls.push(['down', args]);
			if (!args.source.endsWith('/')) fs.writeFileSync(args.destination, 'CREATE TABLE `wp_options` (x int);\n');
			return '';
		},
		async close() {},
	};
}

/** A SyncService wired to stand-ins for Local's services and a stored link. */
function makeService({ transport, localPrefix = 'wp_' }) {
	const webRoot = path.join(tmp(), 'app', 'public');
	fs.mkdirSync(path.join(webRoot, 'wp-includes'), { recursive: true });
	['wp-load.php', 'wp-settings.php', 'wp-includes/version.php'].forEach((f) => fs.writeFileSync(path.join(webRoot, f), '<?php'));
	const site = { id: 'site1', name: 'Shop', domain: 'shop.local', paths: { webRoot, sql: path.join(webRoot, '..', 'sql') } };
	let stored = { host: 'box1234.bluehost.com', port: 22, username: 'exampleu', authType: 'key', domain: 'shop.example.com', remotePath: WEBROOT };
	const service = new SyncService({
		store: { getLink: () => stored, updateLink: (id, patch) => { stored = { ...stored, ...patch }; } },
		keys: { privateKeyPath: '/nonexistent/key' },
		workDir: tmp(),
		services: {
			siteData: { getSite: () => site },
			siteDatabase: {
				dump: async (_site, dest) => fs.writeFileSync(dest, 'CREATE TABLE `wp_options` (x int);\n'),
				getTablePrefix: async () => localPrefix,
			},
			siteProcessManager: { getSiteStatus: () => 'running', start: async () => {} },
			wpCli: { run: async (_site, args) => (args.join(' ') === 'option get home' ? 'http://shop.local\n' : '') },
		},
		sendIPCEvent: () => {},
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	service.transportFor = () => transport;
	return service;
}

test('a database push on its own database still resets it and keeps the backup in the site\'s private folder', async () => {
	const transport = fakeTransport({ respond: (c) => (/db export/.test(c) ? 'table_prefix=wp_\ntables=wp_options wp_posts \nhome=https://shop.example.com\n' : '') });
	await makeService({ transport }).push('site1', { files: false, purgeCache: false });
	const execs = transport.execs();
	const exportCmd = execs.find((c) => /db export/.test(c));
	assert.ok(exportCmd.includes(`${WP} db export '${PRIVATE}/local-backup-before-push.sql' \${o:+--tables="$o"}`), exportCmd);
	assert.ok(execs.some((c) => c.includes(`${WP} db reset --yes && ${WP} db import '${PRIVATE}/local-push-`)));
	assert.ok(execs.filter((c) => /search-replace/.test(c)).every((c) => c.includes(' --all-tables ')));
});

test('the push backup and the pull export hold only the site\'s own tables (run with sh and a stand-in wp)', posixOnly, async () => {
	const bin = fakeBin({
		wp: `case "$*" in *"config get table_prefix"*) echo shop_;; *"db query SHOW TABLES"*) printf 'wp_options\\nshop_options\\nshop_posts\\n';; *"db export"*) echo "$*" > "$OUT";; esac`,
	});
	const out = path.join(tmp(), 'export-args');
	for (const direction of ['push', 'pull']) {
		const transport = fakeTransport();
		await makeService({ transport })[direction]('site1', { files: false, purgeCache: false }).catch(() => {});
		// The real command, run in a scratch folder with the stand-in wp.
		const exportCmd = transport.execs().find((c) => /db export/.test(c)).replace(`cd '${WEBROOT}'`, 'cd /');
		const state = parseKeyValues(runSh(exportCmd, { home: tmp(), bin, env: { OUT: out } }));
		assert.equal(state.table_prefix, 'shop_');
		assert.match(fs.readFileSync(out, 'utf8'), / --tables=shop_options,shop_posts --no-tablespaces=true/);
		if (direction === 'push') assert.equal(state.tables, 'wp_options shop_options shop_posts');
	}
});

test('a database shared with another site: push replaces only its own tables, and never writes over the other site\'s', async () => {
	const state = (prefix) => `table_prefix=${prefix}\ntables=wp_options wp_posts shop_options shop_posts \nhome=https://shop.example.com\n`;
	const run = async (remotePrefix, localPrefix) => {
		const transport = fakeTransport({ respond: (c) => (/db export/.test(c) ? state(remotePrefix) : '') });
		const result = await makeService({ transport, localPrefix }).push('site1', { files: false, purgeCache: false }).then(() => null, (e) => e);
		return { error: result, execs: transport.execs(), uploads: transport.calls.filter(([kind]) => kind === 'up') };
	};

	// Same prefix as the remote site: its own tables are dropped instead of the whole database.
	const same = await run('shop_', 'shop_');
	assert.equal(same.error, null);
	const importCmd = same.execs.find((c) => /db import/.test(c));
	assert.ok(importCmd.includes(`db query 'DROP TABLE IF EXISTS \`shop_options\`, \`shop_posts\`' && ${WP} db import`), importCmd);
	assert.ok(!same.execs.some((c) => /db reset/.test(c)), 'the other site\'s tables are never dropped');
	assert.ok(same.execs.filter((c) => /search-replace/.test(c)).every((c) => c.includes('--all-tables-with-prefix')));

	// Local's wp_ tables would overwrite the main site's: nothing is uploaded or changed.
	const clash = await run('shop_', 'wp_');
	assert.match(clash.error.message, /also holds tables of another site \(wp_options, wp_posts\).*prefix \(wp_\) would overwrite wp_options, wp_posts.*Change the Local site's table prefix to shop_/);
	assert.equal(clash.uploads.length, 0);
	assert.ok(!clash.execs.some((c) => /db import|db reset|DROP TABLE/.test(c)));

	// Without the Local prefix there's no telling what the import would overwrite.
	const unknown = await run('shop_', null);
	assert.match(unknown.error.message, /the Local table prefix could not be read/);
	assert.equal(unknown.uploads.length, 0);
});

test('a failed import into a shared database restores only the site\'s own tables', async () => {
	const transport = fakeTransport({ respond: (c) => (/db export/.test(c) ? 'table_prefix=shop_\ntables=wp_options shop_options \nhome=https://shop.example.com\n' : '') });
	const exec = transport.exec.bind(transport);
	transport.exec = async (command, opts) => {
		if (/local-push-/.test(command) && /db import/.test(command)) {
			transport.calls.push(['exec', command]);
			throw new Error('import broke');
		}
		return exec(command, opts);
	};
	const service = makeService({ transport, localPrefix: 'shop_' });
	await assert.rejects(service.push('site1', { files: false, purgeCache: false }), /previous database was restored/);
	const restore = transport.execs().find((c) => c.includes('local-backup-before-push.sql') && /db import/.test(c));
	assert.equal(restore, `cd '${WEBROOT}' && ${WP} db import '${PRIVATE}/local-backup-before-push.sql'`);
});
