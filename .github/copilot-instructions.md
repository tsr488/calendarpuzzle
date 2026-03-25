# Copilot Instructions

## Version Bumps

When bumping the version, update **both** of these files:

- `js/version.js` — the `APP_VERSION` constant
- `sw.js` — the `CACHE_NAME` string (e.g. `'calpuzzle-v0.7.5'`)

Both must stay in sync for the service worker cache to bust correctly.
