// Which saved pair a page belongs to. Shared by the service worker, the
// content script and the settings page.
//
// A pair's "this site" is an origin, optionally with a path:
// http://localhost:3000 covers the whole site, while
// https://me.github.io/site/pr-preview/pr-5 covers only that folder, for
// previews served from a sub-path. The page's path below that folder is then
// looked up at the same place under "compare with".

globalThis.RedlinePairs ??= (() => {
  // The pair whose "this site" holds `href`, the most specific one first.
  function pairFor(pairs, href) {
    let best = null;
    let bestLen = -1;
    let page;
    try {
      page = new URL(href);
    } catch {
      return null;
    }
    for (const p of pairs) {
      let from;
      try {
        from = new URL(p.from);
      } catch {
        continue;
      }
      if (from.origin !== page.origin) continue;
      const root = from.pathname.replace(/\/+$/, "");
      if (root && page.pathname !== root && !page.pathname.startsWith(root + "/"))
        continue;
      if (root.length > bestLen) {
        best = p;
        bestLen = root.length;
      }
    }
    return best;
  }

  // The address of `href` on the pair's other site.
  function referenceFor(pair, href) {
    const page = new URL(href);
    const root = new URL(pair.from).pathname.replace(/\/+$/, "");
    const rest = page.pathname.slice(root.length) || "/";
    const to = pair.to.replace(/\/+$/, "");
    return to + (rest.startsWith("/") ? rest : "/" + rest) + page.search;
  }

  // "https://x.com/a/" and "https://x.com/a" are the same "this site".
  function normalise(url) {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, "");
  }

  return { pairFor, referenceFor, normalise };
})();
