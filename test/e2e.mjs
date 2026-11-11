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
    document.querySelector("main").innerHTML = "<h1>About</h1><p>We make clocks that show the sky.</p>";
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
  "/about": page(`<main><h1>About</h1><p>We make clocks.</p></main>`),
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
  "/about": page(`<main><h1>About</h1><p>We make clocks that show the sky.</p></main>`),
  "/fresh": page(`<main><h1>Fresh page</h1><p>Only on dev.</p></main>`),
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
  await tab.screenshot({ path: path.join(out, "after.png") });

  // B shows the reference's wording with removed words struck through.
  await tab.keyboard.press("b");
  const struck = await tab.$$eval(".redline-old del", (d) => d.map((x) => x.textContent));
  assert.ok(struck.includes("drawn"), "the old word is struck through");
  assert.ok(await tab.isVisible("text=This paragraph is going away"));
  await tab.screenshot({ path: path.join(out, "before.png") });
  await tab.keyboard.press("b");

  // It stays on across navigation, and follows client-side navigation.
  await tab.click("#about");
  console.log("after client-side nav:", await waitBadge(/^1 change\b/));
  assert.deepEqual(
    await tab.$$eval("mark.redline-new", (m) => m.map((x) => x.textContent)),
    ["clocks that show the sky."]
  );

  // A page the reference does not have is new from top to bottom.
  await tab.goto(DEV + "/fresh");
  console.log("404 page:", await waitBadge(/change/));
  assert.equal(await tab.$$eval("[data-redline-new]", (e) => e.length), 2);

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
  console.log("\nall checks passed; screenshots in test/out/");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await context.close();
  devServer.close();
  refServer.close();
}
process.exit(failed ? 1 : 0);
