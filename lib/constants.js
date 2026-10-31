'use strict';

/** IPC channels shared by the main and renderer halves of the add-on. */
const IPC = {
	GET_STATE: 'bluehostConnect:getState',
	CONNECT_ACCOUNT: 'bluehostConnect:connectAccount',
	DISCONNECT_ACCOUNT: 'bluehostConnect:disconnectAccount',
	LIST_SITES: 'bluehostConnect:listSites',
	LINK_ACCOUNT_SITE: 'bluehostConnect:linkAccountSite',
	LINK_MANUAL: 'bluehostConnect:linkManual',
	UNLINK_SITE: 'bluehostConnect:unlinkSite',
	TEST_CONNECTION: 'bluehostConnect:testConnection',
	PUSH: 'bluehostConnect:push',
	PULL: 'bluehostConnect:pull',
	COMPARE: 'bluehostConnect:compare',
	NEW_SITE_LOCATION: 'bluehostConnect:newSiteLocation',
	PULL_NEW_SITE: 'bluehostConnect:pullNewSite',
	/** main -> renderer: (progressId, message) while linking. */
	LINK_PROGRESS: 'bluehostConnect:linkProgress',
	GET_PUBLIC_KEY: 'bluehostConnect:getPublicKey',
	CHECK_UPDATE: 'bluehostConnect:checkUpdate',
	INSTALL_UPDATE: 'bluehostConnect:installUpdate',
	RESTART_LOCAL: 'bluehostConnect:restartLocal',
	/** main -> renderer broadcast whenever stored state changes. */
	STATE_CHANGED: 'bluehostConnect:stateChanged',
};

/** SSH host for every Bluehost Cloud (WP Cloud) site; each site has its own SSH user. */
const BLUEHOST_CLOUD_SSH_HOST = 'ssh.atomicsites.net';

/** Where the official WP-CLI build is downloaded from when a server has no `wp` command. */
const WP_CLI_PHAR_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

/**
 * Paths never synced in either direction. rsync --exclude also protects them from --delete, so each side keeps
 * its own environment files: Bluehost keeps wp-config.php (its DB credentials), .htaccess and php.ini (cPanel's
 * Apache and PHP settings) and the files cPanel itself writes into a docroot, and Local never receives Bluehost's
 * page-cache drop-ins and platform plugins, which would break the local site.
 */
const SYNC_EXCLUDES = [
	// Environment-specific config
	'/wp-config.php',
	'/.htaccess',
	'/.user.ini',
	'/php.ini',
	// Copies Bluehost's tools keep beside them (the .bak holds the database password) and the server's WP-CLI config
	'/wp-config.php.bak',
	'/.htaccess.nfd-backup',
	'/wp-cli.yml',
	'/nfd-private/',
	// cPanel-managed docroot files: CGI folder, AutoSSL/domain validation, PHP error logs, FTP quota
	'/cgi-bin/',
	'/.well-known/',
	'error_log',
	'/.ftpquota',
	// Server-specific state: Jetpack's firewall rules hold absolute server paths; upgrade/ is WordPress scratch space
	'wp-content/jetpack-waf/',
	'wp-content/upgrade/',
	// Bluehost Portal single sign-on, installed by the host
	'wp-content/mu-plugins/sso.php',
	// Caching drop-ins and cache output (Newfold performance module, legacy Endurance Page Cache)
	'wp-content/object-cache.php',
	'wp-content/advanced-cache.php',
	'wp-content/cache/',
	'wp-content/newfold-page-cache/',
	'wp-content/endurance-page-cache/',
	'wp-content/mu-plugins/endurance-*',
	// Bluehost Cloud (WP Cloud) platform plugin and scratch folders
	'wp-content/mu-plugins/wpcomsh-loader.php',
	'wp-content/mu-plugins/wpcomsh/',
	'/jetpack-temp/',
	'wp-content/upgrade-temp-backup/',
	// Site backups made by migration plugins: often gigabytes, and never wanted on the other side
	'wp-content/ai1wm-backups/',
	'wp-content/updraft/',
	// VCS and tooling
	'.git/',
	'.svn/',
	'node_modules/.bin/',
	'vendor/bin/',
	'.DS_Store',
	// Stray dumps in the webroot and Local helpers
	'/*.sql',
	'/*.sql.gz',
	'wp-content/mysql.sql',
	'local-phpinfo.php',
	'local-xdebuginfo.php',
	'wp-content/mu-plugins/local-by-flywheel-demo-urls.php',
	'wp-content/mu-plugins/local-by-flywheel-live-link-helper.php',
	// Ignore files for other hosts and for this add-on
	'.wpe-push-ignore',
	'.wpe-pull-ignore',
	'.cloudways-push-ignore',
	'.cloudways-pull-ignore',
	'.bluehost-push-ignore',
	'.bluehost-pull-ignore',
	'.kinsta-push-ignore',
	'.kinsta-pull-ignore',
];

/**
 * WordPress core, excluded in both directions when the server serves core from a shared copy (WP Cloud's `__wp__`
 * link). The server's site folder has no core files, so a pull with deletion would otherwise remove Local's core.
 */
const MANAGED_CORE_EXCLUDES = [
	'/__wp__',
	'/wp-admin/',
	'/wp-includes/',
	'/index.php',
	'/wp-*.php',
	'/xmlrpc.php',
	'/license.txt',
	'/readme.html',
];

/**
 * rsync filter rules added after the excludes. Must-use plugins that exist only on the receiving side are never
 * deleted: hosts install their own there, and a push from a Local site without them must not remove them.
 */
const SYNC_PROTECT = [
	'--filter=P wp-content/mu-plugins/*',
];

/** Optional per-site ignore files in the site's webroot, same idea as .wpe-push-ignore / .wpe-pull-ignore. */
const IGNORE_FILES = {
	push: '.bluehost-push-ignore',
	pull: '.bluehost-pull-ignore',
};

module.exports = {
	IPC,
	BLUEHOST_CLOUD_SSH_HOST,
	WP_CLI_PHAR_URL,
	SYNC_EXCLUDES,
	SYNC_PROTECT,
	MANAGED_CORE_EXCLUDES,
	IGNORE_FILES,
};
