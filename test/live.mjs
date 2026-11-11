// Tries Redline on a real pair of sites and saves screenshots.
//   node test/live.mjs <this site> <compare with> <path> [ignore selector]
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [from, to, page = "/", ignore = "nav, footer"] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "test", "out");
fs.mkdirSync(out, { recursive: true });
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "redline-ext-"));
for (const d of ["src", "icons"]) fs.cpSync(path.join(root, d), path.join(ext, d), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
manifest.host_permissions = [from, to].map((u) => { const x = new URL(u); return `${x.protocol}//${x.hostname}/*`; });
fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "redline-p-")), {
  channel: "chromium", headless: !process.env.HEADED, viewport: { width: 1100, height: 1000 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
await sw.evaluate((pairs) => chrome.storage.sync.set({ pairs }), [{ from: new URL(from).origin, to, ignore, blocks: "" }]);
await new Promise((r) => setTimeout(r, 500));
const tab = await context.newPage();
await tab.goto(new URL(page, from).href + (page.includes("?") ? "&" : "?") + "redline");
let text = "";
for (let i = 0; i < 150; i++) {
  text = await tab.evaluate(() => document.querySelector("#redline-host")?.shadowRoot?.querySelector(".b")?.innerText ?? "");
  if (text && !/comparing/.test(text)) break;
  await tab.waitForTimeout(100);
}
console.log("badge:", text.replace(/\s+/g, " "));
console.log("new words:", await tab.$$eval("mark.redline-new", (m) => m.slice(0, 15).map((x) => x.textContent)));
console.log("new blocks:", await tab.$$eval("[data-redline-new]", (e) => e.slice(0, 8).map((x) => x.textContent.slice(0, 70))));
console.log("removed:", await tab.$$eval(".redline-removed", (e) => e.slice(0, 8).map((x) => x.textContent.slice(0, 70))));
await tab.keyboard.press("j");
await tab.waitForTimeout(800);
await tab.screenshot({ path: path.join(out, "live-after.png") });
await tab.keyboard.press("b");
await tab.waitForTimeout(300);
await tab.screenshot({ path: path.join(out, "live-before.png") });
await context.close();
