'use strict';

/**
 * Loads the add-on's main entry with Local's main-process API mocked, then drives its IPC handlers. SSH is
 * stubbed at SyncService.transportFor (a fake transport that answers each remote command) and at
 * SyncService.discoverRemote / pull.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IPC } = require('../lib/constants');
const { SyncService } = require('../lib/main/SyncService');

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-main-test-'));
test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));

const calls = [];
const handlers = {};
const existingSites = {
	a1: { id: 'a1', name: 'Shop Copy', domain: 'shop-copy.local', path: '~/Local Sites/shop-copy' },
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const cradle = {
	localLogger: { child: () => logger },
	siteData: { getSites: () => existingSites, getSite: (id) => existingSites[id] },
	siteDatabase: {},
	siteProcessManager: {},
	wpCli: {},
	addSite: {
		addSite: async (args) => {
			calls.push(['addSite', args]);
			const site = { id: 'new1', name: args.newSiteInfo.siteName, domain: args.newSiteInfo.siteDomain };
			existingSites.new1 = site;
			return site;
		},
	},
};
const localMain = {
	getServiceContainer: () => ({ cradle }),
	addIpcAsyncListener: (channel, fn) => { handlers[channel] = fn; },
	sendIPCEvent: (...args) => calls.push(['ipc', ...args]),
	UserData: { get: () => ({}) },
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (request === '@getflywheel/local/main') return localMain;
	return originalLoad.call(this, request, ...rest);
};

const REMOTE = { remotePath: '/home2/exampleu/public_html', privateDir: '/home2/exampleu/.bluehost-connect', wp: 'wp', hasWpCli: true, hasRsync: true, hasPhp: true, nested: ['shop.example.org'] };
const SITE_LIST = [
	'home=/home2/exampleu',
	'wp|/home2/exampleu/public_html|https://www.example.com',
	'wp|/home2/exampleu/public_html/shop.example.org|https://shop.example.org',
].join('\n');

/** How the fake server answers: (link, command) -> { code, stdout, stderr }. */
let serverBehaviour;
const defaultServer = (link, command) => {
	if (command.startsWith('echo bluehost-connect-ok')) return { code: 0, stdout: 'bluehost-connect-ok\n', stderr: '' };
	if (command.includes('wp-load.php')) return { code: 0, stdout: SITE_LIST, stderr: '' };
	return { code: 0, stdout: '', stderr: '' };
};
serverBehaviour = defaultServer;

SyncService.prototype.transportFor = function transportFor(link) {
	return {
		username: link.username,
		host: link.host,
		port: link.port,
		password: link.password,
		exec: async (command, { allowFailure } = {}) => {
			calls.push(['exec', link.authType, command]);
			const res = serverBehaviour(link, command);
			if (res.code !== 0 && !allowFailure) throw new Error(res.stderr || `exit ${res.code}`);
			return res;
		},
	};
};
let discoverBehaviour = async () => REMOTE;
SyncService.prototype.discoverRemote = function discoverRemote(transport, hints) {
	calls.push(['discover', transport.username, transport.host, hints]);
	return discoverBehaviour(transport, hints);
};
SyncService.prototype.pull = async function pull(siteId, options) {
	calls.push(['pull', siteId, options]);
	return { ok: true };
};

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (v) => Buffer.from(v),
	decryptString: (b) => b.toString(),
};
const addonMain = require('../lib/main');
addonMain({ electron: { safeStorage: fakeSafeStorage }, environment: { userDataPath } });

const waitFor = async (predicate, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timed out');
};
const names = () => calls.map((c) => c[0]);
const execs = () => calls.filter((c) => c[0] === 'exec');
const reset = () => {
	calls.length = 0;
	serverBehaviour = defaultServer;
	discoverBehaviour = async () => REMOTE;
};

test('suggests a non-clashing domain and folder from Local defaults', () => {
	assert.deepEqual(handlers[IPC.NEW_SITE_LOCATION]('Shop Copy!'), { domain: 'shop-copy-2.local', sitePath: path.join('~/Local Sites/', 'shop-copy-2') });
	assert.equal(handlers[IPC.NEW_SITE_LOCATION]('Brand New').domain, 'brand-new.local');
});

test('connecting with a password installs Local\'s key, then forgets the password', async () => {
	reset();
	const state = await handlers[IPC.CONNECT_ACCOUNT]({
		host: 'https://example.com/', port: '22', username: ' exampleu ', authType: 'password', password: 'hunter2', installKey: true, progressId: 'p1',
	});
	assert.deepEqual(execs().map((c) => [c[1], c[2].slice(0, 30)]), [
		['password', 'echo bluehost-connect-ok'],
		['password', 'umask 077; mkdir -p "$HOME/.ss'],
		['key', 'echo bluehost-connect-ok'],
	]);
	assert.match(execs()[1][2], /ssh-rsa AAAA/);
	assert.deepEqual(state.account, { host: 'example.com', port: 22, username: 'exampleu', authType: 'key', hasPassword: false });
	const raw = fs.readFileSync(path.join(userDataPath, 'bluehost-connect', 'settings.json'), 'utf8');
	assert.ok(!raw.includes('hunter2'), 'the password is not stored once the key works');

	const progress = calls.filter((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS);
	assert.deepEqual(progress.map((c) => c[3]), ['Connecting over SSH…', 'Adding Local\'s SSH key to your account…']);
	assert.ok(progress.every((c) => c[2] === 'p1'), 'progress goes to the requesting form only');
});

test('keeps the password when the key login does not work', async () => {
	reset();
	serverBehaviour = (link, command) => (link.authType === 'key'
		? { code: 255, stdout: '', stderr: 'Permission denied (publickey).' }
		: defaultServer(link, command));
	const state = await handlers[IPC.CONNECT_ACCOUNT]({ host: 'example.com', username: 'exampleu', authType: 'password', password: 'hunter2', installKey: true });
	assert.equal(state.account.authType, 'password');
	assert.equal(state.account.hasPassword, true);
	assert.ok(!JSON.stringify(state).includes('hunter2'), 'the password never reaches the renderer');
});

test('reports a disabled shell before storing anything', async () => {
	await handlers[IPC.DISCONNECT_ACCOUNT]({});
	reset();
	serverBehaviour = () => ({ code: 1, stdout: 'Shell access is not enabled on your account!\n', stderr: '' });
	await assert.rejects(
		handlers[IPC.CONNECT_ACCOUNT]({ host: 'example.com', username: 'exampleu', authType: 'key' }),
		/Shell Access/,
	);
	assert.equal((await handlers[IPC.GET_STATE]()).account, null);
});

test('lists the account\'s WordPress sites and links one, excluding sites nested inside it', async () => {
	reset();
	await handlers[IPC.CONNECT_ACCOUNT]({ host: 'example.com', username: 'exampleu', authType: 'key' });
	const sites = await handlers[IPC.LIST_SITES]();
	assert.deepEqual(sites.map((s) => s.label), ['www.example.com', 'shop.example.org']);

	calls.length = 0;
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a1', ...sites[0], altDomains: ['abc.xyz.mybluehost.me', 'bad host; rm -rf /'], progressId: 'p2' });
	assert.deepEqual(calls.find((c) => c[0] === 'discover').slice(1), ['exampleu', 'example.com', { remotePath: '/home2/exampleu/public_html' }]);
	assert.equal(state.link.mode, 'account');
	assert.equal(state.link.label, 'www.example.com');
	assert.equal(state.link.domain, 'www.example.com');
	assert.deepEqual(state.link.altDomains, ['abc.xyz.mybluehost.me']);
	assert.deepEqual(state.link.nested, ['shop.example.org']);
});

test('installs WP-CLI while linking when the server has none', async () => {
	reset();
	discoverBehaviour = async () => ({ ...REMOTE, wp: null, hasWpCli: false });
	const original = SyncService.prototype.ensureWpCli;
	SyncService.prototype.ensureWpCli = async (transport, remote) => {
		calls.push(['ensureWpCli']);
		return { ...remote, wp: 'php wp-cli.phar', hasWpCli: true };
	};
	try {
		await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a1', webroot: '/home2/exampleu/public_html', label: 'www.example.com' });
		assert.ok(names().includes('ensureWpCli'));
	} finally {
		SyncService.prototype.ensureWpCli = original;
	}
});

test('disconnecting keeps the SSH key on the account while a linked site still uses it', async () => {
	reset();
	const res = await handlers[IPC.DISCONNECT_ACCOUNT]({ removeKey: true });
	assert.match(res.notice, /linked sites still use it/);
	assert.equal(res.account, null);
	assert.ok(!execs().length, 'nothing ran on the server');
});

test('pull to new site verifies the connection, creates the site, links it, then pulls', async () => {
	reset();
	const res = await handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Shop Copy',
		source: { kind: 'manual', host: 'ssh.atomicsites.net', port: '22', username: 'globaluser-10904919', authType: 'key', remotePath: '', domain: 'shop.example.com' },
	});
	assert.equal(res.domain, 'shop-copy-2.local');
	assert.equal(names()[0], 'discover', 'connection is checked before anything is created');

	await waitFor(() => names().includes('pull'));
	const addSite = calls.find((c) => c[0] === 'addSite')[1];
	assert.deepEqual(addSite.newSiteInfo, {
		siteName: 'Shop Copy',
		siteDomain: 'shop-copy-2.local',
		sitePath: path.join('~/Local Sites/', 'shop-copy-2'),
		environment: 'flywheel',
		multiSite: '',
	});
	assert.equal(addSite.installWP, true);
	assert.equal(addSite.goToSite, true);
	assert.equal(addSite.wpCredentials.adminUsername, 'admin');
	assert.ok(addSite.wpCredentials.adminPassword.length >= 16);

	assert.deepEqual(calls.find((c) => c[0] === 'pull').slice(1), ['new1', { deleteLocal: true, backupLocal: false }]);
	assert.ok(names().indexOf('addSite') < names().indexOf('pull'));

	const state = await handlers[IPC.GET_STATE]('new1');
	assert.equal(state.link.host, 'ssh.atomicsites.net');
	assert.equal(state.link.label, 'shop.example.com');
	assert.equal(state.link.remotePath, '/home2/exampleu/public_html');
});

test('pull to new site creates nothing when the connection fails', async () => {
	reset();
	discoverBehaviour = async () => { throw new Error('Bluehost refused the password'); };
	await assert.rejects(handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Broken',
		source: { kind: 'manual', host: 'h.example.com', username: 'u', authType: 'password', password: 'nope' },
	}), /refused the password/);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!names().includes('addSite'));
});
