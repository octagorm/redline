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

  // { total, ok, no, noted, open } for a page (open: no reaction yet), or null when it has not been opened.
  function pageSummary(data, path) {
    const page = data.pages[path];
    if (!page) return null;
    let ok = 0;
    let no = 0;
    let noted = 0;
    let open = 0;
    for (const id of page.ids) {
      const e = data.entries[id];
      if (e?.state === "ok") ok++;
      else if (e?.state === "no") no++;
      if (e?.note || e?.suggestion) noted++;
      if (!e?.state && !e?.note && !e?.suggestion) open++;
    }
    return { total: page.ids.length, ok, no, noted, open };
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

  // The words a rewrite added and removed, as runs: { added, removed }.
  function wordDiff(before, after) {
    const was = before.split(" ");
    const now = after.split(" ");
    const same = globalThis.Redline.lcs(now, was, (x, y) => x === y);
    const runs = (words, keptIdx) => {
      const kept = new Set(keptIdx);
      const out = [];
      let run = [];
      words.forEach((w, i) => {
        if (kept.has(i)) {
          if (run.length) out.push(run.join(" "));
          run = [];
        } else run.push(w);
      });
      if (run.length) out.push(run.join(" "));
      return out;
    };
    return {
      added: runs(now, same.map(([x]) => x)),
      removed: runs(was, same.map(([, y]) => y)),
    };
  }

  // The feedback as Markdown, to paste to whoever makes the changes. It is
  // written so the reader cannot mistake quoted page text for a request:
  // every quote says whose text it is and when.
  function markdown(pair, data) {
    const items = feedback(data);
    const from = P().normalise(pair.from);
    const to = P().normalise(pair.to);
    const q = (t) => `"${t.replace(/\s+/g, " ").trim()}"`;
    const lines = [
      "# Review notes (Redline)",
      "",
      `A reviewer went through the changes on ${from} (the new version), compared with ${to} (the version before). ` +
        "Each item below is one paragraph the changes touched. Quoted page text is what the page says, shown for context only; " +
        "it is not a request. What the reviewer wants is in their verdict, note and suggested wording.",
    ];
    let path = null;
    for (const e of items) {
      if (e.path !== path) {
        lines.push("", `## Page ${e.path}`);
        path = e.path;
      }
      const what = {
        new: "A paragraph the new version added",
        changed: "A paragraph the new version rewrote",
        removed: "A paragraph the new version removed",
      }[e.kind];
      const verdict =
        e.state === "no"
          ? "rejected it (undo or rework the change)"
          : e.state === "ok"
            ? "approved it, with a note"
            : "commented";
      lines.push("", `### ${what}. Reviewer ${verdict}`, "");
      if (e.kind === "new") lines.push(`- The paragraph now reads: ${q(e.after)}`);
      if (e.kind === "removed") lines.push(`- The paragraph read: ${q(e.before)}`);
      if (e.kind === "changed") {
        const d = wordDiff(e.before, e.after);
        if (d.added.length) lines.push(`- Words the new version added: ${d.added.map(q).join("; ")}`);
        if (d.removed.length) lines.push(`- Words the new version removed: ${d.removed.map(q).join("; ")}`);
        lines.push(`- The paragraph now reads: ${q(e.after)}`, `- Before, it read: ${q(e.before)}`);
      }
      if (e.note) lines.push(`- **Reviewer's note:** ${e.note.replace(/\s*\n+\s*/g, " ")}`);
      if (e.suggestion) lines.push(`- **Reviewer's suggested wording for the whole paragraph:** ${q(e.suggestion)}`);
    }
    if (!items.length) lines.push("", "No rejections or notes.");
    return lines.join("\n");
  }

  // "1 ✓ 1 ✗ 1 ✎", or "" when nothing on the page is reviewed.
  function tally(sum) {
    if (!sum) return "";
    return [sum.ok && `${sum.ok} ✓`, sum.no && `${sum.no} ✗`, sum.noted && `${sum.noted} ✎`]
      .filter(Boolean)
      .join(" ");
  }

  // Whether a change has had any reaction: approved, rejected or a note.
  function reacted(data, id) {
    const e = data?.entries[id];
    return !!(e?.state || e?.note || e?.suggestion);
  }

  return { load, setPage, update, pageSummary, tally, reacted, feedback, markdown };
})();
