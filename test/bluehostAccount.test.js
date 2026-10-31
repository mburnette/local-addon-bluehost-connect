'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	listSitesScript, parseUapiDomains, parseSiteList, installKeyScript, removeKeyScript,
} = require('../lib/main/bluehostAccount');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-account-test-'));
const posixOnly = { skip: process.platform === 'win32' };
const runSh = (script, home, bin) => execFileSync('sh', ['-c', script], {
	env: { ...process.env, HOME: home, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH },
	encoding: 'utf8',
});
const fakeBin = (scripts) => {
	const dir = tmp();
	Object.entries(scripts).forEach(([name, body]) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }));
	return dir;
};

/** The shape of `uapi --output=json DomainInfo domains_data` on cPanel. */
const uapiJson = (home) => JSON.stringify({
	apiversion: 3,
	func: 'domains_data',
	module: 'DomainInfo',
	result: {
		status: 1,
		data: {
			main_domain: { domain: 'example.com', documentroot: `${home}/public_html`, type: 'main_domain' },
			addon_domains: [{ domain: 'shop.example.org', documentroot: `${home}/public_html/shop.example.org/`, type: 'addon_domain' }],
			sub_domains: [{ domain: 'abc.xyz.mybluehost.me', documentroot: `${home}/public_html`, type: 'sub_domain' }],
			parked_domains: ['example.net'],
		},
	},
});

test('reads cPanel domains, including parked domains that share the main docroot', () => {
	assert.deepEqual(parseUapiDomains(uapiJson('/home2/exampleu')), [
		{ domain: 'example.com', documentroot: '/home2/exampleu/public_html', type: 'main' },
		{ domain: 'shop.example.org', documentroot: '/home2/exampleu/public_html/shop.example.org', type: 'addon' },
		{ domain: 'abc.xyz.mybluehost.me', documentroot: '/home2/exampleu/public_html', type: 'subdomain' },
		{ domain: 'example.net', documentroot: '/home2/exampleu/public_html', type: 'parked' },
	]);
	assert.deepEqual(parseUapiDomains('not json'), []);
});

test('lists WordPress sites with their domains, main site first, matching /home and /home2 paths', () => {
	const stdout = [
		'home=/home2/exampleu',
		'---uapi',
		uapiJson('/home/exampleu'),
		'',
		'---end',
		'wp|/home2/exampleu/public_html/shop.example.org|https://shop.example.org',
		'wp|/home2/exampleu/public_html|https://www.example.com',
		'wp|/home2/exampleu/staging|',
	].join('\n');
	assert.deepEqual(parseSiteList(stdout), [
		{
			webroot: '/home2/exampleu/public_html',
			home: 'https://www.example.com',
			label: 'www.example.com',
			path: '~/public_html',
			domains: ['example.com', 'abc.xyz.mybluehost.me', 'example.net'],
			altDomains: ['example.com', 'abc.xyz.mybluehost.me', 'example.net'],
			isMain: true,
		},
		{
			webroot: '/home2/exampleu/public_html/shop.example.org',
			home: 'https://shop.example.org',
			label: 'shop.example.org',
			path: '~/public_html/shop.example.org',
			domains: ['shop.example.org'],
			altDomains: [],
			isMain: false,
		},
		{
			webroot: '/home2/exampleu/staging',
			home: null,
			label: '~/staging',
			path: '~/staging',
			domains: [],
			altDomains: [],
			isMain: false,
		},
	]);
});

test('site listing script finds installs, reads their home URL and skips mail, caches and plugin folders', posixOnly, () => {
	const home = tmp();
	const real = fs.realpathSync(home);
	['public_html', 'public_html/blog', 'mail/x', 'public_html/wp-content/plugins/p', 'tmp/old'].forEach((d) => fs.mkdirSync(path.join(home, d), { recursive: true }));
	['public_html', 'public_html/blog', 'mail/x', 'public_html/wp-content/plugins/p', 'tmp/old'].forEach((d) => fs.writeFileSync(path.join(home, d, 'wp-load.php'), ''));
	const bin = fakeBin({
		uapi: `printf '%s' '${uapiJson(real)}'`,
		// Fake WP-CLI: prints a home URL derived from the folder it runs in.
		wp: 'echo "https://$(basename "$(pwd)").test"',
	});
	const sites = parseSiteList(runSh(listSitesScript(), home, bin));
	assert.deepEqual(sites.map((s) => [s.path, s.home, s.isMain]), [
		['~/public_html', 'https://public_html.test', true],
		['~/public_html/blog', 'https://blog.test', false],
	]);
});

test('installs the SSH key once, on its own line, with the permissions sshd needs', posixOnly, () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, '.ssh'));
	const file = path.join(home, '.ssh', 'authorized_keys');
	fs.writeFileSync(file, 'ssh-ed25519 AAAAexisting someone@laptop'); // no trailing newline
	const key = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABnew local-bluehost-connect@mac';

	runSh(installKeyScript(key), home);
	runSh(installKeyScript(key.replace('@mac', '@renamed')), home); // same key, other comment: not added twice
	assert.equal(fs.readFileSync(file, 'utf8'), `ssh-ed25519 AAAAexisting someone@laptop\n${key}\n`);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.join(home, '.ssh')).mode & 0o777, 0o700);

	runSh(removeKeyScript(key), home);
	assert.equal(fs.readFileSync(file, 'utf8'), 'ssh-ed25519 AAAAexisting someone@laptop\n');
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('creates ~/.ssh when the account has never used SSH keys', posixOnly, () => {
	const home = tmp();
	runSh(installKeyScript('ssh-rsa AAAAkey c'), home);
	assert.equal(fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'), 'ssh-rsa AAAAkey c\n');
});
