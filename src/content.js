// Runs on every page of a "this site" origin. Does nothing until Redline is
// turned on for the tab (toolbar button, Alt+Shift+R, or `?redline` in the
// URL). Once on, it stays on for the tab across navigation, like the page's
// sessionStorage, until turned off.

(() => {
  if (globalThis.__redlineLoaded) return;
  globalThis.__redlineLoaded = true;

  const R = globalThis.Redline;
  const KEY = "redline";
  const MODES = ["all", "added", "removed"];
  const MODE_KEY = "redline-mode";
  const state = { on: false, mode: savedMode(), count: null, current: null };

  // The mode sticks for the tab, like being on does.
  function savedMode() {
    try {
      const m = sessionStorage.getItem(MODE_KEY);
      if (MODES.includes(m)) return m;
    } catch {}
    return "all";
  }
  let pair = null;
  let runId = 0;

  // ---------- settings ----------

  async function findPair() {
    const { pairs = [] } = await chrome.storage.sync.get("pairs");
    return (
      pairs.find((p) => {
        try {
          return new URL(p.from).origin === location.origin;
        } catch {
          return false;
        }
      }) ?? null
    );
  }

  function wanted() {
    const param = new URLSearchParams(location.search).get(KEY);
    try {
      if (param !== null) sessionStorage.setItem(KEY, param === "0" ? "0" : "1");
      return sessionStorage.getItem(KEY) === "1";
    } catch {
      return param !== null && param !== "0";
    }
  }

  function remember(on) {
    try {
      sessionStorage.setItem(KEY, on ? "1" : "0");
    } catch {}
  }

  // ---------- badge (in a shadow root, so page styles cannot reach it) ----------

  let host = null;
  let ui = null;

  function badge() {
    if (host?.isConnected) return ui;
    host = document.createElement("div");
    host.id = "redline-host";
    host.style.cssText =
      "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
<style>
  .b { display:flex; gap:12px; align-items:center; padding:8px 12px;
       border-radius:8px; background:#e0aa3e; color:#14110a;
       font:12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
       box-shadow:0 2px 10px rgba(0,0,0,.25); }
  .b.removed { background:#d9534a; color:#fff; }
  .modes { display:flex; gap:8px; }
  .modes button[aria-pressed=true] { text-decoration:none; font-weight:700; }
  button { background:none; border:0; padding:0; color:inherit; font:inherit;
           text-decoration:underline; cursor:pointer; }
  .keys { opacity:.7; }
  [hidden] { display:none; }
</style>
<div class="b">
  <span class="msg"></span>
  <button class="count" hidden></button>
  <span class="keys" hidden title="J: next change. K: previous change. B: next mode (all, added, removed).">J K B</span>
  <span class="modes" hidden>
    <button data-mode="all" title="New words highlighted, removed words struck through">all</button>
    <button data-mode="added" title="Only what is new">added</button>
    <button data-mode="removed" title="The other site's wording, removed words struck through">removed</button>
  </span>
  <button class="again" title="Compare again">again</button>
  <button class="off" title="Turn Redline off for this tab">hide</button>
</div>`;
    const $ = (s) => root.querySelector(s);
    ui = {
      box: $(".b"),
      msg: $(".msg"),
      count: $(".count"),
      keys: $(".keys"),
      modes: $(".modes"),
      again: $(".again"),
      off: $(".off"),
    };
    ui.count.onclick = () => step(1, true);
    for (const b of root.querySelectorAll("[data-mode]"))
      b.onclick = () => setMode(b.dataset.mode);
    ui.again.onclick = () => run();
    ui.off.onclick = () => turnOff();
    document.documentElement.append(host);
    return ui;
  }

  function render(message, title = "") {
    const u = badge();
    const n = state.count;
    const has = typeof n === "number" && n > 0;
    u.msg.hidden = has;
    u.msg.textContent = message ?? "";
    u.box.title = title;
    u.count.hidden = !has;
    u.keys.hidden = !has;
    u.modes.hidden = !has;
    if (has) u.count.textContent = `${n} ${n === 1 ? "change" : "changes"}`;
    for (const b of u.modes.children)
      b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
    u.box.classList.toggle("removed", state.mode === "removed");
    chrome.runtime
      .sendMessage({
        type: "badge",
        text: typeof n === "number" ? String(n) : "",
      })
      .catch(() => {});
  }

  // ---------- the comparison ----------

  let styleEl = null;
  function addStyle() {
    if (styleEl?.isConnected) return;
    styleEl = document.createElement("style");
    styleEl.id = "redline-style";
    styleEl.textContent = R.CSS;
    document.documentElement.append(styleEl);
  }

  // Waits until the page has stopped changing for a moment (hydration, data
  // loading), at most a few seconds.
  function settled(quiet = 400, max = 4000) {
    return new Promise((done) => {
      let t;
      const obs = new MutationObserver((list) => {
        if (list.every((m) => host?.contains(m.target))) return;
        clearTimeout(t);
        t = setTimeout(finish, quiet);
      });
      const finish = () => {
        obs.disconnect();
        clearTimeout(cap);
        done();
      };
      const cap = setTimeout(finish, max);
      obs.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      t = setTimeout(finish, quiet);
    });
  }

  async function run() {
    const id = ++runId;
    pair = await findPair();
    if (!pair) {
      turnOff();
      return;
    }
    state.count = null;
    state.current = null;
    setMode(state.mode);
    R.clear();
    addStyle();
    document.documentElement.classList.add("redline-on");
    const base = pair.to.replace(/\/+$/, "");
    const here = new URL(location.href);
    here.searchParams.delete(KEY);
    const url = base + here.pathname + here.search;
    render("comparing…", url);
    await settled();
    if (id !== runId) return;

    const get = (u) =>
      chrome.runtime
        .sendMessage({ type: "fetch", url: u })
        .catch((e) => ({ ok: false, status: 0, error: String(e) }));
    // This page as its own server sends it, too: see show() in diff.js.
    const [res, mine] = await Promise.all([get(url), get(location.href)]);
    if (id !== runId || !state.on) return;

    let opt = { ignore: pair.ignore?.trim() || "", blocks: pair.blocks?.trim() || "" };
    try {
      if (opt.ignore) document.querySelector(opt.ignore);
      if (opt.blocks) document.querySelector(opt.blocks);
    } catch {
      render("a selector in this site's settings is not valid CSS");
      return;
    }

    let old;
    let note = "";
    if (res.ok) {
      const doc = new DOMParser().parseFromString(res.text, "text/html");
      old = R.blocks(doc, opt).map((b) => b.text);
      if (!old.length) note = " (the reference page has no text: is it drawn by scripts?)";
      if (res.url && new URL(res.url).pathname !== new URL(url).pathname)
        note += ` (redirected to ${res.url})`;
    } else if (res.status === 404) {
      old = []; // a page the reference does not have is new from top to bottom
      note = " (not on the reference: 404)";
    } else {
      render(
        res.status ? `reference answered ${res.status}` : "could not reach the reference",
        res.error ?? url
      );
      return;
    }

    // Pages built in the browser have no server text to go by; for those, and
    // when this page cannot be fetched, the live page is diffed as it is.
    let own;
    if (mine.ok) {
      own = R.blocks(new DOMParser().parseFromString(mine.text, "text/html"), opt)
        .map((b) => b.text);
      if (!own.length) own = undefined;
    }
    R.clear();
    const dom = R.blocks(document, opt);
    state.count = R.show(dom, old, own);
    render(
      state.count === 0 ? `same as ${new URL(base).host}${note}` : "",
      `Compared with ${url}${note}`
    );
  }

  // Switching modes shows and hides blocks, which would move the
  // page under the reader. Pin a block both views share, nearest the middle of
  // the window, and scroll so it stays where it was.
  function pinned(change) {
    const mid = innerHeight / 2;
    let best = null;
    let dist = Infinity;
    for (const el of document.querySelectorAll(pair?.blocks || R.DEFAULT_BLOCKS)) {
      if (el.matches(".redline-old, [data-redline-new], [data-redline-changed]")) continue;
      if (el.closest(".redline-old, [data-redline-new], [data-redline-changed]")) continue;
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      const d = Math.abs(r.top - mid);
      if (d < dist) {
        dist = d;
        best = el;
      }
      if (r.top > innerHeight) break;
    }
    const before = best?.getBoundingClientRect().top;
    change();
    if (best) scrollBy(0, best.getBoundingClientRect().top - before);
  }

  function setMode(mode) {
    if (state.on && state.count && mode !== state.mode)
      return pinned(() => setModeNow(mode));
    setModeNow(mode);
  }

  function setModeNow(mode) {
    state.mode = mode;
    try {
      sessionStorage.setItem(MODE_KEY, mode);
    } catch {}
    state.current = null;
    const html = document.documentElement.classList;
    for (const m of MODES) html.toggle(m === "removed" ? "redline-removed-only" : `redline-${m}`, m === mode);
    if (ui) render(ui.msg.textContent, ui.box.title);
  }

  function turnOn() {
    state.on = true;
    remember(true);
    run();
  }

  function turnOff() {
    state.on = false;
    runId++;
    remember(false);
    R.clear();
    state.count = null;
    document.documentElement.classList.remove(
      "redline-on",
      "redline-all",
      "redline-added",
      "redline-removed-only"
    );
    styleEl?.remove();
    host?.remove();
    host = null;
    chrome.runtime.sendMessage({ type: "badge", text: "" }).catch(() => {});
  }

  // ---------- keys: J next, K previous, B next mode ----------

  function step(dir, fromTop = false) {
    const all = [
      ...document.querySelectorAll(
        state.mode === "removed"
          ? ".redline-old"
          : "[data-redline-new], [data-redline-changed], .redline-removed"
      ),
    ].filter((el) => el.getClientRects().length);
    if (!all.length) return;
    const mid = innerHeight / 2;
    const top = (el) => el.getBoundingClientRect().top;
    const bottom = (el) => el.getBoundingClientRect().bottom;
    // From the change last jumped to while it is still on screen (one at the
    // very top or bottom of the page cannot be centred); otherwise from the
    // middle of the window.
    const at = state.current ? all.indexOf(state.current) : -1;
    let target;
    if (fromTop) target = all[0];
    else if (at >= 0 && bottom(all[at]) > 0 && top(all[at]) < innerHeight)
      target = all[at + dir];
    else if (dir > 0) target = all.find((el) => top(el) > mid);
    else target = all.findLast((el) => bottom(el) < mid);
    if (!target) return;
    state.current = target;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  addEventListener(
    "keydown",
    (e) => {
      if (!state.on || !state.count) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const t = e.composedPath()[0];
      if (t?.closest?.("input, textarea, select, [contenteditable]") || t?.isContentEditable)
        return;
      const key = e.key.toLowerCase();
      if (key === "b")
        setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
      else if (key === "j") step(1);
      else if (key === "k") step(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  // ---------- wiring ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") state.on ? turnOff() : turnOn();
  });

  // Client-side navigation keeps this script alive: compare again whenever
  // the path changes.
  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now === lastPath) return;
    lastPath = now;
    if (state.on) run();
    else if (wanted()) turnOn();
  }, 300);

  findPair().then((p) => {
    if (p && wanted()) turnOn();
  });
})();
