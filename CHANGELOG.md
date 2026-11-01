# Changelog

What changed in each release of ConnectLocal for Bluehost. Add new notes under **Unreleased**; `npm run release`
turns that section into the new version's entry and uses it as the GitHub release notes.

## Unreleased

## 1.1.0 - 2026-10-31

- Renamed to ConnectLocal for Bluehost.
- Update checks now work. The add-on looks for new releases on GitHub when Local starts and every 12 hours, and
  shows an **Update** button in its panel when one is out.
- If you installed 0.1.0 from the website, install this version once by hand (**Add-ons → Install from disk**).
  Later updates arrive in the add-on.

## 0.1.0 - 2026-10-31

- First release.
- Push a Local site's files, database, or both to Bluehost shared hosting or Bluehost Cloud over SSH.
- Pull them back into an existing Local site, or into a brand-new Local site.
- Compare files on both sides and push or pull only the ones you pick.
- Find every WordPress install in the account. With a cPanel password, the add-on installs its own SSH key and stops
  storing the password.
- Export the remote database before every database push, and clear WordPress and Bluehost caches after pushing.
