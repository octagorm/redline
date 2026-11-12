// Runs on every page of a "this site" host. Does nothing until Redline is
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
  const state = { on: false, mode: savedMode(), count: null, current: null, changes: [] };
  let reviews = null; // this pair's stored reviews (review.js)

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

  // The page's own <meta name="redline"> first, then the saved pairs.
  async function findPair() {
    const P = globalThis.RedlinePairs;
    const hint = P.hintFrom(P.readMeta(), location.href);
    if (hint) return hint;
    const { pairs = [] } = await chrome.storage.sync.get("pairs");
    return P.pairFor(pairs, location.href);
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
  .b { flex-wrap:wrap; justify-content:flex-end; row-gap:6px; max-width:calc(100vw - 32px); box-sizing:border-box; }
  .b > *, .modes > * { white-space:nowrap; }
  .modes { display:flex; gap:8px; }
  .modes button[aria-pressed=true] { text-decoration:none; font-weight:700; }
  button { background:none; border:0; padding:0; color:inherit; font:inherit;
           text-decoration:underline; cursor:pointer; }
  .keys { cursor:help; display:inline-flex; gap:6px; align-items:center; }
  .keys > span { opacity:.75; }
  .keys .k-ok, .keys .k-no { opacity:1; font-weight:700; }
  .keys .k-ok { color:#1d6b3a; }
  .keys .k-no { color:#a3241c; }
  .b.removed .keys .k-ok { color:#c9f2d6; }
  .b.removed .keys .k-no { color:#ffd9d4; }
  .todo { font-weight:700; }
  .todo.done { font-weight:400; text-decoration:none; cursor:default; }
  /* Quick tooltips: the browser's own take a second to appear. */
  [data-tip] { position:relative; }
  [data-tip]:hover::after { content:attr(data-tip); position:absolute; right:0;
    bottom:calc(100% + 10px); width:max-content; max-width:300px; white-space:pre;
    padding:6px 8px; border-radius:6px; background:#1c1a17; color:#f3efe6;
    font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; text-align:left;
    box-shadow:0 2px 8px rgba(0,0,0,.3); pointer-events:none; z-index:1; }
  [hidden] { display:none; }
  .wrap { display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
  .panel { max-height:50vh; overflow:auto; min-width:260px; max-width:min(440px, 90vw);
           padding:10px 12px; border-radius:8px; background:#1c1a17; color:#f3efe6;
           font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
           box-shadow:0 2px 10px rgba(0,0,0,.25); }
  .panel ul { list-style:none; margin:6px 0 0; padding:0; }
  .panel li { display:flex; gap:10px; justify-content:space-between; }
  .panel a { color:#f3efe6; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .panel a:hover { text-decoration:underline; }
  .panel li.here a { color:#e0aa3e; }
  .panel .n { opacity:.7; white-space:nowrap; }
  .panel .new { color:#e0aa3e; }
  .panel .removed { color:#ff8a80; }
  .panel .head { display:flex; justify-content:space-between; gap:12px; }
  .panel button { opacity:.8; }
  .panel .pnote { opacity:.6; }
  .panel .more { margin-top:6px; }
</style>
<div class="wrap">
<div class="panel" hidden>
  <div class="head"><span class="ptitle"></span><span>
    <button class="stop" hidden>stop</button>
    <button class="rescan" hidden>scan again</button></span></div>
  <div class="pnote"></div>
  <ul></ul>
  <button class="more" hidden></button>
</div>
<div class="b">
  <span class="msg"></span>
  <button class="count" hidden data-tip="Changes on this page. Click to go to the first"></button>
  <button class="todo" hidden data-tip="Changes with no reaction yet. Click to go to the next one"></button>
  <span class="reviewed" hidden data-tip="Of this page's changes: ✓ approved, ✗ rejected, ✎ with a note or wording"></span>
  <span class="keys" hidden data-tip="J / K   next or previous change
V       next view: all, added, removed
A       approve the change
X       reject it
C       add a note or wording
P       pages: which pages differ"><span>J↓</span><span>K↑</span><span>V</span><span class="k-ok">A</span><span class="k-no">X</span><span>C</span><span>P</span></span>
  <span class="modes" hidden>
    <button data-mode="all" data-tip="New words highlighted, removed ones struck through (V)">all</button>
    <button data-mode="added" data-tip="Only what is new (V)">added</button>
    <button data-mode="removed" data-tip="The other site's wording, removed words struck through (V)">removed</button>
  </span>
  <button class="pages" data-tip="Which pages of the site differ   P">pages</button>
  <button class="notes" hidden data-tip="Copy your rejections, notes and suggested wording as a list">copy notes</button>
  <button class="again" data-tip="Compare again">again</button>
  <button class="off" data-tip="Turn Redline off for this tab">hide</button>
</div>
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
      pages: $(".pages"),
      notes: $(".notes"),
      reviewed: $(".reviewed"),
      todo: $(".todo"),
      panel: $(".panel"),
      ptitle: $(".ptitle"),
      plist: $(".panel ul"),
      rescan: $(".rescan"),
      stop: $(".stop"),
      more: $(".more"),
      pnote: $(".pnote"),
    };
    ui.stop.onclick = () => stopScan();
    ui.more.onclick = () => scanPages(false);
    ui.pages.onclick = () => togglePages();
    ui.notes.onclick = () => copyNotes();
    ui.todo.onclick = () => nextOpen();
    ui.rescan.onclick = () => scanPages(true);
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
    const sum = has && reviews ? RV().pageSummary(reviews, rest()) : null;
    const t = RV()?.tally(sum) ?? "";
    u.reviewed.hidden = !t;
    u.reviewed.textContent = t;
    // Changes nobody has reacted to yet, or a tick once there are none.
    u.todo.hidden = !sum;
    if (sum) {
      u.todo.textContent = sum.open ? `${sum.open} to review` : "all reviewed";
      u.todo.classList.toggle("done", !sum.open);
    }
    const fb = reviews ? RV().feedback(reviews).length : 0;
    u.notes.hidden = !fb;
    if (fb) u.notes.textContent = `copy notes (${fb})`;
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
    state.changes = [];
    hideTools();
    setMode(state.mode);
    R.clear();
    addStyle();
    document.documentElement.classList.add("redline-on");
    const here = new URL(location.href);
    here.searchParams.delete(KEY);
    const url = globalThis.RedlinePairs.referenceFor(pair, here.href);
    const base = new URL(url).origin;
    render("comparing…", url);
    await settled();
    if (id !== runId) return;

    const opt = options();
    if (!opt) {
      render("a selector in this site's settings is not valid CSS");
      return;
    }
    const rendered = !!pair.render;
    if (rendered) render("rendering the reference…", url);
    const get = (u, extra) =>
      chrome.runtime
        .sendMessage({ type: "fetch", url: u, ...extra })
        .catch((e) => ({ ok: false, status: 0, error: String(e) }));
    // This page as its own server sends it, too: see show() in diff.js. When
    // the reference is rendered, both sides are as drawn in the browser, so
    // the live page is diffed as it is.
    const [res, mine] = await Promise.all([
      get(url, rendered ? { render: true, scope: opt.scope } : {}),
      rendered ? null : get(location.href),
    ]);
    if (id !== runId || !state.on) return;

    let old;
    let note = "";
    if (res.ok) {
      const doc = new DOMParser().parseFromString(res.text, "text/html");
      old = R.blocks(doc, opt);
      if (!old.length)
        note = rendered
          ? " (the reference page has no text)"
          : ' (the reference page has no text: is it drawn by scripts? Try "Render the reference" in the settings)';
      if (res.url && new URL(res.url).pathname !== new URL(url).pathname)
        note += ` (redirected to ${res.url})`;
      if (opt.scope && !doc.querySelector(opt.scope))
        note += ` (no ${opt.scope} on the reference)`;
    } else if (res.status === 404) {
      old = []; // a page the reference does not have is new from top to bottom
      note = " (not on the reference: 404)";
    } else {
      render(
        res.status
          ? `reference answered ${res.status}`
          : res.error?.startsWith("could not render")
            ? "could not render the reference"
            : pair.fromSite
              ? `click the Redline button to allow ${new URL(url).host}`
              : "could not reach the reference",
        res.error ?? url
      );
      return;
    }

    // Pages built in the browser have no server text to go by; for those, and
    // when this page cannot be fetched, the live page is diffed as it is.
    let own;
    if (mine?.ok) {
      own = R.blocks(new DOMParser().parseFromString(mine.text, "text/html"), opt)
        .map((b) => b.text);
      if (!own.length) own = undefined;
    }
    R.clear();
    const dom = R.blocks(document, opt);
    state.changes = R.show(dom, old, own);
    state.count = state.changes.length;
    try {
      reviews = await RV().setPage(pair, rest(), state.changes);
    } catch {
      reviews = null;
    }
    applyReviews();
    syncScan();
    render(
      state.count === 0 ? `same as ${new URL(base).host}${note}` : "",
      `Compared with ${url}${note}`
    );
  }

  // The pair's ignore, block and scope selectors, or null when one is not
  // valid CSS.
  function options() {
    const opt = {
      ignore: pair?.ignore?.trim() || "",
      blocks: pair?.blocks?.trim() || "",
      scope: pair?.scope?.trim() || "",
    };
    try {
      if (opt.ignore) document.querySelector(opt.ignore);
      if (opt.blocks) document.querySelector(opt.blocks);
      if (opt.scope) document.querySelector(opt.scope);
    } catch {
      return null;
    }
    return opt;
  }

  // ---------- review: approve, reject, notes ----------

  const RV = () => globalThis.RedlineReview;
  const rest = () => globalThis.RedlinePairs.restFor(pair, location.href);
  const changeOf = (el) => {
    const id = el?.closest?.("[data-redline-id]")?.getAttribute("data-redline-id");
    return id ? state.changes.find((c) => c.id === id) : null;
  };

  // Shows each change's review on the page.
  function applyReviews() {
    for (const el of document.querySelectorAll("[data-redline-id]")) {
      const e = reviews?.entries[el.getAttribute("data-redline-id")];
      if (e?.state) el.setAttribute("data-redline-review", e.state);
      else el.removeAttribute("data-redline-review");
      el.toggleAttribute("data-redline-noted", !!(e?.note || e?.suggestion));
    }
    if (tools.change) showTools(tools.change);
  }

  async function review(change, patch) {
    if (!change) return;
    reviews = await RV().update(pair, rest(), change, patch);
    applyReviews();
    render(ui?.msg.textContent, ui?.box.title);
    // The pages list shows each page's progress, so it follows along.
    if (ui && !ui.panel.hidden && !signal && scan) listPages();
  }

  // Goes to the next change with no reaction yet, after the current one.
  function nextOpen() {
    const open = [...document.querySelectorAll("[data-redline-id]")].filter(
      (el) => el.getClientRects().length && !RV().reacted(reviews, el.getAttribute("data-redline-id"))
    );
    if (!open.length) return;
    const from = tools.el ?? state.current;
    const after = from
      ? open.find((el) => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      : null;
    const target = after ?? open[0];
    state.current = target;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    const change = changeOf(target);
    if (change) showTools(change);
  }

  async function copyNotes() {
    if (!reviews) return;
    const text = RV().markdown(pair, reviews);
    try {
      await navigator.clipboard.writeText(text);
      flash("copied");
    } catch {
      // No clipboard (an unfocused page, say): show it to copy by hand.
      prompt("Your notes:", text);
    }
  }

  function flash(text) {
    const b = badge().notes;
    const was = b.textContent;
    b.textContent = text;
    setTimeout(() => (b.textContent = was), 1200);
  }

  // The little toolbar beside a change: ✓ approve, ✗ reject, ✎ note. It
  // follows the pointer, or the change J and K went to.
  const tools = { host: null, root: null, change: null, el: null };

  function toolsUi() {
    if (tools.host?.isConnected) return tools.root;
    tools.host = document.createElement("div");
    tools.host.id = "redline-tools";
    tools.host.style.cssText = "all:initial;display:block;width:max-content;position:fixed;z-index:2147483646;top:0;left:0;";
    const root = (tools.root = tools.host.attachShadow({ mode: "open" }));
    root.innerHTML = `
<style>
  :host { display:block; width:max-content; }
  .t { display:inline-flex; gap:2px; padding:3px; border-radius:7px; background:#1c1a17;
       box-shadow:0 2px 8px rgba(0,0,0,.3); font:13px/1 system-ui, sans-serif; }
  .t button { border:0; background:none; color:#f3efe6; width:26px; height:24px;
              border-radius:5px; cursor:pointer; font:inherit; }
  .t button:hover { background:#3a362f; }
  .t button[data-tip] { position:relative; }
  .t button[data-tip]:hover::after { content:attr(data-tip); position:absolute; right:0;
    top:calc(100% + 6px); width:max-content; white-space:pre; padding:4px 7px;
    border-radius:5px; background:#3a362f; color:#f3efe6;
    font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; pointer-events:none; }
  .t button.ok[aria-pressed=true] { background:#3c9a5f; }
  .t button.no[aria-pressed=true] { background:#d9534a; }
  .t button.note[aria-pressed=true] { background:#8a6d2f; }
  form { margin-top:6px; width:min(460px, calc(100vw - 32px)); padding:8px; border-radius:7px;
         background:#1c1a17; color:#f3efe6; box-shadow:0 2px 8px rgba(0,0,0,.3);
         font:12px/1.4 system-ui, sans-serif; display:grid; gap:6px; }
  label { display:grid; gap:3px; opacity:.95; }
  textarea[name=suggestion] { max-height:40vh; }
  textarea { font:12px/1.4 system-ui, sans-serif; background:#2a2722; color:#f3efe6;
             border:1px solid #4a453c; border-radius:5px; padding:5px; resize:vertical; }
  .row { display:flex; gap:8px; justify-content:flex-end; align-items:center; }
  .row .grow { flex:1; }
  form button { font:inherit; color:#f3efe6; background:#3a362f; border:0; border-radius:5px; padding:4px 10px; cursor:pointer; }
  form button.save { background:#d9534a; }
  form .link { background:none; padding:0; text-decoration:underline; opacity:.8; }
  [hidden] { display:none !important; }
</style>
<div class="t">
  <button class="ok" data-tip="Approve   A">✓</button>
  <button class="no" data-tip="Reject   X">✗</button>
  <button class="note" data-tip="Note or wording   C">✎</button>
</div>
<form hidden>
  <label>Comment on this change
  <textarea name="note" rows="2" placeholder="What is wrong, or what to keep in mind"></textarea></label>
  <label class="sug" hidden>Your wording: edit the text as it should read
  <textarea name="suggestion" rows="3"></textarea></label>
  <div class="row">
    <button type="button" class="link suggest grow">suggest new wording</button>
    <button type="button" class="cancel">cancel</button>
    <button type="submit" class="save">save</button>
  </div>
</form>`;
    const $ = (q) => root.querySelector(q);
    $(".ok").onclick = () => toggleState("ok");
    $(".no").onclick = () => toggleState("no");
    $(".note").onclick = () => openNote();
    $(".cancel").onclick = () => {
      $("form").hidden = true;
      placeTools();
    };
    $(".suggest").onclick = () => {
      const sug = $("[name=suggestion]");
      $(".sug").hidden = false;
      if (!sug.value) sug.value = tools.change.kind === "removed" ? tools.change.before : tools.change.after;
      $(".suggest").hidden = true;
      fit(sug);
      placeTools();
      sug.focus({ preventScroll: true });
    };
    $("[name=suggestion]").oninput = (e) => {
      fit(e.target);
      placeTools();
    };
    $("form").onsubmit = (e) => {
      e.preventDefault();
      const note = $("[name=note]").value.trim();
      let suggestion = $("[name=suggestion]").value.trim();
      // Unchanged wording is no suggestion.
      const current = tools.change.kind === "removed" ? tools.change.before : tools.change.after;
      if (suggestion.replace(/\s+/g, " ") === current) suggestion = "";
      $("form").hidden = true;
      review(tools.change, { note, suggestion });
    };
    $("form").onkeydown = (e) => {
      if (e.key === "Escape") $("form").hidden = true;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("form").requestSubmit();
    };
    document.documentElement.append(tools.host);
    return root;
  }

  // Tall enough for the whole paragraph, up to 40% of the window.
  function fit(area) {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight + 2}px`;
  }

  function toggleState(s) {
    const e = reviews?.entries[tools.change?.id];
    review(tools.change, { state: e?.state === s ? null : s });
  }

  function openNote() {
    const root = toolsUi();
    if (!tools.change) return;
    const e = reviews?.entries[tools.change.id] ?? {};
    const form = root.querySelector("form");
    form.querySelector("[name=note]").value = e.note ?? "";
    const sug = form.querySelector("[name=suggestion]");
    sug.value = e.suggestion ?? "";
    form.querySelector(".sug").hidden = !e.suggestion;
    form.querySelector(".suggest").hidden = !!e.suggestion;
    form.hidden = false;
    if (e.suggestion) fit(sug);
    placeTools();
    form.querySelector("[name=note]").focus({ preventScroll: true });
  }

  // The element a change is shown by in the current mode.
  function shownEl(change) {
    for (const el of document.querySelectorAll(`[data-redline-id="${change.id}"]`))
      if (el.getClientRects().length) return el;
    return null;
  }

  function showTools(change) {
    const root = toolsUi();
    const el = shownEl(change);
    if (!el) {
      tools.host.hidden = true;
      return;
    }
    if (tools.change?.id !== change.id) root.querySelector("form").hidden = true;
    tools.change = change;
    tools.el = el;
    tools.host.hidden = false;
    const e = reviews?.entries[change.id];
    root.querySelector(".ok").setAttribute("aria-pressed", String(e?.state === "ok"));
    root.querySelector(".no").setAttribute("aria-pressed", String(e?.state === "no"));
    root.querySelector(".note").setAttribute("aria-pressed", String(!!(e?.note || e?.suggestion)));
    placeTools();
  }

  // Beside the change's top right corner, and always wholly inside the
  // window: with the note form open it is much bigger, so it is measured.
  function placeTools() {
    if (!tools.el || tools.host?.hidden) return;
    const r = tools.el.getBoundingClientRect();
    const { width: w, height: h } = tools.host.getBoundingClientRect();
    const m = 8;
    let left = r.right + 10;
    let top = r.top - 2;
    // No room on the right: below the change's last line, at its right edge.
    if (left + w > innerWidth - m) {
      left = r.right - w;
      top = r.bottom + 6;
    }
    left = Math.max(m, Math.min(left, innerWidth - w - m));
    top = Math.max(m, Math.min(top, innerHeight - h - m));
    tools.host.style.left = `${left}px`;
    tools.host.style.top = `${top}px`;
  }

  function hideTools() {
    tools.host?.remove();
    tools.host = null;
    tools.change = null;
    tools.el = null;
  }

  addEventListener(
    "mouseover",
    (e) => {
      if (!state.on || !state.count) return;
      const change = changeOf(e.target);
      if (change && change.id !== tools.change?.id) showTools(change);
    },
    true
  );
  addEventListener("scroll", () => placeTools(), { passive: true, capture: true });
  addEventListener("resize", () => placeTools());

  // ---------- the "pages" panel: which pages of the site differ ----------

  // The scan lasts for the tab, so the list survives moving between pages
  // and "check more" carries on where it stopped.
  const PAGES_KEY = "redline-pages";
  const BATCH = 100;
  const scanKey = () => pair && `${pair.from} -> ${pair.to}`;
  let scan = null; // { key, rests, total, complete, next, items, at }
  let crawled = new Map();
  let signal = null; // { stopped } while a scan runs

  function loadScan() {
    if (scan?.key === scanKey()) return scan;
    try {
      const s = JSON.parse(sessionStorage.getItem(PAGES_KEY));
      scan = s?.key === scanKey() ? s : null;
    } catch {
      scan = null;
    }
    return scan;
  }

  function saveScan() {
    try {
      sessionStorage.setItem(PAGES_KEY, JSON.stringify(scan));
    } catch {}
  }

  function togglePages() {
    const u = badge();
    if (!u.panel.hidden) {
      u.panel.hidden = true;
      return;
    }
    u.panel.hidden = false;
    if (loadScan()) listPages();
    else scanPages(true);
  }

  function stopScan() {
    if (signal) signal.stopped = true;
  }

  // From the start (`fresh`), or the next batch of the scan so far.
  async function scanPages(fresh) {
    if (signal || !pair) return;
    const opt = options();
    if (!opt) return;
    const u = badge();
    u.panel.hidden = false;
    const mine = (signal = { stopped: false });
    const status = (text) => {
      u.ptitle.textContent = text;
    };
    listPages(true);
    try {
      if (fresh || !loadScan()) {
        const found = await globalThis.RedlineScan.discover(pair, mine, status);
        crawled = found.crawled;
        scan = {
          key: scanKey(),
          rests: found.rests,
          total: found.total,
          complete: found.complete,
          next: 0,
          items: [],
          at: Date.now(),
        };
      }
      const batch = scan.rests.slice(scan.next, scan.next + BATCH);
      const { items, done } = await globalThis.RedlineScan.check(
        pair,
        opt,
        batch,
        crawled,
        mine,
        (done) => status(`comparing ${scan.next + done} of ${scan.rests.length}…`)
      );
      // A stopped batch keeps what it compared; the rest is checked next time.
      scan.next += done;
      scan.items = [...scan.items, ...items].sort((a, b) => a.path.localeCompare(b.path));
      scan.at = Date.now();
      saveScan();
    } catch (e) {
      status(`could not scan: ${e}`);
      signal = null;
      return;
    }
    signal = null;
    listPages();
  }

  // Brings this page's row in the pages list up to date with what was just
  // compared, so the list never lags behind the page you are on.
  function syncScan() {
    if (!loadScan() || signal) return;
    const path = rest();
    const items = scan.items.filter((it) => it.path !== path || it.state === "removed");
    const old = scan.items.find((it) => it.path === path);
    if (state.count)
      items.push({
        path,
        url: location.origin + location.pathname,
        count: state.count,
        state: old?.state === "new" ? "new" : "changed",
      });
    scan.items = items.sort((a, b) => a.path.localeCompare(b.path));
    saveScan();
    if (ui && !ui.panel.hidden) listPages();
  }

  function listPages(running = false) {
    const u = badge();
    u.stop.hidden = !running;
    u.more.hidden = true;
    u.rescan.hidden = running;
    if (running || !scan) {
      if (!scan) u.plist.textContent = "";
      return;
    }
    const n = scan.items.length;
    const checked = scan.next;
    const all = checked >= scan.rests.length && scan.complete;
    const mins = Math.round((Date.now() - scan.at) / 60000);
    const when = mins < 1 ? "just now" : `${mins} min ago`;
    const fmt = (x) => x.toLocaleString();
    u.ptitle.textContent = `${n ? fmt(n) : "no"} ${n === 1 ? "page differs" : "pages differ"}`;
    u.pnote.textContent = all
      ? `checked all ${fmt(checked)} pages, ${when}`
      : `checked ${fmt(checked)} of ${fmt(Math.max(scan.total, scan.rests.length))}${scan.complete ? "" : "+"} pages, nearest this one first, ${when}`;
    const left = scan.rests.length - checked;
    if (left > 0) {
      u.more.hidden = false;
      u.more.textContent = `check ${fmt(Math.min(BATCH, left))} more`;
    }
    u.plist.textContent = "";
    for (const it of scan.items) {
      const li = document.createElement("li");
      if (new URL(it.url).pathname === location.pathname) li.className = "here";
      const a = document.createElement("a");
      a.href = it.url;
      a.textContent = it.path;
      a.title = it.url;
      if (it.state === "removed") {
        // Not on this site any more: open the reference's copy.
        a.href = globalThis.RedlinePairs.normalise(pair.to) + it.path;
      }
      const tag = document.createElement("span");
      tag.className = "n";
      if (it.state === "new") tag.innerHTML = '<span class="new">new page</span>';
      else if (it.state === "removed") tag.innerHTML = '<span class="removed">removed page</span>';
      else {
        // Not opened since its text last changed: none of it is reviewed.
        tag.textContent = `${it.count} to review`;
        // Review progress, for pages opened since their text last changed.
        // The page's own record wins when it is newer than the scan: the
        // scan's count can be stale, or count text the page cannot show.
        const sum = reviews && RV().pageSummary(reviews, it.path);
        const fresh = sum && (sum.total === it.count || (reviews.pages[it.path]?.at ?? 0) >= scan.at);
        const t = RV().tally(sum);
        if (fresh && !sum.open && !t) tag.textContent = "no changes";
        else if (fresh && t)
          tag.textContent =
            sum.ok === sum.total && !sum.noted
              ? "all approved"
              : [sum.open && `${sum.open} to review`, t].filter(Boolean).join(" · ");
      }
      li.append(a, tag);
      u.plist.append(li);
    }
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
    if (tools.change) requestAnimationFrame(() => tools.change && showTools(tools.change));
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
    stopScan();
    hideTools();
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
    const change = changeOf(target);
    if (change) showTools(change);
  }

  addEventListener(
    "keydown",
    (e) => {
      if (!state.on || state.count === null) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const t = e.composedPath()[0];
      if (t?.closest?.("input, textarea, select, [contenteditable]") || t?.isContentEditable)
        return;
      const key = e.key.toLowerCase();
      if (key === "p") togglePages();
      else if (!state.count) return;
      else if (key === "v")
        setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
      else if ((key === "a" || key === "x") && tools.change) {
        // Approve or reject, then on to the next change.
        const s = key === "a" ? "ok" : "no";
        const was = reviews?.entries[tools.change.id]?.state;
        review(tools.change, { state: was === s ? null : s }).then(() => {
          if (was !== s) nextOpen();
        });
      } else if (key === "c" && tools.change) openNote();
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
