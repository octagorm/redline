// Lists which pages of a site differ from the reference, for the badge's
// "pages" panel. It runs only when asked: it fetches every page twice.
//
// The pages come from the site's sitemap.xml, and the reference's (which
// catches pages that were removed). Without a sitemap, it follows links from
// the current page, staying inside the pair's "this site".

globalThis.RedlineScan ??= (() => {
  const MAX = 200;
  const AT_ONCE = 4;
  const SKIP = /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|mp[34]|webm|mov|woff2?|ttf|css|js|json|xml|txt)$/i;

  const get = (url) =>
    chrome.runtime
      .sendMessage({ type: "fetch", url })
      .catch((e) => ({ ok: false, status: 0, error: String(e) }));

  const parse = (html) => new DOMParser().parseFromString(html, "text/html");

  // Paths below `root` ("" or "/folder") from a sitemap, following one level
  // of sitemap index. Sitemaps often name the production address even on a
  // preview, so only the path is kept.
  async function fromSitemap(rootUrl) {
    const paths = new Set();
    const read = async (url, depth) => {
      const res = await get(url);
      if (!res.ok || !/<(urlset|sitemapindex)\b/.test(res.text)) return false;
      const xml = new DOMParser().parseFromString(res.text, "text/xml");
      const locs = [...xml.getElementsByTagName("loc")].map((l) => l.textContent.trim());
      if (xml.getElementsByTagName("sitemapindex").length) {
        if (depth > 0) return true;
        for (const loc of locs.slice(0, 20)) await read(loc, depth + 1);
        return true;
      }
      for (const loc of locs) {
        try {
          paths.add(new URL(loc).pathname);
        } catch {}
      }
      return true;
    };
    await read(rootUrl + "/sitemap.xml", 0);
    return paths;
  }

  // Follows links from `start`, inside `root`, up to MAX pages.
  async function crawl(start, root, seen, onPage) {
    const queue = [start];
    const inside = (u) =>
      u.origin === new URL(root).origin &&
      (u.pathname + "/").startsWith(new URL(root).pathname.replace(/\/?$/, "/")) &&
      !SKIP.test(u.pathname);
    seen.add(new URL(start).pathname);
    while (queue.length && seen.size < MAX) {
      const batch = queue.splice(0, AT_ONCE);
      const pages = await Promise.all(batch.map(get));
      for (const [k, res] of pages.entries()) {
        onPage(batch[k], res);
        if (!res.ok) continue;
        for (const a of parse(res.text).querySelectorAll("a[href]")) {
          let u;
          try {
            u = new URL(a.getAttribute("href"), batch[k]);
          } catch {
            continue;
          }
          if (!inside(u) || seen.has(u.pathname) || seen.size >= MAX) continue;
          seen.add(u.pathname);
          queue.push(u.origin + u.pathname);
        }
      }
    }
  }

  // Calls `progress(done, total)` as it goes; resolves to a list of
  // { path, url, count, state } with state "changed", "new" (the reference
  // does not have it) or "removed" (only the reference has it), changed
  // pages only.
  async function scan(pair, opt, progress) {
    const P = globalThis.RedlinePairs;
    const R = globalThis.Redline;
    const fromRoot = P.normalise(pair.from);
    const toRoot = P.normalise(pair.to);
    const fromPath = new URL(fromRoot).pathname.replace(/\/+$/, "");
    const toPath = new URL(toRoot).pathname.replace(/\/+$/, "");
    const texts = (res) => R.blocks(parse(res.text), opt).map((b) => b.text);

    // "rest" is a page's path below the root, the same on both sides.
    const rests = new Set();
    const ownPages = new Map(); // rest -> fetched own page, from the crawl
    const relTo = (path, base) =>
      base && (path === base || path.startsWith(base + "/")) ? path.slice(base.length) || "/" : null;

    for (const path of await fromSitemap(fromRoot)) {
      const rest = relTo(path, fromPath) ?? relTo(path, toPath) ?? (fromPath ? null : path);
      if (rest && !SKIP.test(rest)) rests.add(rest);
    }
    for (const path of await fromSitemap(toRoot)) {
      const rest = relTo(path, toPath) ?? (toPath ? null : path);
      if (rest && !SKIP.test(rest)) rests.add(rest);
    }
    if (!rests.size) {
      progress(0, 0);
      await crawl(location.origin + location.pathname, fromRoot, new Set(), (url, res) => {
        const rest = relTo(new URL(url).pathname, fromPath) ?? "/";
        rests.add(rest);
        ownPages.set(rest, res);
        progress(0, rests.size);
      });
    }

    const list = [...rests].slice(0, MAX);
    const out = [];
    let done = 0;
    progress(0, list.length);
    const one = async (rest) => {
      const url = fromRoot + rest;
      const [mine, theirs] = await Promise.all([
        ownPages.get(rest) ?? get(url),
        get(toRoot + rest),
      ]);
      done++;
      progress(done, list.length);
      if (!mine.ok && !theirs.ok) return;
      if (!mine.ok) {
        if (mine.status === 404) out.push({ path: rest, url, count: null, state: "removed" });
        return;
      }
      if (!theirs.ok && theirs.status !== 404) return;
      const n = R.count(texts(mine), theirs.ok ? texts(theirs) : []);
      if (n) out.push({ path: rest, url, count: n, state: theirs.ok ? "changed" : "new" });
    };
    for (let k = 0; k < list.length; k += AT_ONCE)
      await Promise.all(list.slice(k, k + AT_ONCE).map(one));
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  return { scan };
})();
