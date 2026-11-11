// Reviews: approving or rejecting changes, notes and suggested wording.
// Kept in chrome.storage.local per pair of sites, in this browser only.
//
// A review belongs to a change's id, which comes from the change's text
// (see changeId in diff.js), so it holds while the change stays the same and
// lapses when the text changes again. Each page also keeps the ids of its
// current changes, so reviews of changes that are gone are left out of the
// counts and the exported notes.

globalThis.RedlineReview ??= (() => {
  const P = () => globalThis.RedlinePairs;
  const keyOf = (pair) =>
    `review:${P().normalise(pair.from)} -> ${P().normalise(pair.to)}`;

  async function load(pair) {
    const key = keyOf(pair);
    const got = await chrome.storage.local.get(key);
    return got[key] ?? { entries: {}, pages: {} };
  }

  async function save(pair, data) {
    await chrome.storage.local.set({ [keyOf(pair)]: data });
  }

  // Records the changes a page has now. Returns the stored data.
  async function setPage(pair, path, changes) {
    const data = await load(pair);
    data.pages[path] = { ids: changes.map((c) => c.id), at: Date.now() };
    await save(pair, data);
    return data;
  }

  // Merges `patch` ({ state: "ok" | "no" | null, note, suggestion }) into a
  // change's review, with the change's text kept for the exported notes.
  async function update(pair, path, change, patch) {
    const data = await load(pair);
    const was = data.entries[change.id] ?? {};
    const next = { ...was, ...patch, path, kind: change.kind, before: change.before, after: change.after, at: Date.now() };
    for (const k of ["state", "note", "suggestion"]) if (!next[k]) delete next[k];
    if (next.state || next.note || next.suggestion) data.entries[change.id] = next;
    else delete data.entries[change.id];
    await save(pair, data);
    return data;
  }

  // { total, ok, no } for a page, or null when it has not been opened.
  function pageSummary(data, path) {
    const page = data.pages[path];
    if (!page) return null;
    let ok = 0;
    let no = 0;
    for (const id of page.ids) {
      const s = data.entries[id]?.state;
      if (s === "ok") ok++;
      else if (s === "no") no++;
    }
    return { total: page.ids.length, ok, no };
  }

  // The reviews still current, worth sending on: rejections, notes and
  // suggested wording.
  function feedback(data) {
    const out = [];
    for (const [path, page] of Object.entries(data.pages))
      for (const id of page.ids) {
        const e = data.entries[id];
        if (e && (e.state === "no" || e.note || e.suggestion)) out.push({ id, ...e, path });
      }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // The feedback as Markdown, to paste to whoever makes the changes.
  function markdown(pair, data) {
    const items = feedback(data);
    const quote = (t) => `"${t}"`;
    const lines = [
      `Review of ${P().normalise(pair.from)}, compared with ${P().normalise(pair.to)} (Redline).`,
      "",
    ];
    let path = null;
    for (const e of items) {
      if (e.path !== path) {
        if (path !== null) lines.push("");
        lines.push(`## ${e.path}`, "");
        path = e.path;
      }
      const what = { new: "New text", changed: "Changed text", removed: "Removed text" }[e.kind];
      const verdict = e.state === "no" ? "Rejected" : e.state === "ok" ? "Approved" : "Comment";
      lines.push(`- **${verdict}.** ${what}: ${quote(e.kind === "removed" ? e.before : e.after)}`);
      if (e.kind === "changed") lines.push(`  - Was: ${quote(e.before)}`);
      if (e.note) lines.push(`  - Note: ${e.note.replace(/\n+/g, " ")}`);
      if (e.suggestion) lines.push(`  - Suggested wording: ${quote(e.suggestion.replace(/\s+/g, " ").trim())}`);
    }
    if (!items.length) lines.push("No rejections or notes.");
    return lines.join("\n");
  }

  return { load, setPage, update, pageSummary, feedback, markdown };
})();
