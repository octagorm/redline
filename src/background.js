// Service worker. Three jobs:
// 1. Keep the content script registered on every "this site" origin in the
//    saved pairs (only where the user granted the host permission).
// 2. Fetch the reference page for the content script. It runs here because a
//    content script's fetch is bound by the page's CORS rules; the extension's
//    own fetch is not, and it carries the user's cookies for that site.
// 3. Toolbar button: turn Redline on or off in the tab, or open the options
//    page prefilled with the tab's origin when it is not in a pair yet.

importScripts("pairs.js");

const SCRIPT_ID = "redline";
const FILES = ["src/pairs.js", "src/diff.js", "src/content.js"];

// Match patterns cannot name a port, so this covers every port on the host;
// the content script then checks the exact origin against the pairs.
const matchFor = (origin) => {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
};

async function pairs() {
  const { pairs = [] } = await chrome.storage.sync.get("pairs");
  return pairs;
}

// One at a time: a save fires both the caller's sync and onChanged's.
let syncing = Promise.resolve();
function sync() {
  syncing = syncing.then(syncNow, syncNow);
  return syncing;
}

async function syncNow() {
  const matches = [];
  for (const p of await pairs()) {
    let m;
    try {
      m = matchFor(p.from);
    } catch {
      continue;
    }
    if (matches.includes(m)) continue;
    if (await chrome.permissions.contains({ origins: [m] })) matches.push(m);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [SCRIPT_ID],
  });
  if (existing.length)
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (matches.length)
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches,
        js: FILES,
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
}

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.pairs) sync();
});
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(sync);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "fetch") {
    fetch(msg.url, { credentials: "include", cache: "no-store" })
      .then(async (r) =>
        reply({ ok: r.ok, status: r.status, url: r.url, text: await r.text() })
      )
      .catch((e) => reply({ ok: false, status: 0, error: String(e) }));
    return true; // reply comes later
  }
  if (msg.type === "badge" && sender.tab) {
    const tabId = sender.tab.id;
    chrome.action.setBadgeText({ tabId, text: msg.text ?? "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#d9534a" });
  }
  if (msg.type === "options") chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener((tab) => onAction(tab));

// Also reachable as self.onAction, so the tests can press the button.
async function onAction(tab) {
  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }
  let meta = null;
  try {
    [{ result: meta }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: RedlinePairs.readMeta,
    });
  } catch {
    // A page extensions may not read, such as the Chrome Web Store.
  }
  const hint = RedlinePairs.hintFrom(meta, tab.url);
  const saved = RedlinePairs.pairFor(await pairs(), tab.url);
  if (hint) {
    // The page's tag wins; save it if it is new or names another site.
    const same =
      saved && saved.from === hint.from && saved.to === hint.to;
    if (!same && !(await adopt(hint, origin))) return;
  } else if (!saved) {
    openSettings({ from: origin });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch {
    // No content script yet: the tab was open before the pair was saved.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: FILES,
    });
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  }
}
self.onAction = onAction;

// Saves the pair a page's <meta name="redline"> asks for, in place of any
// saved pair for the same site, after Chrome asks for access to both sites.
// If Chrome will not ask from here, the settings page opens with the pair
// filled in. True when the pair was saved and Redline can start.
async function adopt(hint, origin) {
  const origins = [matchFor(origin), matchFor(hint.to)];
  let granted = false;
  try {
    granted =
      (await chrome.permissions.contains({ origins })) ||
      (await chrome.permissions.request({ origins }));
  } catch {
    // Chrome only asks during the click itself; reading the tag may have
    // taken too long. The settings page can ask instead.
  }
  if (!granted) {
    openSettings({ from: hint.from, to: hint.to, ignore: hint.ignore });
    return false;
  }
  const list = (await pairs()).filter((p) => {
    try {
      return RedlinePairs.normalise(p.from) !== hint.from;
    } catch {
      return true;
    }
  });
  list.push(hint);
  await chrome.storage.sync.set({ pairs: list });
  await sync();
  return true;
}

function openSettings(fields) {
  const q = new URLSearchParams(
    Object.entries(fields).filter(([, v]) => v)
  );
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/options.html?${q}`) });
}
