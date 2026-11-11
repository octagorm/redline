# Chrome Web Store listing

Everything to paste into the developer dashboard
(https://chrome.google.com/webstore/devconsole). Images are in this folder.

## Upload

`npm run zip` builds `redline.zip` from `manifest.json`, `src/` and `icons/`.
Bump `version` in `manifest.json` before each new upload.

## Store listing tab

**Name** (from the manifest): Redline

**Summary** (from the manifest, max 132 characters):
Highlights, word by word, how a page differs from the same page on another site, such as your dev server against production.

**Description:**

Redline shows what you changed on a website while you read it.

Pair the site you are working on (say http://localhost:3000) with the site to compare it with (say your live site, or a second local server running the main branch). Then turn Redline on in a tab with the toolbar button, Alt+Shift+R, or ?redline in the address:

• New and changed words are highlighted where they stand.
• Removed paragraphs are marked with a dashed red line.
• Press B to see the other site's wording instead, with removed words struck through.
• Press J and K to jump to the next and previous change.
• The badge counts the changed blocks.

It stays on in the tab as you click around, including in single-page apps.

Redline compares the text both servers send, so a clock or a "3 minutes ago" drawn in the browser never shows up as a change. Sites behind a login work as long as you are signed in to them. Each pair can ignore parts of the page (menus, footers, footnote numbers) with a CSS selector.

Redline has no servers, analytics or accounts. It only talks to the sites you pair, and only asks for access to those. Open source: https://github.com/octagorm/redline

**Category:** Developer Tools

**Language:** English

**Graphic assets:**
- Store icon: `../icons/128.png`
- Screenshots (1280×800): `screenshot-1-after.png`, `screenshot-2-before.png`
- Small promo tile (440×280): `promo-440x280.png`

To remake the screenshots: `STORE=1 npm test` (writes `after.png` and
`before.png` here), and open `tile.html` at 440×280 for the tile.

**Homepage URL:** https://github.com/octagorm/redline

**Support URL:** https://github.com/octagorm/redline/issues

## Privacy practices tab

**Single purpose:**
Compare the page in the current tab with the same page on another site the user has chosen, and highlight the differences in the text.

**Permission justifications:**

- `storage`: Saves the user's pairs of sites to compare, and their ignore rules.
- `scripting`: Runs the comparison script on the sites the user has added, and in a tab that was open before a site was added.
- `activeTab`: Lets the toolbar button turn the comparison on in the current tab.
- Host permissions (optional, requested per site): Redline needs to read the pages of the site the user is working on and fetch the same pages from the site they compare it with. It asks for access to exactly the sites the user enters in its settings, at the moment they save them.

**Remote code:** No, I am not using remote code. (All code is in the package. Fetched pages are parsed as inert HTML; their scripts never run.)

**Data usage:** tick none of the data types. Redline reads "website content" only locally to compare it and never collects or transmits it. Then tick all three certifications (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** https://github.com/octagorm/redline/blob/main/PRIVACY.md

## Distribution tab

Visibility: Public. Regions: all.
