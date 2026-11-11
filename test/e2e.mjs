// End-to-end test: loads the extension into Chromium, serves a "dev" site on
// localhost and a "reference" site on 127.0.0.1 (a different site, so cookies
// are not shared), and checks what Redline marks.
//
//   npm test            headless
//   HEADED=1 npm test   watch it
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, process.env.STORE ? "store" : "test/out");
fs.mkdirSync(out, { recursive: true });

const page = (body, clock = "12:00:00") => `<!doctype html><html><head>
<style>body{font:16px/1.6 Georgia,serif;max-width:640px;margin:40px auto;padding:0 16px;background:#faf8f3;color:#222}${process.env.STORE ? "html{zoom:1.6}" : ""}</style>
</head><body>
<nav><a href="/">Home</a> <a href="/about" id="about">About</a></nav>
<p class="clock">It is <span id="clock">${clock}</span>.</p>
${body}
<footer><p>Footer ${clock}</p></footer>
<script>
  // Drawn in the browser, so it never matches the server HTML. Redline diffs
  // the text both servers send, so it needs no ignore rule for this.
  document.getElementById("clock").textContent = new Date().toISOString();
  // Client-side navigation, as an app router would do it.
  document.getElementById("about").onclick = (e) => {
    e.preventDefault();
    history.pushState({}, "", "/about");
    document.querySelector("main").innerHTML = "<h1>About</h1><p>We make clocks that show the sky.</p><h2>Makers</h2>";
  };
</script>
</body></html>`;

const reference = {
  "/": page(`<main>
<h1>The Sky Clock</h1>
<p>A clock that shows the sky above you, drawn every second.</p>
<p>This paragraph is going away entirely in the new version of the page.</p>
<p>Unchanged text stays as it is<sup>1</sup>.</p>
<ul><li>First item</li><li>Second item</li></ul>
</main>`),
  // A paragraph removed just before a heading must still look like one.
  "/about": page(`<main><h1>About</h1><p>We make clocks.</p><p class="lead">We also repair them.</p><h2>Makers</h2></main>`),
  "/gone": page(`<main><h1>Gone</h1><p>Only on the reference.</p></main>`),
};
const dev = {
  "/": page(`<main>
<h1>The Sky Clock</h1>
<p>A clock that shows the whole sky above you, redrawn every second.</p>
<p>Unchanged text stays as it is<sup>2</sup>.</p>
<p>A brand new paragraph about astrolabes and their makers.</p>
<ul><li>First item</li><li>Second item</li></ul>
</main>`),
  // What the client-side navigation below draws, as the server would send it.
  "/about": page(`<main><h1>About</h1><p>We make clocks that show the sky.</p><h2>Makers</h2></main>`),
  "/fresh": page(`<main><h1>Fresh page</h1><p>Only on dev.</p></main>`),
  // Sitemaps often name the production address even on a preview.
  "/sitemap.xml": `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/about", "/fresh", "/gone"]
    .map((p) => `<url><loc>https://example.com${p}</loc></url>`)
    .join("")}</urlset>`,
};

function serve(pages, port, needCookie) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (needCookie && !/(^|;\s*)gate=open/.test(req.headers.cookie ?? "")) {
      res.writeHead(401).end("no cookie");
      return;
    }
    const body = pages[url.pathname];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body ?? "not found");
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

// A preview build that names its reference itself, so it needs no setup. It
// is served from a folder, as GitHub Pages PR previews are.
const preview = {
  "/pr-preview/pr-5/": dev["/"].replace(
    "<head>",
    `<head><meta name="redline" content="http://127.0.0.1:47312"><meta name="redline-root" content="/pr-preview/pr-5/"><meta name="redline-ignore" content="nav, footer, sup">`
  ),
};
const previewServer = await serve(preview, 47313, false);
// A huge site: a sitemap index naming 6,000 pages, two of which changed.
function bigSite(port, changed) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const xml = (body) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?>${body}`);
    };
    if (url.pathname === "/sitemap.xml")
      return xml(`<sitemapindex>${[0, 1, 2].map((k) => `<sitemap><loc>http://localhost:${port}/sitemap-${k}.xml</loc></sitemap>`).join("")}</sitemapindex>`);
    const m = url.pathname.match(/^\/sitemap-(\d)\.xml$/);
    if (m)
      return xml(`<urlset>${Array.from({ length: 2000 }, (_, i) => `<url><loc>https://big.example/p/${m[1] * 2000 + i}</loc></url>`).join("")}</urlset>`);
    const n = url.pathname.match(/^\/p\/(\d+)$/)?.[1];
    // Slow enough to stop halfway through a batch.
    setTimeout(() => {
    res.writeHead(n ? 200 : 404, { "content-type": "text/html" });
    res.end(n ? `<!doctype html><title>${n}</title><p>Page ${n} says ${changed && ["5", "3000"].includes(n) ? "something new" : "the same thing"}.</p>` : "not found");
    }, 15);
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}
const bigDev = await bigSite(47314, true);
const bigRef = await bigSite(47315, false);
const devServer = await serve(dev, 47311, false);
const refServer = await serve(reference, 47312, true);
const DEV = "http://localhost:47311";
const REF = "http://127.0.0.1:47312";

// A copy of the extension with the two test hosts granted up front, since the
// permission prompt cannot be clicked from a test.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "redline-ext-"));
fs.cpSync(path.join(root, "src"), path.join(ext, "src"), { recursive: true });
fs.cpSync(path.join(root, "icons"), path.join(ext, "icons"), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
manifest.host_permissions = ["http://localhost/*", "http://127.0.0.1/*"];
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(os.tmpdir(), "redline-profile-")),
  {
    channel: "chromium",
    headless: !process.env.HEADED,
    // STORE=1 makes the screenshots the Chrome Web Store's size.
    viewport: process.env.STORE ? { width: 1280, height: 800 } : { width: 900, height: 900 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  }
);
let failed = false;
try {
  const sw =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await sw.evaluate(
    (pairs) => chrome.storage.sync.set({ pairs }),
    [{ from: DEV, to: REF, ignore: "nav, footer, sup", blocks: "" }]
  );
  // The reference wants a cookie; the user has one from signing in there.
  await context.addCookies([
    { name: "gate", value: "open", url: REF, sameSite: "Lax" },
  ]);
  // Give the worker a moment to register the content script.
  await new Promise((r) => setTimeout(r, 500));

  const tab = await context.newPage();
  const badge = () =>
    tab.evaluate(
      () =>
        document.querySelector("#redline-host")?.shadowRoot?.querySelector(".b")
          ?.innerText ?? null
    );
  const waitBadge = async (re) => {
    for (let i = 0; i < 60; i++) {
      const t = await badge();
      if (t && re.test(t)) return t;
      await tab.waitForTimeout(100);
    }
    throw new Error(`badge never matched ${re}; it says: ${await badge()}`);
  };

  // Off by default.
  await tab.goto(DEV + "/");
  await tab.waitForTimeout(800);
  assert.equal(await badge(), null, "Redline stays off until asked");

  // ?redline turns it on.
  await tab.goto(DEV + "/?redline");
  console.log("badge:", await waitBadge(/change/));
  const marks = await tab.$$eval("mark.redline-new", (m) => m.map((x) => x.textContent));
  console.log("new words:", marks);
  assert.deepEqual(marks, ["whole", "redrawn"]);
  assert.equal(
    await tab.$$eval("[data-redline-new]", (e) => e.map((x) => x.textContent).join("|")),
    "A brand new paragraph about astrolabes and their makers."
  );
  assert.equal(await tab.$$eval(".redline-removed", (e) => e.length), 1, "one removed block");
  assert.match(await badge(), /3 changes/);
  const visibleText = (sel) =>
    tab.$$eval(sel, (els) =>
      els.filter((e) => e.getClientRects().length).map((e) => e.textContent.trim())
    );
  const changed = () =>
    tab.$eval("p[data-redline-changed]", (p) => p.innerText.replace(/\s+/g, " "));

  // "all", the default: removed words struck through beside the new ones, and
  // the removed paragraph shown in full.
  assert.deepEqual(await visibleText(".redline-gone del"), ["drawn"]);
  assert.equal(
    await changed(),
    "A clock that shows the whole sky above you, drawn redrawn every second."
  );
  assert.ok(await tab.isVisible("text=This paragraph is going away"));
  await tab.screenshot({ path: path.join(out, "all.png") });

  // B: "added", only what is new; the removed paragraph is a dashed line.
  await tab.keyboard.press("v");
  assert.deepEqual(await visibleText(".redline-gone del"), []);
  assert.equal(
    await changed(),
    "A clock that shows the whole sky above you, redrawn every second."
  );
  assert.ok(
    (await tab.$eval(".redline-removed", (e) => e.offsetHeight)) <= 2,
    "the removed paragraph is only a line"
  );
  await tab.screenshot({ path: path.join(out, "added.png") });

  // B: "removed", the reference's wording with removed words struck through.
  await tab.keyboard.press("v");
  const struck = await visibleText(".redline-old del");
  assert.ok(struck.includes("drawn"), "the old word is struck through");
  assert.ok(await tab.isVisible("text=This paragraph is going away"));
  assert.ok(!(await tab.isVisible("text=A brand new paragraph")));
  await tab.screenshot({ path: path.join(out, "removed.png") });

  // B again: back to "all", and the mode sticks across page loads.
  await tab.keyboard.press("v");
  await tab.keyboard.press("v");
  await tab.reload();
  await waitBadge(/change/);
  assert.equal(
    await tab.evaluate(() => document.documentElement.classList.contains("redline-added")),
    true,
    "mode remembered"
  );
  await tab.keyboard.press("v");
  await tab.keyboard.press("v");

  // It stays on across navigation, and follows client-side navigation.
  await tab.click("#about");
  console.log("after client-side nav:", await waitBadge(/^2 changes\b/));
  assert.deepEqual(
    await tab.$$eval("mark.redline-new", (m) => m.map((x) => x.textContent)),
    ["clocks that show the sky."]
  );
  assert.deepEqual(
    await tab.$eval(".redline-removed", (e) => [e.tagName, e.classList.contains("lead"), e.textContent]),
    ["P", true, "We also repair them."],
    "a removed paragraph is a paragraph, not the heading it sits beside"
  );

  // A page the reference does not have is new from top to bottom.
  await tab.goto(DEV + "/fresh");
  console.log("404 page:", await waitBadge(/change/));
  assert.equal(await tab.$$eval("[data-redline-new]", (e) => e.length), 2);

  // Review: approve, reject and note changes; they stay after a reload.
  await tab.goto(DEV + "/");
  await waitBadge(/change/);
  const toolsRoot = `document.querySelector("#redline-tools").shadowRoot`;
  await tab.hover("p[data-redline-changed]");
  await tab.waitForFunction(`!!document.querySelector("#redline-tools")`);
  await tab.evaluate(`${toolsRoot}.querySelector(".ok").click()`);
  await tab.waitForFunction(`document.querySelector("p[data-redline-changed]").getAttribute("data-redline-review") === "ok"`);
  await tab.hover("p[data-redline-new]");
  await tab.keyboard.press("x");
  await tab.waitForFunction(`document.querySelector("p[data-redline-new]").getAttribute("data-redline-review") === "no"`);
  // X moved the toolbar on to the change still to review, the removed paragraph.
  await tab.waitForTimeout(200);
  assert.equal(
    await tab.evaluate(() => document.querySelector("#redline-tools") && getComputedStyle(document.querySelector(".redline-removed")).display !== "none"),
    true
  );
  await tab.mouse.move(5, 5);
  await tab.hover("p[data-redline-new]");
  await tab.keyboard.press("c");
  await tab.waitForTimeout(100);
  await tab.keyboard.type("Too vague; name a maker.");
  await tab.evaluate(`${toolsRoot}.querySelector(".suggest").click()`);
  await tab.evaluate(`(() => { const t = ${toolsRoot}.querySelector("[name=suggestion]"); t.value = "A new paragraph about Jost Bürgi's astrolabes."; })()`);
  await tab.evaluate(`${toolsRoot}.querySelector("form").requestSubmit()`);
  await tab.waitForFunction(`document.querySelector("p[data-redline-new]").hasAttribute("data-redline-noted")`);
  console.log("reviewed:", await badge());
  assert.match(await badge(), /1 to review/);
  assert.match(await badge(), /1 ✓ 1 ✗ 1 ✎/);
  assert.match(await badge(), /copy notes \(1\)/);
  await tab.screenshot({ path: path.join(out, "review.png") });
  const notes = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith("review:"));
  });
  const md = await tab.evaluate(async () => {
    const pairs = (await chrome.storage?.sync?.get?.("pairs"))?.pairs;
    return null;
  });
  void md;
  const markdown = await sw.evaluate(async (key) => {
    const data = (await chrome.storage.local.get(key))[key];
    return JSON.stringify(Object.values(data.entries).map((e) => [e.state, e.kind, e.note ?? "", e.suggestion ?? ""]));
  }, notes.find((k) => k.includes("47311")));
  console.log("stored reviews:", markdown);
  assert.deepEqual(JSON.parse(markdown).sort(), [
    ["no", "new", "Too vague; name a maker.", "A new paragraph about Jost Bürgi's astrolabes."],
    ["ok", "changed", "", ""],
  ].sort());
  await tab.reload();
  await waitBadge(/change/);
  assert.equal(await tab.getAttribute("p[data-redline-changed]", "data-redline-review"), "ok", "reviews last");

  // The note form stays inside a narrow window, and tooltips show at once.
  await tab.setViewportSize({ width: 560, height: 700 });
  await tab.hover("p[data-redline-new]");
  await tab.waitForFunction(`!!document.querySelector("#redline-tools")`);
  await tab.keyboard.press("c");
  await tab.evaluate(`${toolsRoot}.querySelector(".suggest").click()`);
  await tab.waitForTimeout(100);
  const box = await tab.evaluate(() => {
    const r = document.querySelector("#redline-tools").getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight };
  });
  console.log("note form:", JSON.stringify(box));
  assert.ok(box.left >= 0 && box.right <= box.w && box.top >= 0 && box.bottom <= box.h, "the note form is on screen");
  await tab.screenshot({ path: path.join(out, "note-narrow.png") });
  await tab.keyboard.press("Escape");
  const okBox = await tab.evaluate(() => {
    const b = document.querySelector("#redline-tools").shadowRoot.querySelector(".ok").getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  });
  await tab.mouse.move(okBox[0], okBox[1]);
  const tip = await tab.evaluate(() =>
    getComputedStyle(document.querySelector("#redline-tools").shadowRoot.querySelector(".ok"), "::after").content
  );
  assert.match(tip, /Approve/);
  await tab.setViewportSize({ width: 900, height: 900 });

  // "pages" lists which pages of the site differ, from the sitemap.
  const pagesList = async () => {
    for (let i = 0; i < 60; i++) {
      const t = await tab.evaluate(() => document.querySelector("#redline-host").shadowRoot.querySelector(".ptitle").textContent);
      if (/differ/.test(t)) break;
      await tab.waitForTimeout(100);
    }
    return tab.evaluate(() =>
      [...document.querySelector("#redline-host").shadowRoot.querySelectorAll(".panel li")].map(
        (li) => li.innerText.replace(/\s+/g, " ")
      )
    );
  };
  await tab.goto(DEV + "/");
  await waitBadge(/change/);
  await tab.evaluate(() =>
    document.querySelector("#redline-host").shadowRoot.querySelector(".pages").click()
  );
  const listed = await pagesList();
  console.log("pages:", listed);
  await tab.screenshot({ path: path.join(out, "pages.png") });
  assert.deepEqual(listed, ["/ 1 to review · 1 ✓ 1 ✗ 1 ✎", "/about 2 to review", "/fresh new page", "/gone removed page"]);
  // Reviewing the last change updates the open list at once.
  await tab.hover(".redline-removed");
  await tab.keyboard.press("a");
  await tab.waitForFunction(() =>
    [...document.querySelector("#redline-host").shadowRoot.querySelectorAll(".panel li")].some((li) =>
      /^\/\s+2 ✓ 1 ✗ 1 ✎$/.test(li.innerText.replace(/\s+/g, " ").replace(/^\/ /, "/ "))
    )
  );

  // A huge site: checks a batch at a time, nearest first, and says how much
  // it has checked.
  await sw.evaluate(async () => {
    const { pairs } = await chrome.storage.sync.get("pairs");
    pairs.push({ from: "http://localhost:47314", to: "http://localhost:47315", ignore: "", blocks: "" });
    await chrome.storage.sync.set({ pairs });
  });
  await tab.waitForTimeout(300);
  await tab.goto("http://localhost:47314/p/5?redline");
  console.log("big site page:", await waitBadge(/change/));
  const shadow = (sel) => `document.querySelector("#redline-host").shadowRoot.querySelector(${JSON.stringify(sel)})`;
  const started = Date.now();
  await tab.keyboard.press("p"); // P opens the pages list
  await tab.waitForFunction(`${shadow(".pnote")}.textContent.startsWith("checked")`, null, { timeout: 30000 });
  const note = await tab.evaluate(`${shadow(".pnote")}.textContent`);
  console.log("big site:", await tab.evaluate(`${shadow(".ptitle")}.textContent`), "|", note, "|", await tab.evaluate(`${shadow(".more")}.textContent`), `| ${Date.now() - started} ms`);
  assert.match(note, /^checked 100 of 6,000\+? pages, nearest this one first/);
  assert.deepEqual(await pagesList(), ["/p/5 1 to review"], "the current page is checked first");
  await tab.evaluate(`${shadow(".more")}.click()`);
  await tab.waitForFunction(`${shadow(".pnote")}.textContent.startsWith("checked 200")`, null, { timeout: 30000 });
  // Stop halfway through a batch keeps what was compared.
  await tab.evaluate(`${shadow(".more")}.click()`);
  await tab.waitForTimeout(150);
  await tab.evaluate(`${shadow(".stop")}.click()`);
  await tab.waitForFunction(`${shadow(".pnote")}.textContent.startsWith("checked")`, null, { timeout: 30000 });
  const stoppedAt = await tab.evaluate(`${shadow(".pnote")}.textContent`);
  console.log("after stop:", stoppedAt);
  assert.match(stoppedAt, /^checked (2\d\d) of/);

  // hide turns it off and puts the page back.
  await tab.goto(DEV + "/");
  await waitBadge(/change/);
  await tab.evaluate(() =>
    document.querySelector("#redline-host").shadowRoot.querySelector(".off").click()
  );
  assert.equal(await tab.$$eval("mark, .redline-old, [data-redline-new]", (e) => e.length), 0);
  await tab.reload();
  await tab.waitForTimeout(800);
  assert.equal(await badge(), null, "stays off after hide");

  // A site with a <meta name="redline"> tag: pressing the button sets up the
  // pair from the tag and starts.
  // An old pair for the same address points at another site, as when a
  // second project runs on the same localhost port. The tag must win.
  await sw.evaluate(async () => {
    const { pairs } = await chrome.storage.sync.get("pairs");
    pairs.push({ from: "http://localhost:47313/pr-preview/pr-5", to: "http://127.0.0.1:47399", ignore: "", blocks: "" });
    await chrome.storage.sync.set({ pairs });
  });
  await tab.goto("http://localhost:47313/pr-preview/pr-5/");
  await tab.waitForTimeout(500);
  await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: "http://localhost:47313/*" });
    await self.onAction(t);
  });
  console.log("from the meta tag:", await waitBadge(/change/));
  const saved = await sw.evaluate(async () => (await chrome.storage.sync.get("pairs")).pairs);
  assert.ok(
    saved.some(
      (p) => p.from === "http://localhost:47313/pr-preview/pr-5" && p.to === "http://127.0.0.1:47312" && p.ignore === "nav, footer, sup"
    ),
    "the pair from the tag is saved"
  );
  assert.ok(!saved.some((p) => p.to === "http://127.0.0.1:47399"), "the old pair is replaced");
  assert.deepEqual(
    await tab.$$eval("mark.redline-new", (m) => m.map((x) => x.textContent)),
    ["whole", "redrawn"]
  );
  // No sitemap here: it follows links, but stays inside the preview's folder.
  await tab.evaluate(() =>
    document.querySelector("#redline-host").shadowRoot.querySelector(".pages").click()
  );
  const crawled = await pagesList();
  console.log("crawled pages:", crawled);
  assert.deepEqual(crawled, ["/ 3 to review"]);
  console.log("\nall checks passed; screenshots in test/out/");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await context.close();
  devServer.close();
  bigDev.close();
  bigRef.close();
  previewServer.close();
  refServer.close();
}
process.exit(failed ? 1 : 0);
