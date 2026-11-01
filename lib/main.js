'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalMain = require('@getflywheel/local/main');

const { IPC, BLUEHOST_CLOUD_SSH_HOST } = require('./constants');
const { listSitesScript, parseSiteList, installKeyScript, removeKeyScript, hostOf } = require('./main/bluehostAccount');
const { SyncService, ShellAccessDisabledError, SHELL_DISABLED_RE } = require('./main/SyncService');
const { SshKeyStore } = require('./main/sshKey');
const { Store } = require('./main/store');
const { findBundledBinDir, describeSshFailure, TransportError } = require('./main/transport');
const { Updater } = require('./main/updater');
const pkg = require('../package.json');

const PROBE_MARKER = 'bluehost-connect-ok';
const HOSTNAME_RE = /^[a-z0-9.-]+$/i;

function randomString(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
	const bytes = crypto.randomBytes(length);
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** "https://example.com/path" or "user@example.com" -> "example.com". */
const cleanHost = (host) => String(host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/^[^@]*@/, '').split(/[/:]/)[0];

module.exports = function BluehostConnectMain(context) {
	const { electron } = context;
	const container = LocalMain.getServiceContainer().cradle;
	const logger = container.localLogger.child({ thread: 'main', addon: 'bluehost-connect' });
	const { sendIPCEvent } = LocalMain;

	const workDir = path.join(context.environment.userDataPath, 'bluehost-connect');
	const store = new Store(workDir, electron.safeStorage);
	const keys = new SshKeyStore(path.join(workDir, 'ssh'));

	const syncService = new SyncService({
		store,
		keys,
		workDir,
		services: {
			siteData: container.siteData,
			siteDatabase: container.siteDatabase,
			siteProcessManager: container.siteProcessManager,
			wpCli: container.wpCli,
		},
		sendIPCEvent,
		logger,
	});

	const updater = new Updater({
		pkg,
		addonDir: path.resolve(__dirname, '..'),
		addonsDir: path.join(context.environment.userDataPath, 'addons'),
		ipcMain: electron.ipcMain,
		app: electron.app,
		logger,
		onChange: () => broadcast(),
	});
	if (electron.app) updater.start();

	const keyComment = () => `local-bluehost-connect@${os.hostname()}`.replace(/\s+/g, '-');

	const getState = (siteId) => ({
		account: store.getPublicAccount(),
		link: siteId ? store.getPublicLink(siteId) : null,
		activity: siteId ? syncService.activity(siteId) : null,
		publicKey: keys.getPublicKey(),
		passwordAuthSupported: process.platform !== 'win32',
		cloudHost: BLUEHOST_CLOUD_SSH_HOST,
		update: updater.state(),
	});

	const broadcast = (siteId) => sendIPCEvent(IPC.STATE_CHANGED, siteId || null);

	/** Sends step-by-step linking progress to the form that started it (matched by its progressId). */
	const progressReporter = (progressId) => (message) => {
		logger.info(`Linking: ${message}`);
		if (progressId) sendIPCEvent(IPC.LINK_PROGRESS, progressId, message);
	};

	/** Broadcasts once a transfer has registered as active, and again when it settles. */
	const runAndBroadcast = async (siteId, transfer) => {
		broadcast(siteId);
		try {
			return await transfer;
		} finally {
			broadcast(siteId);
		}
	};

	const checkPasswordAuth = (authType) => {
		if (authType === 'password' && process.platform === 'win32') {
			throw new Error('Password authentication is not supported on Windows yet. Use the SSH key option instead.');
		}
	};

	/** Logs in and runs a trivial command, so a wrong login or a disabled shell is reported before anything else. */
	const probe = async (transport) => {
		const { code, stdout, stderr } = await transport.exec(`echo ${PROBE_MARKER}`, { allowFailure: true });
		if (!stdout.includes(PROBE_MARKER)) {
			if (SHELL_DISABLED_RE.test(`${stdout}\n${stderr}`)) throw new ShellAccessDisabledError();
			if (code !== 0) throw new TransportError(describeSshFailure(code, stderr, transport), code, stderr);
			throw new Error('Connected, but the server did not run commands. Make sure Shell Access is turned on for SSH.');
		}
	};

	/**
	 * Verifies a shared-hosting SSH login. With a password and `installKey`, it also adds the add-on's SSH key to
	 * ~/.ssh/authorized_keys (what cPanel's "Authorize" does) and, once a key login works, drops the password.
	 */
	const prepareAccount = async ({ host, port, username, authType, password, installKey }, onProgress = () => {}) => {
		checkPasswordAuth(authType);
		const account = {
			host: cleanHost(host),
			port: Number(port) || 22,
			username: String(username || '').trim(),
			authType: authType === 'password' ? 'password' : 'key',
			password: authType === 'password' ? password : null,
		};
		if (!account.host || !HOSTNAME_RE.test(account.host)) throw new Error('Enter the server IP shown under SSH Details in the Bluehost Portal.');
		if (!account.username) throw new Error('Enter your SSH (cPanel) username.');
		const publicKey = keys.ensure(keyComment());

		onProgress('Connecting over SSH…');
		await probe(syncService.transportFor(account));

		if (account.authType === 'password' && installKey) {
			onProgress('Adding Local\'s SSH key to your account…');
			try {
				await syncService.transportFor(account).exec(installKeyScript(publicKey));
				const keyed = { ...account, authType: 'key', password: null };
				await probe(syncService.transportFor(keyed));
				return keyed;
			} catch (e) {
				// The password login still works, so keep it; the link simply goes on using the password.
				logger.warn(`Could not switch ${account.username}@${account.host} to key authentication: ${e.message}`);
			}
		}
		return account;
	};

	const accountTransport = () => {
		const account = store.getAccount();
		if (!account) throw new Error('Connect your Bluehost account first.');
		return { account, transport: syncService.transportFor(account) };
	};

	const listSites = async () => {
		const { transport } = accountTransport();
		const { stdout } = await transport.exec(listSitesScript());
		return parseSiteList(stdout);
	};

	/** Finishes a link: locates WordPress, makes sure WP-CLI is usable, and returns the link to store. */
	const verifyLink = async (link, onProgress) => {
		const transport = syncService.transportFor(link);
		onProgress('Locating WordPress…');
		let remote = await syncService.discoverRemote(transport, { remotePath: link.remotePath || null });
		if (!remote.hasWpCli && remote.hasPhp) {
			onProgress('WP-CLI is missing on the server; installing it in a private folder…');
			remote = await syncService.ensureWpCli(transport, remote);
		}
		return { ...link, remotePath: remote.remotePath, privateDir: remote.privateDir, nested: remote.nested };
	};

	/** Links a site picked from the connected shared-hosting account. Returns the link to store; nothing is saved yet. */
	const prepareAccountLink = async ({ webroot, label, home, altDomains }, onProgress = () => {}) => {
		const { account } = accountTransport();
		if (!webroot || !String(webroot).startsWith('/')) throw new Error('Choose a WordPress site from the list.');
		const link = {
			mode: 'account',
			...account,
			label: label ? String(label) : null,
			domain: hostOf(home) || (label && HOSTNAME_RE.test(label) ? label : null),
			remotePath: String(webroot),
			altDomains: (Array.isArray(altDomains) ? altDomains : []).map(String).filter((d) => HOSTNAME_RE.test(d)),
		};
		return verifyLink(link, onProgress);
	};

	/** Builds and verifies a link from SSH credentials (Bluehost Cloud or any SSH login). Nothing is saved yet. */
	const prepareManualLink = async ({ host, port, username, authType, password, remotePath, domain }, onProgress = () => {}) => {
		checkPasswordAuth(authType);
		if (authType !== 'password') keys.ensure(keyComment());
		const link = {
			mode: 'manual',
			authType: authType === 'password' ? 'password' : 'key',
			host: cleanHost(host),
			port: Number(port) || 22,
			username: String(username).trim(),
			password: authType === 'password' ? password : null,
			domain: domain ? String(domain).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : null,
			remotePath: remotePath ? String(remotePath).trim() : null,
		};
		link.label = link.domain || (link.host === BLUEHOST_CLOUD_SSH_HOST ? `Bluehost Cloud (${link.username})` : null);
		onProgress('Connecting over SSH…');
		return verifyLink(link, onProgress);
	};

	const prepareLink = (source, onProgress) => (source && source.kind === 'manual'
		? prepareManualLink(source, onProgress)
		: prepareAccountLink(source || {}, onProgress));

	/** Name, domain and folder for a new Local site, following Local's new-site defaults and avoiding clashes. */
	const newSiteLocation = (siteName) => {
		const defaults = {
			sitesPath: '~/Local Sites/',
			tld: '.local',
			environment: 'flywheel',
			adminEmail: 'dev-email@wpengine.local',
			...(LocalMain.UserData ? LocalMain.UserData.get('settings-new-site-defaults', {}) : {}),
		};
		const slug = String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bluehost-site';
		const sites = Object.values(container.siteData.getSites());
		const tld = `.${String(defaults.tld).replace(/^\.+/, '')}`;
		const expand = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
		for (let i = 1; i < 1000; i += 1) {
			const candidate = i === 1 ? slug : `${slug}-${i}`;
			const domain = `${candidate}${tld}`;
			const sitePath = path.join(defaults.sitesPath, candidate);
			const taken = sites.some((s) => s.domain === domain || path.resolve(expand(s.path)) === path.resolve(expand(sitePath)));
			if (!taken && !fs.existsSync(expand(sitePath))) {
				return { siteName: String(siteName).trim(), domain, sitePath, defaults };
			}
		}
		throw new Error('Could not find a free folder for the new site.');
	};

	const handlers = {
		[IPC.GET_STATE]: (siteId) => getState(siteId),

		[IPC.GET_PUBLIC_KEY]: () => keys.ensure(keyComment()),

		[IPC.CHECK_UPDATE]: () => updater.check({ manual: true }),

		[IPC.INSTALL_UPDATE]: () => updater.install(),

		[IPC.RESTART_LOCAL]: () => updater.restart(),

		[IPC.CONNECT_ACCOUNT]: async ({ progressId, ...credentials }) => {
			store.setAccount(await prepareAccount(credentials, progressReporter(progressId)));
			broadcast();
			return getState();
		},

		/**
		 * Forgets the account. With `removeKey`, also takes the add-on's key out of authorized_keys, unless a linked site
		 * still logs in with it (links keep their own copy of the login).
		 */
		[IPC.DISCONNECT_ACCOUNT]: async ({ removeKey } = {}) => {
			const account = store.getAccount();
			let notice = null;
			if (account && removeKey && account.authType === 'key') {
				const inUse = store.allLinks().some((l) => l.authType === 'key' && l.host === account.host && l.username === account.username);
				if (inUse) {
					notice = 'Local\'s SSH key was left on the account because linked sites still use it.';
				} else {
					try {
						await syncService.transportFor(account).exec(removeKeyScript(keys.getPublicKey()));
					} catch (e) {
						notice = `Could not remove Local's SSH key from the account: ${e.message}`;
					}
				}
			}
			store.clearAccount();
			broadcast();
			return { ...getState(), notice };
		},

		[IPC.LIST_SITES]: () => listSites(),

		[IPC.LINK_ACCOUNT_SITE]: async ({ siteId, progressId, ...choice }) => {
			store.setLink(siteId, await prepareAccountLink(choice, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.LINK_MANUAL]: async ({ siteId, progressId, ...credentials }) => {
			store.setLink(siteId, await prepareManualLink(credentials, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.COMPARE]: ({ siteId, checksum }) => runAndBroadcast(siteId, syncService.compare(siteId, { checksum })),

		[IPC.NEW_SITE_LOCATION]: (siteName) => {
			const { domain, sitePath } = newSiteLocation(siteName);
			return { domain, sitePath };
		},

		/**
		 * "Pull to a new site": verifies the Bluehost connection first (so a bad login never leaves an empty site
		 * behind), then creates a regular Local site with Local's own add-site service, links it and pulls.
		 * Resolves once the connection is verified; creation and the pull report progress in Local's site overlay.
		 */
		[IPC.PULL_NEW_SITE]: async ({ siteName, source }) => {
			if (!siteName || !String(siteName).trim()) throw new Error('Enter a name for the new site.');
			const link = await prepareLink(source, progressReporter(source && source.progressId));
			const location = newSiteLocation(siteName);

			(async () => {
				let site;
				try {
					site = await container.addSite.addSite({
						newSiteInfo: {
							siteName: location.siteName,
							siteDomain: location.domain,
							sitePath: location.sitePath,
							environment: location.defaults.environment,
							multiSite: '',
						},
						wpCredentials: {
							adminUsername: 'admin',
							adminPassword: randomString(20),
							adminEmail: location.defaults.adminEmail,
						},
						goToSite: true,
						installWP: true,
					});
				} catch (e) {
					// Local shows its own error dialog for failed site creation.
					logger.error(`Could not create the Local site for a Bluehost pull: ${e.message}`);
					return;
				}
				store.setLink(site.id, link);
				broadcast(site.id);
				try {
					await runAndBroadcast(site.id, syncService.pull(site.id, { deleteLocal: true, backupLocal: false }));
				} catch (e) {
					// Reported through the site banner.
				}
			})();

			return { domain: location.domain, sitePath: location.sitePath };
		},

		[IPC.UNLINK_SITE]: ({ siteId }) => {
			store.removeLink(siteId);
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.TEST_CONNECTION]: async (siteId) => {
			const link = store.getLink(siteId);
			if (!link) throw new Error('This site is not linked to Bluehost yet.');
			const remote = await syncService.discoverRemote(syncService.transportFor(link), { remotePath: link.remotePath });
			store.updateLink(siteId, { remotePath: remote.remotePath, privateDir: remote.privateDir, nested: remote.nested });
			broadcast(siteId);
			return remote;
		},

		// Outcomes are reported through site banners like Local Connect; the IPC reply only signals completion.
		[IPC.PUSH]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.push(siteId, options)),

		[IPC.PULL]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.pull(siteId, options)),
	};

	Object.entries(handlers).forEach(([channel, handler]) => LocalMain.addIpcAsyncListener(channel, handler));

	logger.info(`ConnectLocal for Bluehost loaded (rsync/ssh from ${findBundledBinDir() || 'system PATH'})`);
};
