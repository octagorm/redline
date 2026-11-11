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

• New words are highlighted, and removed words are struck through right where they were.
• Press V to switch views: all changes, only what was added, or only what was removed.
• Press J and K to jump to the next and previous change.
• Review as you go: approve (A) or reject (X) each change, or add a note or suggested wording (C). The badge shows how many changes are still to review.
• "Copy notes" puts all your rejections, notes and suggested wording on the clipboard as one clear list, ready to paste to a colleague or an AI assistant.
• "Pages" (P) lists every page of the site that differs, including new and removed pages, with each page's review progress. It checks pages on request, a batch at a time, so it is gentle on big sites.

It stays on in the tab as you click around, including in single-page apps.

Sites can set it up for their visitors: a preview build with <meta name="redline" content="https://your-production-site"> needs no settings at all, just a click on the button. That works for Vercel, Netlify and Cloudflare previews, and for GitHub Pages PR previews served from a folder.

Redline compares the text both servers send, so a clock or a "3 minutes ago" drawn in the browser never shows up as a change. Sites behind a login work as long as you are signed in to them. Each pair can ignore parts of the page (menus, footers, footnote numbers) with a CSS selector.

Redline has no servers, analytics or accounts. It only talks to the sites you pair, and only asks for access to those. Open source: https://github.com/octagorm/redline

**Category:** Developer Tools

**Language:** English

**Graphic assets:**
- Store icon: `../icons/128.png`
- Screenshots (1280×800), in this order: `screenshot-1-all.png`,
  `screenshot-2-review.png`, `screenshot-3-pages.png`, `screenshot-4-removed.png`
- Small promo tile (440×280): `promo-440x280.png`

To remake the screenshots: `STORE=1 npm test` (writes `all.png`, `review.png`,
`pages.png` and `removed.png` here; rename them), and open `tile.html` at
440×280 for the tile.

**Homepage URL:** https://github.com/octagorm/redline

**Support URL:** https://github.com/octagorm/redline/issues

## Privacy practices tab

**Single purpose:**
Compare the page in the current tab with the same page on another site the user has chosen, and highlight the differences in the text.

**Permission justifications:**

- `storage`: Saves the user's pairs of sites to compare, their ignore rules, and their reviews of changes (approved, rejected, notes), in the browser only.
- `scripting`: Runs the comparison script on the sites the user has added, in a tab that was open before a site was added, and reads a page's <meta name="redline"> tag when the user clicks the toolbar button.
- `activeTab`: Lets the toolbar button turn the comparison on in the current tab.
- Host permissions (optional, requested per site): Redline needs to read the pages of the site the user is working on and fetch the same pages from the site they compare it with. It asks for access to exactly the two sites of a pair, when the user saves the pair or accepts the pair a page suggests.

**Remote code:** No, I am not using remote code. (All code is in the package. Fetched pages are parsed as inert HTML; their scripts never run.)

**Data usage:** tick none of the data types. Redline reads "website content" only locally to compare it and never collects or transmits it. Then tick all three certifications (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** https://github.com/octagorm/redline/blob/main/PRIVACY.md

## Distribution tab

Visibility: Public. Regions: all.
