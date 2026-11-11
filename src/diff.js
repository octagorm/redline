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
  const OWN = ".redline-old, #redline-host";

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

  function wrapWords(list) {
    const byNode = new Map();
    for (const tok of list)
      for (const p of tok.pieces)
        byNode.set(p.node, [...(byNode.get(p.node) ?? []), p]);
    for (const [node, pieces] of byNode) {
      // Neighbouring new words become one run, so the highlight carries
      // across the spaces between them.
      const text = node.textContent ?? "";
      const runs = [];
      for (const p of pieces.sort((a, b) => a.start - b.start)) {
        const last = runs[runs.length - 1];
        if (last && !text.slice(last.end, p.start).trim()) last.end = p.end;
        else runs.push({ start: p.start, end: p.end });
      }
      // Back to front, so earlier offsets stay valid as the node is split.
      for (const p of runs.reverse()) {
        const word = node.splitText(p.start);
        word.splitText(p.end - p.start);
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
  function oldBlock(like, words, removed) {
    const el = document.createElement(like.tagName);
    el.className = like.className;
    el.classList.add("redline-old");
    if (removed) el.classList.add("redline-removed");
    el.style.cssText = like.style.cssText;
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
  // reference's block texts (`old`). Returns how many blocks differ.
  //
  // `own` is this page's text as its server sent it. When given, the diff is
  // between the two server versions, and the live page is used only to find
  // each block on screen; so text drawn by scripts in the browser (a clock, a
  // date) never counts as a change. Without it, the live page is diffed as is.
  function show(dom, old, own) {
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
    const removed = (text, before) => {
      const next = anchorFrom(before);
      const like = next ?? dom[dom.length - 1];
      if (!like) return;
      const el = oldBlock(
        like.el,
        text.split(" ").map((w) => ({ text: w, gone: true })),
        true
      );
      if (next) next.el.before(el);
      else like.el.after(el);
    };

    const kept = lcs(own, old, (a, b) => a === b);
    kept.push([own.length, old.length]);
    let count = 0;
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
        const b = at(i);
        count++;
        if (match < 0) {
          b?.el.setAttribute("data-redline-new", "");
          continue;
        }
        // Old blocks skipped on the way to the match were removed.
        for (let o = nextOld; o < match; o++) {
          removed(old[o], i);
          count++;
        }
        nextOld = match + 1;
        if (!b) continue;
        const was = old[match].split(" ");
        const same = lcs(b.toks, was, (t, w) => t.text === w);
        const keptNew = new Set(same.map(([x]) => x));
        const keptOld = new Set(same.map(([, y]) => y));
        b.el.setAttribute("data-redline-changed", "");
        b.el.after(
          oldBlock(
            b.el,
            was.map((text, k) => ({ text, gone: !keptOld.has(k) })),
            false
          )
        );
        const fresh = b.toks.filter((_, k) => !keptNew.has(k));
        // A changed word with no text of its own (an image) marks the block.
        if (fresh.some((t) => !t.pieces.length))
          b.el.setAttribute("data-redline-new", "");
        wrapWords(fresh);
      }
      for (let o = nextOld; o < kj; o++) {
        removed(old[o], ki);
        count++;
      }
      i = ki + 1;
      j = kj + 1;
    }
    return count;
  }

  // Undoes show(). The text nodes it split stay split, which reads the same.
  function clear(doc = document) {
    doc.querySelectorAll(".redline-old").forEach((e) => e.remove());
    doc
      .querySelectorAll("mark.redline-new")
      .forEach((m) => m.replaceWith(...m.childNodes));
    doc
      .querySelectorAll("[data-redline-new],[data-redline-changed]")
      .forEach((e) => {
        e.removeAttribute("data-redline-new");
        e.removeAttribute("data-redline-changed");
      });
  }

  const CSS = `
html.redline-on [data-redline-new] {
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
.redline-old { display: none !important; }
html.redline-before .redline-old {
  display: revert !important;
  background: rgba(230, 90, 80, 0.12) !important;
  box-shadow: -10px 0 0 rgba(230, 90, 80, 0.12), -13px 0 0 #d9534a !important;
}
html.redline-before .redline-old del {
  background: rgba(230, 90, 80, 0.32);
  text-decoration-color: #d9534a;
  color: inherit;
}
html.redline-before [data-redline-changed],
html.redline-before [data-redline-new] { display: none !important; }
html.redline-on:not(.redline-before) .redline-old.redline-removed {
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

  return { DEFAULT_BLOCKS, tokens, blocks, lcs, similarity, show, clear, CSS };
})();
