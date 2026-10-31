'use strict';

const { ipcRenderer, shell } = require('electron');
const { ipcAsync, confirm } = require('@getflywheel/local/renderer');
const {
	Button,
	Checkbox,
	BasicInput,
	FlyModal,
	PrimaryButton,
	Spinner,
	TextButton,
	Title,
} = require('@getflywheel/local-components');

const { IPC } = require('../constants');

const SSH_HELP_URL = 'https://www.bluehost.com/help/article/ssh-access';
const CLOUD_SSH_HELP_URL = 'https://www.bluehost.com/help/article/connecting-to-cloud-with-ssh-key';

const errorText = (e) => (e && (e.messageMain || e.message)) || String(e);

module.exports = function createComponents({ React }) {
	const h = React.createElement;
	const { useCallback, useEffect, useState } = React;

	/** Loads add-on state for a site and keeps it fresh when the main process reports changes. */
	function useBluehostState(siteId) {
		const [state, setState] = useState(null);
		const refresh = useCallback(() => ipcAsync(IPC.GET_STATE, siteId).then(setState).catch(() => {}), [siteId]);
		useEffect(() => {
			refresh();
			const onChange = (_event, changedSiteId) => {
				if (!changedSiteId || changedSiteId === siteId) refresh();
			};
			ipcRenderer.on(IPC.STATE_CHANGED, onChange);
			return () => ipcRenderer.removeListener(IPC.STATE_CHANGED, onChange);
		}, [siteId, refresh]);
		return [state, refresh];
	}

	/** Wraps an async action with busy + error state. */
	function useAction() {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const run = useCallback(async (fn) => {
			setBusy(true);
			setError(null);
			try {
				return await fn();
			} catch (e) {
				setError(errorText(e));
				return undefined;
			} finally {
				setBusy(false);
			}
		}, []);
		return { busy, error, setError, run };
	}

	/** Step-by-step progress the main process reports while connecting or linking. `start()` returns a progressId. */
	function useLinkProgress() {
		const [progress, setProgress] = useState(null);
		const idRef = React.useRef(null);
		useEffect(() => {
			const onProgress = (_event, id, message) => {
				if (id && id === idRef.current) setProgress(message);
			};
			ipcRenderer.on(IPC.LINK_PROGRESS, onProgress);
			return () => ipcRenderer.removeListener(IPC.LINK_PROGRESS, onProgress);
		}, []);
		const start = () => {
			idRef.current = `link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setProgress(null);
			return idRef.current;
		};
		return { progress, start };
	}

	const isChecked = (value, previous) => (typeof value === 'boolean' ? value : !previous);

	const openLink = (url) => (e) => {
		e.preventDefault();
		shell.openExternal(url);
	};

	function Field({ label, help, children }) {
		return h('label', { className: 'BHConnect_Field' },
			h('span', { className: 'BHConnect_FieldLabel' }, label),
			children,
			help ? h('span', { className: 'BHConnect_Help' }, help) : null);
	}

	function TextInput({ value, onChange, type = 'text', placeholder, disabled }) {
		return h(BasicInput, {
			type,
			value: value || '',
			placeholder,
			disabled,
			onChange: (e) => onChange(e.target.value),
		});
	}

	function ErrorNote({ error }) {
		return error ? h('div', { className: 'BHConnect_Error', role: 'alert' }, error) : null;
	}

	function BusyNote({ busy, children }) {
		return busy ? h('div', { className: 'BHConnect_Busy' }, h(Spinner, null), h('span', null, children)) : null;
	}

	function Tabs({ value, onChange, tabs, className = 'BHConnect_Tabs' }) {
		return h('div', { className, role: 'tablist' },
			tabs.map(([key, label]) => h('button', {
				key,
				type: 'button',
				role: 'tab',
				'aria-selected': value === key,
				className: `BHConnect_Tab${value === key ? ' is-active' : ''}`,
				onClick: () => onChange(key),
			}, label)));
	}

	function PublicKeyBox() {
		const [publicKey, setPublicKey] = useState('');
		const [copied, setCopied] = useState(false);
		useEffect(() => {
			ipcAsync(IPC.GET_PUBLIC_KEY).then(setPublicKey).catch(() => {});
		}, []);
		const copy = () => {
			navigator.clipboard.writeText(publicKey).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			});
		};
		return h('div', { className: 'BHConnect_KeyBox' },
			h('textarea', { readOnly: true, value: publicKey, rows: 4, className: 'BHConnect_KeyText' }),
			h(TextButton, { onClick: copy, disabled: !publicKey }, copied ? 'Copied' : 'Copy public key'));
	}

	/** Password or SSH key, as radio buttons. Password is offered only where the platform supports it. */
	function AuthChoice({ state, value, onChange }) {
		return h('div', { className: 'BHConnect_AuthChoice' },
			state.passwordAuthSupported
				? h('label', null, h('input', { type: 'radio', checked: value === 'password', onChange: () => onChange('password') }), ' Password')
				: null,
			h('label', null, h('input', { type: 'radio', checked: value === 'key', onChange: () => onChange('key') }), ' SSH key'));
	}

	/** Options, wording and channel for each direction. */
	const DIRECTIONS = {
		push: {
			channel: IPC.PUSH,
			verb: 'Push',
			gerund: 'Pushing',
			button: 'Push to Bluehost',
			defaults: () => ({ files: true, database: true, deleteRemote: true, purgeCache: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in app/public except wp-config.php)'],
				['database', 'Database (with URL search & replace)'],
				options.files && ['deleteRemote', 'Delete files on Bluehost that are not in Local'],
				['purgeCache', 'Purge Bluehost caches afterwards'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} on ${where} with ${site.name} from Local.`,
				options.database && 'The Bluehost database is replaced; the previous one is saved as local-backup-before-push.sql in a private .bluehost-connect folder outside the webroot.',
				options.files && options.deleteRemote && 'Files on Bluehost that do not exist locally will be deleted. Other sites in subfolders of this site are never touched.',
			],
		},
		pull: {
			channel: IPC.PULL,
			verb: 'Pull',
			gerund: 'Pulling',
			button: 'Pull from Bluehost',
			defaults: () => ({ files: true, database: true, backupLocal: true, deleteLocal: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in the webroot except wp-config.php, server config and caches)'],
				['database', 'Database (with URL search & replace)'],
				options.database && ['backupLocal', 'Back up the Local database first'],
				options.files && ['deleteLocal', 'Delete Local files that are not on Bluehost'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} of ${site.name} in Local with ${where}.`,
				options.database && (options.backupLocal
					? 'The Local database is replaced; the previous one is saved in app/sql/local-backup-before-pull.sql.'
					: 'The Local database is replaced without a backup.'),
				options.files && options.deleteLocal && 'Local files that do not exist on Bluehost will be deleted.',
				options.files && 'Local files the pull replaces or deletes are moved to app/bluehost-backups (the last 3 pulls are kept).',
			],
		},
	};

	const linkTarget = (link) => link.label || link.domain || link.host;

	/**
	 * Push or pull options, shared by the Tools panel and the header modal. Inside the modal the modal itself is the
	 * confirmation and it closes as soon as the transfer starts (progress shows in the site overlay, like Local Connect).
	 */
	function TransferForm({ direction, site, link, activity, inModal = false, onStarted }) {
		const config = DIRECTIONS[direction];
		const [options, setOptions] = useState(() => config.defaults(link));
		const { busy, error, run } = useAction();
		const toggle = (key) => (value) => setOptions((o) => ({ ...o, [key]: isChecked(value, o[key]) }));
		const nothingSelected = !options.files && !options.database;
		const where = linkTarget(link);
		const what = options.files && options.database ? 'files and database' : options.files ? 'files' : 'database';
		const consequences = config.consequences({ what, where, site, options }).filter(Boolean);
		const running = busy || activity === direction;

		const start = async () => {
			if (!inModal) {
				await confirm({
					title: `${config.verb} ${what} ${direction === 'push' ? 'to' : 'from'} Bluehost?`,
					message: h('div', null, consequences.map((text) => h('p', { key: text }, text))),
					buttonText: config.verb,
				});
			}
			const request = ipcAsync(config.channel, { siteId: site.id, options });
			if (onStarted) {
				onStarted();
				// Failures surface as a site banner, as with Local Connect.
				request.catch(() => {});
				return;
			}
			await run(() => request);
		};

		return h('div', { className: 'BHConnect_TransferForm' },
			h('div', { className: 'BHConnect_Options' },
				config.checkboxes(link, options).filter(Boolean).map(([key, label]) => h(Checkbox, {
					key,
					label,
					checked: options[key],
					onChange: toggle(key),
				}))),
			inModal ? h('ul', { className: 'BHConnect_Consequences' }, consequences.map((text) => h('li', { key: text }, text))) : null,
			h(ErrorNote, { error }),
			h('div', { className: 'BHConnect_Actions' },
				h(PrimaryButton, { onClick: start, disabled: running || Boolean(activity) || nothingSelected }, running ? `${config.gerund}…` : config.button)));
	}

	const describeLast = (last) => `${new Date(last.at).toLocaleString()} (${[last.files && 'files', last.database && 'database'].filter(Boolean).join(' + ')}, ${last.seconds}s)`;

	function LinkedView({ site, state }) {
		const { link } = state;
		const test = useAction();
		const unlink = useAction();
		const [testResult, setTestResult] = useState(null);
		const [direction, setDirection] = useState('push');

		const rows = [
			link.label && ['Site', link.label],
			link.domain && link.domain !== link.label && ['Domain', link.domain],
			['SSH', `${link.username}@${link.host}${Number(link.port) !== 22 ? `:${link.port}` : ''}`],
			['Remote path', link.remotePath],
			link.nested && link.nested.length ? ['Never synced', `Other sites in subfolders: ${link.nested.join(', ')}`] : null,
			['Authentication', link.authType === 'password' ? 'SSH password' : 'Local\'s SSH key'],
			link.lastPush && ['Last push', describeLast(link.lastPush)],
			link.lastPull && ['Last pull', describeLast(link.lastPull)],
		].filter(Boolean);

		return h('div', null,
			h('table', { className: 'BHConnect_Table' },
				h('tbody', null, rows.map(([k, v]) => h('tr', { key: k }, h('th', null, k), h('td', null, v))))),
			h(Tabs, {
				value: direction,
				onChange: setDirection,
				tabs: [['push', 'Push to Bluehost'], ['pull', 'Pull from Bluehost'], ['compare', 'Compare & sync files']],
				className: 'BHConnect_Tabs BHConnect_Tabs--Transfer',
			}),
			direction === 'compare'
				? h(CompareView, { site, activity: state.activity })
				: h(TransferForm, { key: direction, direction, site, link, activity: state.activity }),
			h('div', { className: 'BHConnect_Secondary' },
				h(TextButton, {
					disabled: test.busy,
					onClick: () => test.run(async () => {
						setTestResult(null);
						const remote = await ipcAsync(IPC.TEST_CONNECTION, site.id);
						setTestResult(`Connected. WordPress found at ${remote.remotePath}${remote.hasWpCli ? '' : ' (WP-CLI missing: database transfers will fail)'}.`);
					}),
				}, test.busy ? 'Testing…' : 'Test connection'),
				h(TextButton, {
					intent: 'destructive',
					disabled: unlink.busy || Boolean(state.activity),
					onClick: () => unlink.run(() => ipcAsync(IPC.UNLINK_SITE, { siteId: site.id })),
				}, 'Unlink from Bluehost')),
			testResult ? h('div', { className: 'BHConnect_Success' }, testResult) : null,
			h(ErrorNote, { error: test.error || unlink.error }));
	}

	/** Shared-hosting SSH login form. Connecting stores the login so the account's sites can be listed. */
	function AccountConnectForm({ state }) {
		const [form, setForm] = useState({ host: '', port: '22', username: '', authType: state.passwordAuthSupported ? 'password' : 'key', password: '', installKey: true });
		const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
		const action = useAction();
		const { progress, start } = useLinkProgress();
		const complete = form.host.trim() && form.username.trim() && (form.authType === 'key' || form.password);

		return h('div', { className: 'BHConnect_Form' },
			h('p', { className: 'BHConnect_Intro' },
				'Sign in over SSH with your Bluehost hosting account. In the Bluehost Portal, open ',
				h('strong', null, 'Hosting → My Plans → SSH Management'),
				' and turn on Shell Access. The IP and username are listed there under SSH Details. ',
				h('a', { href: '#', onClick: openLink(SSH_HELP_URL) }, 'How to turn on SSH')),
			h('div', { className: 'BHConnect_Row' },
				h(Field, { label: 'Host', help: 'The IP shown under SSH Details.' },
					h(TextInput, { value: form.host, onChange: set('host'), placeholder: '203.0.113.10' })),
				h(Field, { label: 'Port' }, h(TextInput, { value: form.port, onChange: set('port') }))),
			h(Field, { label: 'Username', help: 'The username shown next to the IP under SSH Details.' },
				h(TextInput, { value: form.username, onChange: set('username') })),
			h(AuthChoice, { state, value: form.authType, onChange: set('authType') }),
			form.authType === 'password'
				? h(React.Fragment, null,
					h(Field, { label: 'Password', help: 'Your hosting account password.' }, h(TextInput, { value: form.password, onChange: set('password'), type: 'password' })),
					h(Checkbox, {
						label: 'Add Local\'s SSH key to the account so the password isn\'t stored (recommended)',
						checked: form.installKey,
						onChange: (v) => set('installKey')(isChecked(v, form.installKey)),
					}))
				: h(Field, {
					label: 'Public key',
					help: 'On the SSH Management page, click Add SSH Key under Manage SSH Keys and paste this public key.',
				}, h(PublicKeyBox)),
			h(BusyNote, { busy: action.busy }, progress || 'Connecting…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'BHConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !complete,
					onClick: () => action.run(() => ipcAsync(IPC.CONNECT_ACCOUNT, { ...form, progressId: start() })),
				}, action.busy ? 'Connecting…' : 'Connect account')));
	}

	/**
	 * Picks a WordPress site from the connected shared-hosting account. `onSubmit({ kind: 'account', webroot, … })`
	 * links it (or, on the new-site page, creates a site and pulls it).
	 */
	function AccountSetup({ state, submitLabel, canSubmit = true, onSubmit, onSiteSelected }) {
		const [sites, setSites] = useState(null);
		const [selected, setSelected] = useState('');
		const [removeKey, setRemoveKey] = useState(false);
		const [notice, setNotice] = useState(null);
		const action = useAction();
		const { progress, start } = useLinkProgress();

		const loadSites = useCallback(() => action.run(async () => {
			const list = await ipcAsync(IPC.LIST_SITES);
			setSites(list);
			if (list.length) setSelected(list[0].webroot);
		}), [action.run]);

		useEffect(() => {
			if (state.account && sites === null) loadSites();
		}, [state.account]);

		const choice = sites && sites.find((s) => s.webroot === selected);

		useEffect(() => {
			if (choice && onSiteSelected) onSiteSelected(choice);
		}, [choice && choice.webroot]);

		if (!state.account) {
			return h(React.Fragment, null,
				notice ? h('div', { className: 'BHConnect_Warning' }, notice) : null,
				h(AccountConnectForm, { state }));
		}

		const { account } = state;
		return h('div', { className: 'BHConnect_Form' },
			h('div', { className: 'BHConnect_Account' },
				h('span', null, 'Connected as ', h('strong', null, `${account.username}@${account.host}`)),
				h(TextButton, {
					onClick: () => action.run(async () => {
						const res = await ipcAsync(IPC.DISCONNECT_ACCOUNT, { removeKey });
						setSites(null);
						setNotice(res && res.notice);
					}),
				}, 'Disconnect'),
				account.authType === 'key'
					? h(Checkbox, { label: 'Also remove Local\'s SSH key from the account', checked: removeKey, onChange: (v) => setRemoveKey((p) => isChecked(v, p)) })
					: null),
			sites === null
				? h(BusyNote, { busy: true }, 'Looking for WordPress sites in your account…')
				: sites.length === 0
					? h('p', null, 'No WordPress sites were found in this account. If yours lives somewhere unusual, link it from the "Bluehost Cloud / SSH" tab with its remote path.')
					: h(Field, { label: 'WordPress site', help: choice ? choice.path : null },
						h('select', { className: 'BHConnect_Select', value: selected, onChange: (e) => setSelected(e.target.value) },
							sites.map((s) => h('option', { key: s.webroot, value: s.webroot }, `${s.label}${s.label !== s.path ? ` — ${s.path}` : ''}`)))),
			h(BusyNote, { busy: action.busy && sites !== null }, progress || 'Linking…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'BHConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !choice || !canSubmit,
					onClick: () => action.run(() => onSubmit({
						kind: 'account',
						webroot: choice.webroot,
						label: choice.label,
						home: choice.home,
						altDomains: choice.altDomains,
						progressId: start(),
					})),
				}, submitLabel),
				h(TextButton, { disabled: action.busy, onClick: loadSites }, 'Refresh list')));
	}

	/** SSH credentials for one site: Bluehost Cloud's per-site SSH users, or any other SSH login. `onSubmit({ kind: 'manual', … })`. */
	function ManualSetup({ state, submitLabel, canSubmit = true, onSubmit }) {
		const [form, setForm] = useState({ host: state.cloudHost, port: '22', username: '', authType: 'key', password: '', remotePath: '', domain: '' });
		const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
		const action = useAction();
		const { progress, start } = useLinkProgress();
		const complete = form.host && form.username && (form.authType === 'key' || form.password);
		const isCloud = form.host.trim() === state.cloudHost;

		return h('div', { className: 'BHConnect_Form' },
			h('p', { className: 'BHConnect_Intro' },
				'For Bluehost Cloud: in the Bluehost Portal, open ',
				h('strong', null, 'Websites → Manage Site → SSH/SFTP → Add SSH User'),
				', turn on SSH Key and paste the public key below. Then enter that SSH username here. ',
				h('a', { href: '#', onClick: openLink(CLOUD_SSH_HELP_URL) }, 'Bluehost\'s guide')),
			h('div', { className: 'BHConnect_Row' },
				h(Field, { label: 'Host' }, h(TextInput, { value: form.host, onChange: set('host'), placeholder: state.cloudHost })),
				h(Field, { label: 'Port' }, h(TextInput, { value: form.port, onChange: set('port') }))),
			h(Field, { label: 'Username', help: isCloud ? 'Each Cloud site has its own SSH user (a Global SSH User looks like globaluser-12345678).' : null },
				h(TextInput, { value: form.username, onChange: set('username') })),
			h(AuthChoice, { state, value: form.authType, onChange: set('authType') }),
			form.authType === 'password'
				? h(Field, { label: 'Password', help: 'Stored encrypted with your system keychain.' }, h(TextInput, { value: form.password, onChange: set('password'), type: 'password' }))
				: h(Field, { label: 'Public key', help: isCloud ? 'Paste this into the Add SSH User form.' : 'Add this key to the server\'s authorized keys first.' }, h(PublicKeyBox)),
			h(Field, { label: 'Remote path (optional)', help: 'The folder that holds wp-config.php. Detected automatically when left empty.' },
				h(TextInput, { value: form.remotePath, onChange: set('remotePath'), placeholder: 'auto-detect' })),
			h(Field, { label: 'Site domain (optional)', help: 'Only used if the Bluehost database has no home URL yet.' },
				h(TextInput, { value: form.domain, onChange: set('domain'), placeholder: 'example.com' })),
			h(BusyNote, { busy: action.busy }, progress || 'Connecting…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'BHConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !complete || !canSubmit,
					onClick: () => action.run(() => onSubmit({ kind: 'manual', ...form, progressId: start() })),
				}, action.busy ? 'Connecting…' : submitLabel)));
	}

	function SetupView(props) {
		const [mode, setMode] = useState('account');
		return h('div', null,
			h(Tabs, { value: mode, onChange: setMode, tabs: [['account', 'Shared hosting'], ['manual', 'Bluehost Cloud / SSH']] }),
			mode === 'account' ? h(AccountSetup, props) : h(ManualSetup, props));
	}

	// ---------------------------------------------------------------- updates

	/** Announces a newer release and installs it through Local's add-on installer. */
	function UpdateNotice({ update }) {
		const action = useAction();
		if (!update) return null;
		const error = action.error || update.error;
		if (update.installed) {
			return h('div', { className: 'BHConnect_Update', role: 'status' },
				h('span', null, `${update.name} ${update.latest} is installed. Restart Local to start using it.`),
				h('div', { className: 'BHConnect_UpdateActions' },
					h(PrimaryButton, { onClick: () => action.run(() => ipcAsync(IPC.RESTART_LOCAL)) }, 'Restart Local')));
		}
		if (!update.latest) return error && !update.checking ? h(ErrorNote, { error }) : null;
		const busy = action.busy || update.installing;
		return h('div', { className: 'BHConnect_Update', role: 'status' },
			h('span', null, `${update.name} ${update.latest} is available. You have ${update.current}.`),
			update.devInstall
				? h('span', { className: 'BHConnect_Help' }, 'This copy is linked from a development folder, so update that folder instead.')
				: null,
			h('div', { className: 'BHConnect_UpdateActions' },
				update.devInstall
					? null
					: h(PrimaryButton, { disabled: busy, onClick: () => action.run(() => ipcAsync(IPC.INSTALL_UPDATE)) }, busy ? 'Updating…' : 'Update'),
				update.releaseUrl ? h(TextButton, { onClick: () => shell.openExternal(update.releaseUrl) }, 'What\'s new') : null),
			error ? h(ErrorNote, { error }) : null);
	}

	/** Version line with a manual "Check for updates". */
	function VersionFooter({ update }) {
		const [checked, setChecked] = useState(false);
		if (!update) return null;
		const check = () => ipcAsync(IPC.CHECK_UPDATE).then(() => setChecked(true)).catch(() => {});
		const upToDate = checked && !update.checking && !update.latest && !update.error;
		return h('div', { className: 'BHConnect_Version' },
			h('span', null, `${update.name} ${update.current}`),
			update.checking
				? h('span', null, 'Checking for updates…')
				: upToDate
					? h('span', null, 'You have the latest version.')
					: update.latest ? null : h(TextButton, { onClick: check }, 'Check for updates'));
	}

	const linkSite = (siteId) => ({ kind, ...source }) => (kind === 'account'
		? ipcAsync(IPC.LINK_ACCOUNT_SITE, { siteId, ...source })
		: ipcAsync(IPC.LINK_MANUAL, { siteId, ...source }));

	function BluehostPanel({ site }) {
		const [state] = useBluehostState(site && site.id);
		if (!site) return null;
		return h('div', { className: 'BHConnect' },
			h(Title, { size: 'm', className: 'BHConnect_Title' }, 'Bluehost'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			!state
				? h(BusyNote, { busy: true }, 'Loading…')
				: state.link
					? h(LinkedView, { site, state })
					: h(SetupView, { state, submitLabel: `Link ${site.name}`, onSubmit: linkSite(site.id) }),
			state ? h(VersionFooter, { update: state.update }) : null);
	}

	// ---------------------------------------------------------------- compare & selective sync

	const formatSize = (bytes) => {
		if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	};
	const formatTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
	const describeSide = (side) => (side ? [formatSize(side.size), formatTime(side.mtime)].filter(Boolean).join(' · ') : '');

	const GROUPS = [
		['changed', 'Different on each side'],
		['local-only', 'Only in Local'],
		['remote-only', 'Only on Bluehost'],
	];
	const NEWER = { local: 'Newer in Local', remote: 'Newer on Bluehost', same: 'Same date' };
	const ROW_LIMIT = 200;

	function CompareRow({ entry, checked, onToggle }) {
		return h('label', { className: 'BHConnect_FileRow' },
			h('input', { type: 'checkbox', checked, onChange: onToggle }),
			h('span', { className: 'BHConnect_FilePath', title: entry.path }, entry.path, entry.type === 'symlink' ? ' (link)' : ''),
			entry.status === 'changed'
				? h('span', { className: 'BHConnect_FileMeta' },
					h('span', null, `Local: ${describeSide(entry.local)}`),
					h('span', null, `Bluehost: ${describeSide(entry.remote)}`),
					entry.newer ? h('span', { className: `BHConnect_Badge BHConnect_Badge--${entry.newer}` }, NEWER[entry.newer]) : null)
				: h('span', { className: 'BHConnect_FileMeta' }, describeSide(entry.status === 'local-only' ? entry.local : entry.remote)));
	}

	/**
	 * MagicSync-style comparison: lists files that differ between Local and Bluehost, lets you tick files, and
	 * pushes or pulls only those. A ticked file missing on the sending side is deleted on the receiving side.
	 */
	function CompareView({ site, activity }) {
		const [result, setResult] = useState(null);
		const [checksum, setChecksum] = useState(false);
		const [filter, setFilter] = useState('');
		const [selected, setSelected] = useState(() => new Set());
		const compareAction = useAction();
		const syncAction = useAction();

		const compare = () => compareAction.run(async () => {
			const res = await ipcAsync(IPC.COMPARE, { siteId: site.id, checksum });
			setResult(res);
			setSelected(new Set());
		});

		const entries = result ? result.entries : [];
		const needle = filter.trim().toLowerCase();
		const visible = needle ? entries.filter((e) => e.path.toLowerCase().includes(needle)) : entries;
		const toggle = (p) => setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(p)) next.delete(p);
			else next.add(p);
			return next;
		});
		const setGroup = (list, on) => setSelected((prev) => {
			const next = new Set(prev);
			list.forEach((e) => (on ? next.add(e.path) : next.delete(e.path)));
			return next;
		});

		const chosen = entries.filter((e) => selected.has(e.path));
		const count = (statuses) => chosen.filter((e) => statuses.includes(e.status)).length;

		const sync = async (direction) => {
			const send = direction === 'push' ? count(['changed', 'local-only']) : count(['changed', 'remote-only']);
			const remove = direction === 'push' ? count(['remote-only']) : count(['local-only']);
			const there = direction === 'push' ? 'on Bluehost' : 'in Local';
			await confirm({
				title: `${direction === 'push' ? 'Push' : 'Pull'} ${chosen.length} selected file${chosen.length === 1 ? '' : 's'}?`,
				message: h('div', null,
					send ? h('p', null, `${send} file${send === 1 ? '' : 's'} will be ${direction === 'push' ? 'uploaded to Bluehost' : 'downloaded to Local'}, replacing the copy ${there}.`) : null,
					remove ? h('p', null, `${remove} file${remove === 1 ? '' : 's'} that only exist${remove === 1 ? 's' : ''} ${there} will be deleted ${there}.`) : null,
					h('p', null, 'The database is not changed.')),
				buttonText: direction === 'push' ? 'Push' : 'Pull',
			});
			await syncAction.run(async () => {
				const fileList = chosen.map((e) => e.path);
				const options = direction === 'push' ? { fileList, purgeCache: true } : { fileList };
				await ipcAsync(direction === 'push' ? IPC.PUSH : IPC.PULL, { siteId: site.id, options });
				await compare();
			});
		};

		const busy = compareAction.busy || syncAction.busy || Boolean(activity);

		return h('div', { className: 'BHConnect_Compare' },
			h('p', { className: 'BHConnect_Intro' },
				'See which files differ between Local and Bluehost, then push or pull only the ones you pick. Nothing changes until you choose.'),
			h('div', { className: 'BHConnect_Actions BHConnect_Actions--Top' },
				h(PrimaryButton, { onClick: compare, disabled: busy }, compareAction.busy || activity === 'compare' ? 'Comparing…' : result ? 'Compare again' : 'Compare with Bluehost'),
				h(Checkbox, { label: 'Compare file contents (slower)', checked: checksum, onChange: (v) => setChecksum((p) => isChecked(v, p)) })),
			h(ErrorNote, { error: compareAction.error || syncAction.error }),
			result
				? h('div', null,
					h('p', { className: 'BHConnect_Summary', role: 'status' },
						entries.length === 0
							? 'Local and Bluehost have the same files.'
							: GROUPS.map(([key, label]) => `${entries.filter((e) => e.status === key).length} ${label.toLowerCase()}`).join(' · ')),
					entries.length
						? h(React.Fragment, null,
							h('div', { className: 'BHConnect_Filter' },
								h(TextInput, { value: filter, onChange: setFilter, placeholder: 'Filter by path, e.g. wp-content/themes' })),
							GROUPS.map(([key, label]) => {
								const list = visible.filter((e) => e.status === key);
								if (!list.length) return null;
								const allOn = list.every((e) => selected.has(e.path));
								return h('section', { key, className: 'BHConnect_Group' },
									h('label', { className: 'BHConnect_GroupHeader' },
										h('input', { type: 'checkbox', checked: allOn, onChange: () => setGroup(list, !allOn) }),
										h('span', null, `${label} (${list.length})`)),
									list.slice(0, ROW_LIMIT).map((entry) => h(CompareRow, {
										key: entry.path,
										entry,
										checked: selected.has(entry.path),
										onToggle: () => toggle(entry.path),
									})),
									list.length > ROW_LIMIT
										? h('p', { className: 'BHConnect_Help' }, `${list.length - ROW_LIMIT} more not shown. Narrow the list with the filter; the group checkbox still selects all ${list.length}.`)
										: null);
							}),
							h('div', { className: 'BHConnect_Actions BHConnect_SyncBar' },
								h('span', null, `${chosen.length} selected`),
								h(Button, { disabled: busy || !chosen.length, onClick: () => sync('pull') }, syncAction.busy && activity === 'pull' ? 'Pulling…' : 'Pull selected'),
								h(PrimaryButton, { disabled: busy || !chosen.length, onClick: () => sync('push') }, syncAction.busy && activity === 'push' ? 'Pushing…' : 'Push selected')))
						: null)
				: null);
	}

	// ---------------------------------------------------------------- pull to a new site

	/** Page behind Local's "Create a site → Pull from Bluehost" option. */
	function NewSitePage({ history }) {
		const [state] = useBluehostState(null);
		const [siteName, setSiteName] = useState('');
		const [nameTouched, setNameTouched] = useState(false);
		const [location, setLocation] = useState(null);
		const [started, setStarted] = useState(null);

		useEffect(() => {
			const name = siteName.trim();
			if (!name) {
				setLocation(null);
				return undefined;
			}
			const timer = setTimeout(() => {
				ipcAsync(IPC.NEW_SITE_LOCATION, name).then(setLocation).catch(() => setLocation(null));
			}, 200);
			return () => clearTimeout(timer);
		}, [siteName]);

		const onSiteSelected = (choice) => {
			if (!nameTouched) setSiteName(choice.label);
		};

		const submit = async (source) => {
			const res = await ipcAsync(IPC.PULL_NEW_SITE, { siteName: siteName.trim(), source });
			setStarted(res);
		};

		return h('div', { className: 'BHConnect BHConnect_NewSite' },
			h('div', { className: 'BHConnect_NewSiteHeader' },
				h(TextButton, { onClick: () => history.push('/main/create-site') }, '← Back'),
				h(Title, { size: 'l', className: 'BHConnect_Title' }, 'Pull from Bluehost')),
			h('p', { className: 'BHConnect_Intro' },
				'Creates a new Local site, then pulls the files and database of a Bluehost WordPress site into it. Your Bluehost site is not changed.'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			started
				? h('div', { className: 'BHConnect_Success', role: 'status' },
					`Creating ${siteName.trim()} at ${started.domain}. Progress continues in the site's overlay.`)
				: h(React.Fragment, null,
					h(Field, {
						label: 'Local site name',
						help: location ? `${location.domain} · ${location.sitePath}` : 'Defaults to the Bluehost site\'s domain.',
					}, h(TextInput, { value: siteName, onChange: (v) => { setNameTouched(true); setSiteName(v); }, placeholder: 'My Bluehost site' })),
					!state
						? h(BusyNote, { busy: true }, 'Loading…')
						: h(SetupView, {
							state,
							submitLabel: 'Create site & pull',
							canSubmit: Boolean(siteName.trim()),
							onSubmit: submit,
							onSiteSelected,
						})));
	}

	function HeaderButtons({ site }) {
		const [state] = useBluehostState(site && site.id);
		const [open, setOpen] = useState(null);
		if (!site || !state || !state.link) return null;
		const { link, activity } = state;
		const button = (direction) => h(Button, {
			key: direction,
			className: 'BHConnect_HeaderButton',
			disabled: Boolean(activity),
			onClick: () => setOpen(direction),
			title: `${DIRECTIONS[direction].button} (${linkTarget(link)})`,
		}, activity === direction ? `${DIRECTIONS[direction].gerund}…` : DIRECTIONS[direction].verb);

		return h('span', { className: 'BHConnect_HeaderButtons' },
			h('span', { className: 'BHConnect_HeaderLabel' }, 'Bluehost'),
			button('pull'),
			button('push'),
			open
				? h(FlyModal, { isOpen: true, contentLabel: DIRECTIONS[open].button, onRequestClose: () => setOpen(null) },
					h('div', { className: 'BHConnect BHConnect_Modal' },
						h(Title, { size: 'l', className: 'BHConnect_Title' }, DIRECTIONS[open].button),
						h('p', { className: 'BHConnect_Intro' }, open === 'push'
							? `${site.name} → ${linkTarget(link)}`
							: `${linkTarget(link)} → ${site.name}`),
						h(TransferForm, { direction: open, site, link, activity, inModal: true, onStarted: () => setOpen(null) })))
				: null);
	}

	return { BluehostPanel, HeaderButtons, TransferForm, CompareView, NewSitePage };
};
