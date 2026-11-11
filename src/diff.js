// The diff itself, with no extension APIs, so it can run in a plain page too.
// Ported from heavenandearth.watch's `?new` review mode.
//
// A page is read as a list of text blocks (paragraphs, headings, list items,
// cells…). Both pages, the live one and the fetched reference, are read with
// the same rules, then:
//   1. blocks are aligned by longest common subsequence;
//   2. between two unchanged blocks, a new block that shares at least 40% of
//      its words (Dice) with a reference block is a rewrite of it, and gets a
//      word-level diff; one that shares less is new;
//   3. reference blocks left unmatched were removed.
// New words are wrapped in <mark>; each changed block gets its old wording
// inserted after it, hidden until "before" is on.

globalThis.Redline ??= (() => {
  const DEFAULT_BLOCKS =
    "p,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote,pre,td,th,caption,figure,summary";
  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "IFRAME",
    "CANVAS",
  ]);
  // Elements that break a word even when there is no space around them.
  const BREAKS = new Set([
    "BR",
    "P",
    "DIV",
    "LI",
    "TD",
    "TH",
    "TR",
    "SECTION",
    "ARTICLE",
    "HR",
  ]);
  // Redline's own nodes, never read as page text.
  const OWN = ".redline-old, .redline-gone, #redline-host";

  // A whitespace-separated word. It may span several text nodes
  // (Hildeyard<em>'s</em>), and an image contributes a word with no pieces.
  function tokens(el, ignore) {
    const out = [];
    let open = null; // a word that may continue in the next text node
    const walk = (parent) => {
      for (const n of parent.childNodes) {
        if (n.nodeType === 3) {
          const text = n.textContent ?? "";
          const re = /\S+/g;
          let m;
          while ((m = re.exec(text))) {
            const piece = {
              node: n,
              start: m.index,
              end: m.index + m[0].length,
            };
            if (open && m.index === 0) {
              open.text += m[0];
              open.pieces.push(piece);
            } else {
              open = { text: m[0], pieces: [piece] };
              out.push(open);
            }
            if (piece.end < text.length) open = null;
          }
          if (text.length && /\s$/.test(text)) open = null;
        } else if (n.nodeType === 1) {
          const tag = n.tagName.toUpperCase();
          if (SKIP.has(tag) || n.hidden) continue;
          if (ignore && n.matches(ignore)) continue;
          if (n.matches(OWN)) continue;
          if (tag === "IMG") {
            const alt = (n.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
            if (alt) out.push({ text: `[${alt}]`, pieces: [] });
            open = null;
          } else {
            if (BREAKS.has(tag)) open = null;
            walk(n);
            if (BREAKS.has(tag)) open = null;
          }
        }
      }
    };
    walk(el);
    return out;
  }

  // The text blocks of a document, innermost only: a block holding another
  // block is skipped (its loose text with it), as nested lists would otherwise
  // count twice.
  function blocks(doc, opt = {}) {
    const sel = opt.blocks || DEFAULT_BLOCKS;
    const out = [];
    for (const el of doc.querySelectorAll(sel)) {
      if (el.closest(OWN)) continue;
      if (opt.ignore && el.closest(opt.ignore)) continue;
      if (el.closest("[hidden],template")) continue;
      if (el.querySelector(sel)) continue;
      const toks = tokens(el, opt.ignore);
      if (toks.length)
        out.push({ el, toks, text: toks.map((t) => t.text).join(" ") });
    }
    return out;
  }

  // Longest common subsequence: the index pairs that match, in order. The
  // common head and tail are taken off first, which on a page with a few
  // changes leaves a small table.
  function lcs(a, b, same) {
    let head = 0;
    while (head < a.length && head < b.length && same(a[head], b[head])) head++;
    let tail = 0;
    while (
      tail < a.length - head &&
      tail < b.length - head &&
      same(a[a.length - 1 - tail], b[b.length - 1 - tail])
    )
      tail++;
    const pairs = [];
    for (let k = 0; k < head; k++) pairs.push([k, k]);
    const n = a.length - head - tail;
    const m = b.length - head - tail;
    if (n > 0 && m > 0) {
      const w = m + 1;
      const t = new Uint32Array((n + 1) * w);
      const eq = (i, j) => same(a[head + i], b[head + j]);
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          t[i * w + j] = eq(i, j)
            ? t[(i + 1) * w + j + 1] + 1
            : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (eq(i, j)) pairs.push([head + i++, head + j++]);
        else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
        else j++;
      }
    }
    for (let k = tail; k > 0; k--)
      pairs.push([a.length - k, b.length - k]);
    return pairs;
  }

  // Share of words two blocks have in common (Dice), to tell a rewritten
  // paragraph from one removed next to one added.
  function similarity(a, b) {
    const x = new Set(a.split(" "));
    const y = new Set(b.split(" "));
    let both = 0;
    for (const word of x) if (y.has(word)) both++;
    return (2 * both) / (x.size + y.size || 1);
  }

  // Marks a block's new words with <mark> and puts its removed words back in
  // with <del>, where they stood. `fresh` are the new tokens; each of `gaps` is
  // a run of removed words and the token it follows (-1: the block's start).
  function markUp(el, toks, fresh, gaps) {
    const ops = new Map(); // text node -> its marks and insertions
    const add = (node, op) => ops.set(node, [...(ops.get(node) ?? []), op]);
    for (const tok of fresh)
      for (const p of tok.pieces) add(p.node, { kind: "mark", ...p });

    const gone = (text, lead) => {
      // The space goes inside the wrapper, so hiding it leaves no gap.
      const span = document.createElement("span");
      span.className = "redline-gone";
      const del = document.createElement("del");
      del.textContent = text;
      if (lead) span.append(" ", del);
      else span.append(del, " ");
      return span;
    };
    for (const { after, text } of gaps) {
      const prev = toks[after]?.pieces.at(-1);
      if (prev) {
        add(prev.node, { kind: "insert", pos: prev.end, el: gone(text, true) });
        continue;
      }
      const next = toks.slice(after + 1).find((t) => t.pieces.length)?.pieces[0];
      if (next) add(next.node, { kind: "insert", pos: next.start, el: gone(text, false) });
      else el.append(gone(text, true));
    }

    for (const [node, list] of ops) {
      // Neighbouring new words become one run, so the highlight carries
      // across the spaces between them.
      const text = node.textContent ?? "";
      const runs = [];
      for (const p of list
        .filter((o) => o.kind === "mark")
        .sort((a, b) => a.start - b.start)) {
        const last = runs[runs.length - 1];
        if (last && !text.slice(last.end, p.start).trim()) last.end = p.end;
        else runs.push({ kind: "mark", pos: p.start, end: p.end });
      }
      // Back to front, so earlier offsets stay valid as the node is split. At
      // the same offset a mark goes first, so a deletion lands before it.
      const all = [...runs, ...list.filter((o) => o.kind === "insert")].sort(
        (a, b) => b.pos - a.pos || (a.kind === "mark" ? -1 : 1)
      );
      for (const op of all) {
        if (op.kind === "insert") {
          node.splitText(op.pos).before(op.el);
          continue;
        }
        const word = node.splitText(op.pos);
        word.splitText(op.end - op.pos);
        const mark = document.createElement("mark");
        mark.className = "redline-new";
        word.replaceWith(mark);
        mark.append(word);
      }
    }
  }

  // The reference's version of a block, shown only in "before". It takes the
  // tag and classes of the live block it stands next to, so it is styled the
  // same. `words` marks which of its words are gone.
  //
  // A removed block has no live counterpart: it is built from the reference's
  // own element (`ref`: { tag, className }), so a removed paragraph looks like
  // a paragraph even when it is placed next to a heading.
  const IN_LIST = new Set(["LI", "DT", "DD", "TD", "TH", "CAPTION", "SUMMARY"]);
  function oldBlock(like, words, removed, ref) {
    let tag = like.tagName;
    let cls = like.className;
    let css = like.style.cssText;
    if (ref) {
      tag = ref.tag;
      cls = ref.className;
      css = "";
      // An item of a list or table only fits beside another of its kind.
      if (IN_LIST.has(tag) && tag !== like.tagName) tag = "P";
    }
    const el = document.createElement(tag);
    el.className = typeof cls === "string" ? cls : "";
    el.classList.add("redline-old");
    if (removed) el.classList.add("redline-removed");
    el.style.cssText = css;
    // Neighbouring gone words share one <del>, as new words share one <mark>.
    let del = null;
    for (const [i, w] of words.entries()) {
      if (w.gone && del) {
        del.append(" " + w.text);
        continue;
      }
      if (i) el.append(" ");
      if (w.gone) {
        del = document.createElement("del");
        del.textContent = w.text;
        el.append(del);
      } else {
        del = null;
        el.append(w.text);
      }
    }
    return el;
  }

  // Marks up the live page (`dom`, from blocks(document)) against the
  // reference's block texts (`old`). Returns the changes, each
  // { id, kind: "new" | "changed" | "removed", before, after }.
  //
  // `own` is this page's text as its server sent it. When given, the diff is
  // between the two server versions, and the live page is used only to find
  // each block on screen; so text drawn by scripts in the browser (a clock, a
  // date) never counts as a change. Without it, the live page is diffed as is.
  function show(dom, oldBlocks, own) {
    // The reference may be given as block texts, or as blocks() of its
    // document, which also tells removed blocks what element they were.
    const refs = oldBlocks.map((b) =>
      typeof b === "string" ? null : { tag: b.el.tagName, className: b.el.getAttribute("class") ?? "" }
    );
    const old = oldBlocks.map((b) => (typeof b === "string" ? b : b.text));
    let at = (i) => dom[i];
    if (own) {
      const where = new Map(lcs(own, dom, (o, d) => o === d.text));
      at = (i) => {
        const d = where.get(i);
        return d === undefined ? undefined : dom[d];
      };
    } else own = dom.map((d) => d.text);
    // The nearest block on the page at or after own[i], to hang a removed one on.
    const anchorFrom = (i) => {
      for (let k = i; k < own.length; k++) if (at(k)) return at(k);
      return undefined;
    };
    // Every change, with an id made from its text: a review of it holds for
    // as long as the change stays the same.
    const changes = [];
    const note = (kind, before, after, ...els) => {
      const id = changeId(kind, before, after);
      for (const el of els) el.setAttribute("data-redline-id", id);
      changes.push({ id, kind, before, after });
    };
    const removed = (o, before) => {
      const text = old[o];
      const next = anchorFrom(before);
      const like = next ?? dom[dom.length - 1];
      if (!like) return;
      const el = oldBlock(
        like.el,
        text.split(" ").map((w) => ({ text: w, gone: true })),
        true,
        refs[o]
      );
      if (next) next.el.before(el);
      else like.el.after(el);
      note("removed", text, "", el);
    };

    const kept = lcs(own, old, (a, b) => a === b);
    kept.push([own.length, old.length]);
    let i = 0;
    let j = 0;
    for (const [ki, kj] of kept) {
      // Between two unchanged blocks: own[i..ki) are new or rewritten,
      // old[j..kj) are removed or their earlier wording.
      let nextOld = j;
      for (; i < ki; i++) {
        let match = -1;
        for (let o = nextOld; o < kj; o++)
          if (similarity(own[i], old[o]) >= 0.4) {
            match = o;
            break;
          }
        // A block with nowhere to show on the live page (a script replaced
        // it) cannot be marked, so it is not counted either.
        const b = at(i);
        if (match < 0) {
          if (b) {
            b.el.setAttribute("data-redline-new", "");
            note("new", "", own[i], b.el);
          }
          continue;
        }
        // Old blocks skipped on the way to the match were removed.
        for (let o = nextOld; o < match; o++) removed(o, i);
        nextOld = match + 1;
        if (!b) continue;
        const was = old[match].split(" ");
        const same = lcs(b.toks, was, (t, w) => t.text === w);
        const keptNew = new Set(same.map(([x]) => x));
        const keptOld = new Set(same.map(([, y]) => y));
        b.el.setAttribute("data-redline-changed", "");
        const copy = oldBlock(
          b.el,
          was.map((text, k) => ({ text, gone: !keptOld.has(k) })),
          false
        );
        b.el.after(copy);
        note("changed", old[match], own[i], b.el, copy);
        const fresh = b.toks.filter((_, k) => !keptNew.has(k));
        // A changed word with no text of its own (an image) marks the block.
        if (fresh.some((t) => !t.pieces.length))
          b.el.setAttribute("data-redline-new", "");
        // Runs of removed words, each after the kept word that precedes it.
        const gaps = [];
        let after = -1;
        let y = 0;
        for (const [x, yy] of [...same, [b.toks.length, was.length]]) {
          if (y < yy) gaps.push({ after, text: was.slice(y, yy).join(" ") });
          after = x;
          y = yy + 1;
        }
        markUp(b.el, b.toks, fresh, gaps);
      }
      for (let o = nextOld; o < kj; o++) removed(o, ki);
      i = ki + 1;
      j = kj + 1;
    }
    return changes;
  }

  // A short id for a change, from its kind and text (FNV-1a).
  function changeId(kind, before, after) {
    let h = 0x811c9dc5;
    for (const ch of `${kind}\u0000${before}\u0000${after}`) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  // How many blocks show() would mark, from the texts alone: for listing the
  // changed pages of a site without opening them.
  function count(own, old) {
    const kept = lcs(own, old, (a, b) => a === b);
    kept.push([own.length, old.length]);
    let n = 0;
    let i = 0;
    let j = 0;
    for (const [ki, kj] of kept) {
      let nextOld = j;
      for (; i < ki; i++) {
        n++;
        for (let o = nextOld; o < kj; o++)
          if (similarity(own[i], old[o]) >= 0.4) {
            n += o - nextOld; // removed on the way to the rewrite
            nextOld = o + 1;
            break;
          }
      }
      n += kj - nextOld;
      i = ki + 1;
      j = kj + 1;
    }
    return n;
  }

  // Undoes show(). The text nodes it split stay split, which reads the same.
  function clear(doc = document) {
    doc.querySelectorAll(".redline-old, .redline-gone").forEach((e) => e.remove());
    doc
      .querySelectorAll("mark.redline-new")
      .forEach((m) => m.replaceWith(...m.childNodes));
    doc
      .querySelectorAll("[data-redline-new],[data-redline-changed],[data-redline-id]")
      .forEach((e) => {
        e.removeAttribute("data-redline-new");
        e.removeAttribute("data-redline-changed");
        e.removeAttribute("data-redline-id");
        e.removeAttribute("data-redline-review");
      });
  }

  // Three modes, as a class on <html>: "all" (the default) shows new words
  // and removed ones side by side; "added" only the new words; "removed" the
  // reference's wording, removed words struck through.
  const CSS = `
html.redline-on:not(.redline-removed-only) [data-redline-new] {
  background: rgba(240, 190, 80, 0.16) !important;
  box-shadow: -10px 0 0 rgba(240, 190, 80, 0.16), -13px 0 0 #e0aa3e !important;
}
html.redline-on mark.redline-new {
  background: rgba(240, 190, 80, 0.38) !important;
  color: inherit !important;
  border-radius: 3px;
  padding: 1px 3px;
  margin: 0 -3px;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
html.redline-on .redline-gone del,
html.redline-on .redline-old del {
  text-decoration: line-through !important;
  text-decoration-color: #d9534a !important;
  background: rgba(230, 90, 80, 0.3) !important;
  color: inherit !important;
  border-radius: 3px;
  padding: 1px 3px;
  margin: 0 -3px;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.redline-gone { display: none !important; }
html.redline-all .redline-gone { display: inline !important; }
.redline-old { display: none !important; }
html.redline-removed-only .redline-old,
html.redline-all .redline-old.redline-removed {
  display: revert !important;
  background: rgba(230, 90, 80, 0.12) !important;
  box-shadow: -10px 0 0 rgba(230, 90, 80, 0.12), -13px 0 0 #d9534a !important;
}
html.redline-all .redline-old.redline-removed del { background: none !important; }
html.redline-removed-only [data-redline-changed],
html.redline-removed-only [data-redline-new] { display: none !important; }
/* Reviewed: approved changes turn green and quiet, rejected ones get a red ring. */
html.redline-on [data-redline-review="ok"] {
  box-shadow: -10px 0 0 rgba(80, 170, 110, 0.12), -13px 0 0 #3c9a5f !important;
}
html.redline-on [data-redline-review="ok"][data-redline-new],
html.redline-on .redline-old[data-redline-review="ok"] {
  background: rgba(80, 170, 110, 0.1) !important;
}
html.redline-on [data-redline-review="ok"] mark.redline-new {
  background: rgba(80, 170, 110, 0.25) !important;
}
html.redline-on [data-redline-review="no"] {
  outline: 2px solid #d9534a !important;
  outline-offset: 3px;
  border-radius: 2px;
}
html.redline-on [data-redline-noted]::after {
  content: " ✎";
  color: #c08a2e;
  font-weight: 700;
}
html.redline-added .redline-old.redline-removed {
  display: block !important;
  height: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  margin: 10px 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-top: 2px dashed #d9534a !important;
  background: none !important;
  box-shadow: none !important;
}`;

  return { DEFAULT_BLOCKS, tokens, blocks, lcs, similarity, show, count, clear, CSS };
})();
