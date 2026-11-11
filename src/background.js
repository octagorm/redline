// Service worker. Three jobs:
// 1. Keep the content script registered on every "this site" origin in the
//    saved pairs (only where the user granted the host permission).
// 2. Fetch the reference page for the content script. It runs here because a
//    content script's fetch is bound by the page's CORS rules; the extension's
//    own fetch is not, and it carries the user's cookies for that site.
// 3. Toolbar button: turn Redline on or off in the tab, or open the options
//    page prefilled with the tab's origin when it is not in a pair yet.

const SCRIPT_ID = "redline";
const FILES = ["src/diff.js", "src/content.js"];

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

async function sync() {
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

chrome.action.onClicked.addListener(async (tab) => {
  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }
  const known = (await pairs()).some((p) => sameOrigin(p.from, origin));
  if (!known) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(
        `src/options.html?from=${encodeURIComponent(origin)}`
      ),
    });
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
});

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
