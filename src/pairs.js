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

  // A page's path below the pair's "this site", the same on both sides.
  function restFor(pair, href) {
    const root = new URL(pair.from).pathname.replace(/\/+$/, "");
    const rest = new URL(href).pathname.slice(root.length) || "/";
    return rest.startsWith("/") ? rest : "/" + rest;
  }

  // The address of `href` on the pair's other site.
  function referenceFor(pair, href) {
    const page = new URL(href);
    const rest = restFor(pair, href);
    const to = pair.to.replace(/\/+$/, "");
    return to + (rest.startsWith("/") ? rest : "/" + rest) + page.search;
  }

  // "https://x.com/a/" and "https://x.com/a" are the same "this site".
  function normalise(url) {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, "");
  }

  // A site can say what to compare it with, so nobody has to set it up:
  //   <meta name="redline" content="https://example.com">
  //   <meta name="redline-root" content="/pr-preview/pr-5/">   (optional)
  //   <meta name="redline-ignore" content="nav, footer, sup">  (optional)
  //   <meta name="redline-render" content="true">          (optional)
  //   <meta name="redline-scope" content="#app">           (optional)
  // `meta` holds those contents, as readMeta() returns them. The tag
  // wins over a saved pair, so a second project served on the same
  // localhost port compares with its own reference, not the last one's.
  function hintFrom(meta, href) {
    if (!meta?.to) return null;
    try {
      const to = new URL(meta.to, href);
      if (!/^https?:$/.test(to.protocol)) return null;
      let from = normalise(new URL(meta.root || "/", href).href);
      // A root the page is not under is a mistake; fall back to the site.
      if (!pairFor([{ from }], href)) from = new URL(href).origin;
      return {
        from,
        to: normalise(to.href),
        ignore: meta.ignore ?? "nav, footer",
        blocks: "",
        scope: meta.scope ?? "",
        render: meta.render != null && !/^(false|0|no|off)$/i.test(meta.render),
        fromSite: true,
      };
    } catch {
      return null;
    }
  }

  // Runs in the page. Self-contained, so it can be injected on its own.
  function readMeta() {
    const meta = (n) =>
      document.querySelector(`meta[name="${n}"]`)?.getAttribute("content")?.trim();
    return {
      to: meta("redline"),
      root: meta("redline-root"),
      ignore: meta("redline-ignore"),
      render: meta("redline-render"),
      scope: meta("redline-scope"),
    };
  }

  return { pairFor, referenceFor, restFor, normalise, hintFrom, readMeta };
})();
