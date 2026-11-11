# Redline

Chrome extension (MV3, no build step): `src/` is loaded as is.

- `npm test` runs the end-to-end test in Playwright's Chromium; run it before
  every commit. `node test/live.mjs <this site> <compare with> <path>` tries
  real sites.
- Versioning: bump `version` in `manifest.json` and `package.json` only when a
  build is uploaded to the Chrome Web Store, not per change. Patch for fixes,
  minor for features. The store needs each upload to have a higher version.
- `npm run zip` builds `redline.zip` for upload; `store/LISTING.md` has the
  listing text.
