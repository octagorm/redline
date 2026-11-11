const list = document.getElementById("pairs");
const tpl = document.getElementById("tpl");
const status = document.getElementById("status");
const FIELDS = ["from", "to", "ignore", "blocks"];

function addPair(p = {}) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  for (const f of FIELDS) node.querySelector(`[name=${f}]`).value = p[f] ?? "";
  node.querySelector(".remove").onclick = () => node.remove();
  list.append(node);
  return node;
}

function read() {
  return [...list.querySelectorAll(".pair")]
    .map((node) =>
      Object.fromEntries(
        FIELDS.map((f) => [f, node.querySelector(`[name=${f}]`).value.trim()])
      )
    )
    .filter((p) => p.from || p.to);
}

// Same rule as background.js: one permission per host, any port.
const matchFor = (url) => {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
};

function check(pairs) {
  for (const p of pairs) {
    for (const f of ["from", "to"]) {
      try {
        const u = new URL(p[f]);
        if (!/^https?:$/.test(u.protocol)) throw 0;
      } catch {
        return `"${p[f] || "(empty)"}" is not an http or https address.`;
      }
    }
    for (const f of ["ignore", "blocks"]) {
      if (!p[f]) continue;
      try {
        document.querySelector(p[f]);
      } catch {
        return `"${p[f]}" is not a valid CSS selector.`;
      }
    }
    p.from = new URL(p.from).origin;
  }
  return null;
}

document.getElementById("add").onclick = () =>
  addPair().querySelector("input").focus();

document.getElementById("save").onclick = async () => {
  const pairs = read();
  const problem = check(pairs);
  if (problem) {
    status.textContent = problem;
    return;
  }
  const origins = [
    ...new Set(pairs.flatMap((p) => [matchFor(p.from), matchFor(p.to)])),
  ];
  // Must run straight from the click: Chrome asks only on a user gesture.
  const granted = origins.length
    ? await chrome.permissions.request({ origins })
    : true;
  await chrome.storage.sync.set({ pairs });
  status.textContent = granted
    ? "Saved. Reload open tabs on these sites, or press the toolbar button there."
    : "Saved, but without access to those sites Redline cannot run there.";
};

(async () => {
  const { pairs = [] } = await chrome.storage.sync.get("pairs");
  pairs.forEach((p) => addPair(p));
  const from = new URLSearchParams(location.search).get("from");
  if (from && !pairs.some((p) => p.from === from)) {
    const node = addPair({ from, ignore: "nav, footer" });
    node.querySelector("[name=to]").focus();
    status.textContent = `Add the site to compare ${from} with, then save.`;
  } else if (!pairs.length) addPair({ ignore: "nav, footer" });
})();
