// Finds which pages of a site differ from the reference, for the badge's
// "pages" panel. It runs only when asked, and is built for sites of any size:
//
// - It reads at most a few thousand pages' addresses from the sitemaps.
// - It checks pages in batches, nearest the page you are on first, and the
//   user asks for each further batch.
// - It fetches a few pages at a time, and stops when told to.
// - It always says how many of how many pages it has checked.
//
// The pages come from the site's sitemap.xml, and the reference's (which
// catches pages that were removed). Without a sitemap, it follows links from
// the current page, staying inside the pair's "this site".

globalThis.RedlineScan ??= (() => {
  const MAX_PATHS = 5000; // addresses kept from sitemaps
  const MAX_SITEMAPS = 10; // files read from a sitemap index, per site
  const MAX_CRAWL = 200; // pages found by following links
  const AT_ONCE = 3; // pages fetched in parallel
  const SKIP =
    /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|mp[34]|webm|mov|woff2?|ttf|css|js|json|xml|txt|rss|atom)$/i;

  const get = (url) =>
    chrome.runtime
      .sendMessage({ type: "fetch", url })
      .catch((e) => ({ ok: false, status: 0, error: String(e) }));

  // A page of the pair, rendered in a background tab when the pair says so
  // (both sides, as an app drawn in the browser has no server text).
  const load = (pair, url) =>
    pair.render
      ? chrome.runtime
          .sendMessage({ type: "fetch", url, render: true, scope: pair.scope?.trim() || "" })
          .catch((e) => ({ ok: false, status: 0, error: String(e) }))
      : get(url);

  const parse = (html) => new DOMParser().parseFromString(html, "text/html");

  const pathOf = (url) => new URL(url).pathname.replace(/\/+$/, "");

  // A page's path below a root path, or null when it is outside it.
  const below = (path, root) =>
    !root
      ? path || "/"
      : path === root || path.startsWith(root + "/")
        ? path.slice(root.length) || "/"
        : null;

  // Addresses in a site's sitemaps. `total` counts every page the sitemaps
  // name, `paths` keeps at most MAX_PATHS of them; `complete` is false when
  // an index named more sitemaps than were read.
  async function sitemap(root, signal) {
    const out = { paths: [], total: 0, complete: true, found: false };
    const read = async (url, depth) => {
      if (signal.stopped) return;
      const res = await get(url);
      if (!res.ok || !/<(urlset|sitemapindex)\b/.test(res.text)) return;
      out.found = true;
      const xml = new DOMParser().parseFromString(res.text, "text/xml");
      const locs = [...xml.getElementsByTagName("loc")].map((l) => l.textContent.trim());
      if (xml.getElementsByTagName("sitemapindex").length) {
        if (depth > 0) return;
        if (locs.length > MAX_SITEMAPS) out.complete = false;
        for (const loc of locs.slice(0, MAX_SITEMAPS)) await read(loc, depth + 1);
        return;
      }
      out.total += locs.length;
      for (const loc of locs) {
        if (out.paths.length >= MAX_PATHS) break;
        try {
          // Sitemaps often name the production address even on a preview,
          // so only the path is kept.
          out.paths.push(new URL(loc).pathname);
        } catch {}
      }
    };
    await read(root + "/sitemap.xml", 0);
    return out;
  }

  // Pages nearest `here` first: those sharing more of its path, then
  // shallower ones, then in order.
  function nearest(rests, here) {
    const segs = (p) => p.split("/").filter(Boolean);
    const h = segs(here);
    const shared = (p) => {
      const s = segs(p);
      let n = 0;
      while (n < s.length && n < h.length && s[n] === h[n]) n++;
      return n;
    };
    return rests
      .map((p) => ({ p, shared: shared(p), depth: segs(p).length }))
      .sort((a, b) => b.shared - a.shared || a.depth - b.depth || a.p.localeCompare(b.p))
      .map((x) => x.p);
  }

  // Which pages there are. Resolves to { rests, total, complete, crawled }:
  // `rests` are paths below the pair's roots, nearest the current page first;
  // `total` is how many pages there are as far as is known; `complete` says
  // whether that is all of them; `crawled` holds pages already fetched.
  async function discover(pair, signal, progress) {
    const P = globalThis.RedlinePairs;
    const fromRoot = P.normalise(pair.from);
    const toRoot = P.normalise(pair.to);
    const fromPath = pathOf(fromRoot);
    const toPath = pathOf(toRoot);
    const here = below(location.pathname.replace(/\/+$/, ""), fromPath) ?? "/";
    const rests = new Set();
    const add = (rest) => {
      if (rest && !SKIP.test(rest) && rests.size < MAX_PATHS) rests.add(rest);
    };

    progress("reading sitemaps…");
    const [mine, theirs] = await Promise.all([
      sitemap(fromRoot, signal),
      sitemap(toRoot, signal),
    ]);
    for (const path of mine.paths)
      add(below(path, fromPath) ?? below(path, toPath));
    for (const path of theirs.paths) add(below(path, toPath));
    if (mine.found || theirs.found) {
      const total = Math.max(mine.total, theirs.total, rests.size);
      return {
        rests: nearest([...rests], here),
        total,
        complete:
          mine.complete && theirs.complete && rests.size >= Math.max(mine.total, theirs.total),
        crawled: new Map(),
      };
    }

    // No sitemap: follow links, inside this site's folder.
    const crawled = new Map();
    const queue = [here];
    const seen = new Set([here]);
    while (queue.length && crawled.size < MAX_CRAWL && !signal.stopped) {
      const batch = queue.splice(0, AT_ONCE);
      const pages = await Promise.all(batch.map((rest) => load(pair, fromRoot + rest)));
      for (const [k, res] of pages.entries()) {
        crawled.set(batch[k], res);
        if (!res.ok) continue;
        for (const a of parse(res.text).querySelectorAll("a[href]")) {
          let u;
          try {
            u = new URL(a.getAttribute("href"), fromRoot + batch[k]);
          } catch {
            continue;
          }
          if (u.origin !== new URL(fromRoot).origin) continue;
          const rest = below(u.pathname.replace(/\/+$/, ""), fromPath);
          if (!rest || SKIP.test(rest) || seen.has(rest)) continue;
          seen.add(rest);
          queue.push(rest);
        }
      }
      progress(`following links: ${crawled.size} pages…`);
    }
    return {
      rests: nearest([...seen], here),
      total: seen.size,
      complete: !queue.length && !signal.stopped,
      crawled,
    };
  }

  // Compares the pages `rests` on both sides, in order, until stopped.
  // Resolves to { items, done }: how many of `rests` it compared, and the
  // ones that differ: { path, url, count, state }, state "changed", "new" (only this
  // site has it) or "removed" (only the reference has it).
  async function check(pair, opt, rests, crawled, signal, progress) {
    const P = globalThis.RedlinePairs;
    const R = globalThis.Redline;
    const fromRoot = P.normalise(pair.from);
    const toRoot = P.normalise(pair.to);
    const texts = (res) => R.blocks(parse(res.text), opt).map((b) => b.text);
    const out = [];
    let done = 0;
    const one = async (rest) => {
      const url = fromRoot + rest;
      const [mine, theirs] = await Promise.all([
        crawled.get(rest) ?? load(pair, url),
        load(pair, toRoot + rest),
      ]);
      done++;
      progress(done);
      if (!mine.ok && !theirs.ok) return;
      if (!mine.ok) {
        if (mine.status === 404) out.push({ path: rest, url, count: null, state: "removed" });
        return;
      }
      if (!theirs.ok && theirs.status !== 404) return;
      const n = R.count(texts(mine), theirs.ok ? texts(theirs) : []);
      if (n) out.push({ path: rest, url, count: n, state: theirs.ok ? "changed" : "new" });
    };
    let k = 0;
    for (; k < rests.length && !signal.stopped; k += AT_ONCE)
      await Promise.all(rests.slice(k, k + AT_ONCE).map(one));
    return { items: out, done: Math.min(k, rests.length) };
  }

  return { discover, check };
})();
