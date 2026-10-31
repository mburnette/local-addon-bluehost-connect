# Host Connect for Bluehost

A [Local](https://localwp.com) add-on that connects Local to WordPress sites on [Bluehost](https://www.bluehost.com) shared hosting and Bluehost Cloud. It works the way Local Connect does for WP Engine and Flywheel. You can:

- **push** a site's files, database, or both to Bluehost;
- **pull** them back into an existing Local site;
- **pull a Bluehost site into a brand-new Local site**;
- **compare** files on both sides and push or pull only the ones you pick, like MagicSync.

Bluehost has no public hosting API, so everything runs over SSH. That means rsync for files and WP-CLI for the database, the same tools Local Connect uses for WP Engine.

| Step | WP Engine (built in) | Host Connect for Bluehost |
| --- | --- | --- |
| Auth | WP Engine account + Local's SSH key registered via CAPI | **Shared:** your SSH (cPanel) login. With a password, the add-on adds its own SSH key to `~/.ssh/authorized_keys` and then stops storing the password. **Cloud:** a per-site SSH user on `ssh.atomicsites.net` with the add-on's public key. |
| Finding the site | CAPI install list | Lists every WordPress install in the account, using cPanel's domain list (`uapi DomainInfo domains_data`) for names and `wp option get home` for URLs |
| Backup | CAPI backup before push | The remote database is exported before every database push (there is no API to trigger a Bluehost backup) |
| Files | Local's bundled `rsync` over SSH, `--delete`, excludes `wp-config.php` | Same binaries, same flags. Also excludes cPanel's own files, Bluehost's cache drop-ins, **and any other site served from a subfolder of this one** (addon domains). Must-use plugins that exist only on one side are never deleted. |
| Database | `wp db export` backup → `wp db reset` → import → `search-replace //local //remote` → match table prefix | Same, plus collation fixes between MySQL and MariaDB and automatic restore if an import fails. If the server has no `wp`, the add-on downloads the official WP-CLI build into a private folder. |
| Pull | rsync down, export remote DB, import, `search-replace //remote //local` | Same. It also replaces other domains served from the same folder, such as a temporary `*.mybluehost.me` address. |
| Cache | Purge CDN/object/page cache | `wp cache flush`, plus the Bluehost plugin's own purge (page cache, Nginx and Cloudflare, through its Newfold performance module), plus removal of the page-cache folders |
| Pull to new site | "Create a site → Pull from WP Engine" | "Create a site → Pull from Bluehost". It checks the connection first, creates the site with Local's `addSite` service, links it, then pulls. |
| MagicSync | rsync dry run, itemized changes, file tree with checkboxes | rsync dry runs in both directions, merged into one list with both sides' size and date. Ticked files move with `--files-from`. |

## Requirements

- Local 6 or newer. Developed against **Local 10.1.2 on macOS**.
- **Shared hosting:** SSH turned on for the account. In the Bluehost Portal, open **Hosting → My Plans → SSH Management** and turn on **Shell Access** ([Bluehost's guide](https://bluehost.com/help/article/ssh-access)). The server IP and SSH username are listed there under **SSH Details**; the port is 22.
- **Bluehost Cloud:** an SSH user for the site. In the Bluehost Portal, open **Websites → Manage Site → SSH/SFTP → Add SSH User** and turn on SSH Key ([Bluehost's guide](https://www.bluehost.com/help/article/connecting-to-cloud-with-ssh-key)).
- rsync and PHP on the server. WP-CLI is used if it is installed; if it isn't, the add-on installs its own copy.

## Install

### From source (development)

```bash
npm install
```

```bash
npm run install-addon
```

This symlinks the folder into Local's add-ons directory (`~/Library/Application Support/Local/addons` on macOS) and enables it. **Restart Local** to load it. To remove it, run `npm run install-addon -- --remove`.

This add-on is separate from Host Connect for Cloudways and Host Connect for Kinsta, and can be installed next to them: package names, IPC channels, CSS classes, storage folders and ignore files are all distinct.

### From a release

Download the `.tgz` from the [latest release](../../releases/latest). In Local, go to **Add-ons → Install from disk**, choose the file, enable the add-on and restart Local.

### Updates

The add-on checks this repository's releases when Local starts and every 12 hours after that. You can also check right away from **Check for updates** at the bottom of the add-on's panel. When a new version is out, the panel shows an **Update** button. It installs the update through Local's own add-on installer, then offers to restart Local. Your linked sites and saved credentials are kept.

To build a package yourself, run `npm run package`, or use `npm run release -- patch --dry-run` (see [RELEASING.md](RELEASING.md)).

## Use

1. Open a site in Local and go to **Tools → Bluehost**.
2. Connect in one of two ways:
   - **Shared hosting:** enter the IP and username from **SSH Details**, and either your password or the add-on's public key.
     - With a password and **Add Local's SSH key to the account** ticked (the default), the add-on adds its key to `~/.ssh/authorized_keys`. That is what cPanel's "Authorize" button does. Once a key login works, the password is discarded.
     - With the key option, click **Add SSH Key** under **Manage SSH Keys** on the SSH Management page and paste the shown public key first. On the account tested, a key added there works immediately.
     - The add-on then lists every WordPress site in the account (main domain first). Pick one and click **Link**.
   - **Bluehost Cloud / SSH:** the host defaults to `ssh.atomicsites.net`. Enter the site's SSH username (a Global SSH User looks like `globaluser-12345678`) and paste the shown public key into the Add SSH User form. This tab also works for any other SSH login; set the remote path if WordPress isn't found automatically.
3. Push or pull from the panel's **Push to Bluehost** / **Pull from Bluehost** tabs. Once the site is linked, you can also use the **Bluehost: Pull / Push** buttons in the site header.
   - Push options: Files and/or Database; delete files on Bluehost that aren't in Local (on by default, like WP Engine); purge Bluehost caches afterwards.
   - Every pull moves the Local files it replaces or deletes into `app/bluehost-backups/pull-<time>/` instead of discarding them; the last 3 are kept. If you pull by mistake, copy them back from there.
   - Pull options: Files and/or Database; back up the Local database first; delete Local files that aren't on Bluehost (on by default).

Progress appears in Local's site overlay. When the transfer finishes, a banner reports success or the error.

### Pull a Bluehost site into a new Local site

1. Click **+** (Create a site) in Local and choose **Pull from Bluehost**.
2. Pick the site from your connected account, or enter Cloud/SSH details. Name the Local site; it defaults to the site's domain.
3. Click **Create site & pull**. The connection is checked **first**, so a wrong login never leaves an empty site behind.

### Compare & sync files (selective sync)

Go to **Tools → Bluehost → Compare & sync files** and click **Compare with Bluehost**. Nothing changes until you choose files. Differing files are listed under **Different on each side**, **Only in Local** and **Only on Bluehost**. Tick files, then click **Push selected** or **Pull selected**. A ticked file that exists only on the receiving side is deleted there. The database is never touched.

### Sites inside other sites (addon domains)

On cPanel, addon domains and subdomains are often served from folders **inside** the main site's `public_html`, for example `~/public_html/shop.example.org`. Each time it connects, the add-on finds these by looking for other WordPress installs and for cPanel docroots inside the linked site's folder. It excludes them from every transfer and comparison. A push with "delete files on Bluehost" can therefore never remove another site, and a pull never downloads one. The linked site's panel lists them under **Never synced**.

### What a database push does

1. Exports the Local database and rewrites MySQL 8 `utf8mb4_0900_*` collations to ones MariaDB and older MySQL accept.
2. On Bluehost, saves the current database to `local-backup-before-push.sql` in a private `~/.bluehost-connect` folder. The folder is outside `public_html` and readable only by your account. The add-on also reads the current `home` URL and `table_prefix`.
3. Uploads the dump to that folder, then runs `wp db reset` and `wp db import`. If the import fails, it restores the backup automatically. The uploaded dump is always deleted afterwards.
4. Sets `table_prefix` to match Local if the two differ.
5. Runs `wp search-replace` across all tables (`--precise`, `guid` skipped) from `//site.local` to the Bluehost URL, including the JSON-escaped form, plus `http://` → `https://` when the Bluehost site uses HTTPS.

### What a database pull does

1. On Bluehost, exports the database with `--single-transaction` (the live site isn't locked), downloads it and deletes the export.
2. Makes the dump importable by Local's MySQL. It removes the MariaDB "sandbox mode" line and rewrites `uca1400` collations.
3. Saves the Local database to `app/sql/local-backup-before-pull.sql` (optional).
4. Imports through Local's own WP-CLI service. If the import fails, it restores the backup.
5. Matches Local's `table_prefix` to Bluehost's, then replaces the Bluehost URL, and any other domain served from the same folder, with the Local URL.

### What is never transferred

These paths are excluded in both directions, and excluded paths are also protected from `--delete`:

- Environment config: `wp-config.php`, `.htaccess`, `.user.ini`, `php.ini`, and the copies Bluehost keeps beside them (`wp-config.php.bak`, which contains the database password, and `.htaccess.nfd-backup`), plus `wp-cli.yml` and `nfd-private/`
- cPanel files: `cgi-bin/`, `.well-known/` (AutoSSL validation), `error_log` files, `.ftpquota`
- Caches and host drop-ins: `object-cache.php`, `advanced-cache.php`, `wp-content/cache/`, `wp-content/newfold-page-cache/`, `wp-content/endurance-page-cache/`, `mu-plugins/endurance-*`, Bluehost's `mu-plugins/sso.php`, WP Cloud's `wpcomsh` loader
- Server-specific state: `wp-content/jetpack-waf/` (firewall rules with absolute server paths) and `wp-content/upgrade/`
- Other sites nested inside the linked site's folder (see above)
- VCS and tool binaries, root-level `*.sql` dumps, Local's helper files

Must-use plugins that exist only on the receiving side are never deleted. Bluehost installs its own there.

### Bluehost Cloud: platform-managed core and plugins

WP Cloud doesn't keep WordPress core in the site folder: `/srv/htdocs/__wp__` links to a shared core, and some plugins, themes and drop-ins link to a shared store (`/wordpress/plugins/...`). Each time it connects, the add-on finds links that resolve outside the site and treats them as **platform-managed**:

- **WordPress core** (`__wp__`, `wp-admin/`, `wp-includes/`, root `wp-*.php` and `index.php`) is excluded in both directions. Local keeps its own core and the server keeps its shared one. After a database pull, a banner warns if the two WordPress versions differ.
- **Managed plugins and themes** come down to Local as real files on a pull. A push never replaces them, so the platform keeps updating them.
- A database pull first checks that the Local site still has WordPress core. If it doesn't, the pull stops before changing the database.

### Themes and plugins symlinked from elsewhere

A theme or plugin that you develop in another folder and symlink into the Local site (for example `wp-content/themes/mytheme → ~/code/mytheme`) is **pushed as real files**, because the server has no such folder to point to. It is **never pulled into**: a pull leaves the symlink and the folder it points to untouched, so server copies can't overwrite or delete your working files. Symlinks within the site stay symlinks, and broken symlinks are skipped (and logged).

To skip more, add rsync patterns (one per line) to `app/public/.bluehost-push-ignore` or `.bluehost-pull-ignore`. These work like `.wpe-push-ignore` and `.wpe-pull-ignore`.

## Security notes

- **Secrets:** any stored SSH password is encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows). It is stored in `<Local data>/bluehost-connect/settings.json` and never sent to the renderer. With the default "add Local's SSH key" option, no password is stored at all.
- **SSH key and known hosts:** the add-on keeps its own RSA key in `<Local data>/bluehost-connect/ssh/`, separate from Local's WP Engine key and from the other Host Connect add-ons' keys. It also keeps its own `known_hosts` file, which pins each server's host key on first connect.
- **Passwords:** SSH passwords go to `ssh` through `SSH_ASKPASS` and an environment variable. They are never put in argv or written to disk.
- **Removing access:** when you disconnect the account, you can also remove the add-on's key from `authorized_keys`. The key stays if a linked site still uses it.
- **What the add-on writes on the server:** a line in `~/.ssh/authorized_keys` (shared, password option), a private `~/.bluehost-connect` folder for dumps and backups, and, only when the server has no WP-CLI, `~/.bluehost-connect/wp-cli.phar`, downloaded from the official WP-CLI builds.

## Verified on a live account

Tested on 2026-10-31 against a real Bluehost shared account (cPanel, jailshell, PHP 8.5, WP-CLI 2.9, rsync 3.2.7, MySQL 8.0) that has six WordPress sites, all but one in `~/public_html/website_*` folders inside the main site. The tests drove the add-on's own code with Local's side stubbed:

- **Site listing:** found all six sites with their domains, temporary `*.mybluehost.me` addresses and subfolder home URLs.
- **Nested-site protection:** discovery on the main site found all five `website_*` sites inside it.
- **Pull** (388 MB, 20,000 files, 29 s): every host-managed file stayed on the server. The subfolder URL and the temporary subdomain were both replaced, and the remote dump was cleaned up.
- **Compare:** no differences right after the pull.
- **Files push** with deletion on (7 s): only the new file changed; host files and mu-plugins were untouched.
- **Database push** (8 s): import, prefix check, URL replacement and the Newfold cache purge worked. The new site title showed on the live page immediately.

Bluehost **rate-limits new SSH connections**: after a few dozen logins in a few minutes, port 22 refuses connections for a while. Every push, pull and comparison therefore runs over **one** shared SSH connection (OpenSSH `ControlMaster`). The end-to-end test asserts that a full push logs in exactly once.

## Limitations and what is not verified

- **Not yet run inside Local itself.** The live tests above stubbed Local's database and WP-CLI services; the end-to-end test uses a local `sshd`. Try the Tools panel, header buttons and "Pull from Bluehost" wizard in a running Local before relying on them.
- **Still to confirm on other shared accounts:**
  - the exact message a shell-less account prints;
  - older (pre-`website_*`) account layouts;
  - whether the `php` on `PATH` matches the site's PHP version, which only matters if the WP-CLI fallback is used (the tested server already had `wp`).
- **Bluehost Cloud** has been inspected on a live site (layout, managed links, WP-CLI, rsync), and its layout is covered by the end-to-end test, but a full push to a live Cloud site hasn't been run yet. Its edge cache is not purged beyond `wp cache flush`.
- **No hosting backups.** Bluehost has no public API to trigger a backup, so only the database is backed up before a push. Take a backup in the Bluehost Portal before a first push of files with deletion on.
- **Multisite:** the domain columns in `wp_blogs` and `wp_site` are not rewritten.
- **Windows:** password auth is not supported (use the SSH key option), and nothing has been tested on Windows.

## Development

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run lint
```

- `npm test` runs the unit, main-process and renderer tests. They cover:
  - the site listing (cPanel domain parsing, `/home` vs `/home2` paths);
  - the `authorized_keys` install and removal scripts, run in a fake home;
  - the remote discovery script, including nested addon sites, private-folder placement and strict remote paths;
  - dump normalization and URL replacement pairs;
  - rsync itemize parsing and merging;
  - encrypted storage;
  - the main-process IPC handlers with Local's API and SSH mocked;
  - the React UI mounted in jsdom with the real `@getflywheel/local-components`.
- `npm run test:e2e` starts an unprivileged `sshd` on 127.0.0.1 with a fake `wp` and a cPanel-like home. Through Local's bundled `rsync`/`ssh`, it runs:
  - a full files + database push;
  - a full pull;
  - a comparison, a selective push and a selective pull;
  - a checksum compare.

```
lib/
  main.js                  add-on main process: IPC handlers, account and linking flow
  main/bluehostAccount.js  site listing, cPanel domain parsing, authorized_keys install/removal
  main/SyncService.js      push and pull orchestration (discovery, files, database, search-replace, cache)
  main/transport.js        rsync/ssh runner using Local's bundled binaries, key or password auth
  main/sshKey.js           RSA key pair in OpenSSH format
  main/store.js            settings + encrypted secrets
  main/updater.js          checks GitHub releases and installs updates through Local's add-on installer
  renderer.js              hooks: Tools → Bluehost tab, header pull/push buttons, create-site option, stylesheet
  renderer/components.js   React UI (plain React.createElement, no build step)
```

## Releasing

See [RELEASING.md](RELEASING.md). In short: commit to `main`, then run `npm run release -- patch` (or `minor`/`major`).
