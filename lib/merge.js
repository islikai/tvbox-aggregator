'use strict';
/**
 * 纯函数模块：URL 解析、GitHub 直链/加速链识别、多配置合并。
 * 无副作用、无网络请求，便于单元测试。
 */

/** 是否是 http(s) URL 字符串 */
function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

/** 以 ref 为基准把 u 解析成绝对 URL；解析不了原样返回 */
function resolveUrl(ref, u) {
  if (typeof u !== 'string' || !u.trim()) return u;
  const s = u.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'http:' + s;
  if (!isHttpUrl(ref)) return s;
  try { return new URL(s, ref).href; } catch { return s; }
}

/** 剥掉 gh-proxy 系加速外壳：https://<任意镜像域名>/https://raw.githubusercontent.com/... */
function unwrapMirror(u) {
  let s = String(u);
  for (let i = 0; i < 2; i++) {
    const m = s.match(/^https?:\/\/[^/\s]+\/(https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/\S+)$/i);
    if (!m) break;
    s = m[1];
  }
  return s;
}

/** 是否已经是 jsDelivr 的 gh 链接 */
function isJsdelivr(u) {
  return /^https?:\/\/[^/\s]*jsdelivr\.net\/gh\//i.test(String(u));
}

/**
 * 从各种 GitHub 直链/加速链中提取 {owner, repo, branch, path, pathEnc, raw}。
 * 支持：
 *  - raw.githubusercontent.com/:owner/:repo/:branch/:path
 *  - github.com/:owner/:repo/raw|blob/:branch/:path
 *  - <任意镜像>/https://raw.githubusercontent.com/...（gh-proxy.com / gh-proxy.org / ghfast.top 等）
 *  - cdn.jsdelivr.net/gh/:owner/:repo(@:branch)/:path
 *  非 GitHub 链接返回 null。jsDelivr 链接返回 {jsdelivr:true, owner, repo, branch, path, raw}
 * （未带 @branch 时 raw 为空串，镜像/API 通道退化为 owner/repo 定位）。
 */
function parseGithubUrl(u) {
  if (typeof u !== 'string') return null;
  const s = unwrapMirror(u);

  let m = s.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(\S+?)(?:[?#].*)?$/i);
  if (m) return { owner: m[1], repo: m[2], branch: m[3], path: safeDecode(m[4]), pathEnc: m[4], raw: s };

  m = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:raw|blob)\/([^/\s]+)\/(\S+?)(?:[?#].*)?$/i);
  if (m) return {
    owner: m[1], repo: m[2], branch: m[3], path: safeDecode(m[4]), pathEnc: m[4],
    raw: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
  };

  if (isJsdelivr(s)) {
    m = s.match(/^https?:\/\/[^/\s]*jsdelivr\.net\/gh\/([^/@\s]+)\/([^/@\s]+?)(?:@([^/\s]+))?\/(\S+?)(?:[?#].*)?$/i);
    if (m) {
      const branch = m[3] || '';
      return {
        jsdelivr: true, owner: m[1], repo: m[2], branch,
        path: safeDecode(m[4]), pathEnc: m[4],
        raw: branch ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : '',
      };
    }
  }
  return null;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** GitHub 文件 → jsDelivr CDN 链接（.json/.txt 可用，.jar 会被 jsDelivr 拒绝） */
function toJsdelivrUrl(u) {
  const g = parseGithubUrl(u);
  if (!g || g.jsdelivr || !g.branch) return null;
  return `https://cdn.jsdelivr.net/gh/${g.owner}/${g.repo}@${g.branch}/${g.pathEnc}`;
}

/**
 * 解析「资产型」字段：只有绝对 URL 或 ./ ../ / 开头的路径才解析；
 * 其余（如爬虫类名 csp_XXX、内联 ext 文本）原样保留，避免误伤。
 */
function resolveAsset(ref, u) {
  if (typeof u !== 'string' || !u) return u;
  if (/^(https?:)?\/\//i.test(u)) return u;
  if (/^(\.\/|\.\.\/|\/)/.test(u)) return resolveUrl(ref, u);
  return u;
}

/** spider 字段形如 "url;md5;hash"，只改 URL 部分再拼回去 */
function resolveSpider(sp, base) {
  if (typeof sp !== 'string' || !sp) return sp;
  const parts = sp.split(';');
  parts[0] = resolveAsset(base, parts[0]);
  return parts.join(';');
}

/** 站点是否依赖 jar（csp 爬虫站） */
function isSpiderSite(s) { return s && (s.type === 3 || s.type === 4); }

/**
 * 合并多个 TVBox 配置（items 顺序 = 优先级，先到先得）。
 * @param {Array<{name:string, url:string, config:object}>} items
 * @param {object} opts
 *   dedupeByName  按站点名精确去重（默认 true）
 *   jarPolicy     'vote' 按 type3 贡献票数定全局 spider | 'first' 第一个非空 | 'none' 不设
 *   siteJarInject 给与全局 jar 不一致的上游的 csp 站点注入 site 级 jar（FongMi/OK影视 支持）
 *   maxSites/maxLives/maxParses  数量上限，0 = 不限
 * @returns {{config:object, stats:object}}
 */
function mergeConfigs(items, opts = {}) {
  const o = Object.assign(
    { dedupeByName: true, jarPolicy: 'vote', siteJarInject: true, maxSites: 0, maxLives: 60, maxParses: 80 },
    opts
  );
  const stats = { dupKey: 0, dupName: 0, droppedLive: 0, droppedParse: 0, perOrigin: [] };

  const sites = [];            // {site, oi} oi = 来源序号
  const lives = [], parses = [], flags = [], rules = [];
  const seenKey = new Set(), seenName = new Set(), seenLive = new Set(), seenParse = new Set(), seenRule = new Set();
  const rest = {};             // 其余顶层标量字段，先到先得
  const origins = [];

  for (let oi = 0; oi < items.length; oi++) {
    const it = items[oi];
    const c = it.config || {};
    let kept = 0, t3 = 0;

    for (const s of Array.isArray(c.sites) ? c.sites : []) {
      if (!s || typeof s.key !== 'string' || !s.key || !s.api) continue;
      if (seenKey.has(s.key)) { stats.dupKey++; continue; }
      const nm = typeof s.name === 'string' ? s.name.trim() : '';
      if (o.dedupeByName && nm && seenName.has(nm)) { stats.dupName++; continue; }
      seenKey.add(s.key);
      if (nm) seenName.add(nm);
      const site = Object.assign({}, s);
      if (typeof site.ext === 'string') site.ext = resolveAsset(it.url, site.ext);
      if (typeof site.api === 'string') site.api = resolveAsset(it.url, site.api);
      if (typeof site.jar === 'string') site.jar = resolveAsset(it.url, site.jar);
      sites.push({ site, oi });
      kept++;
      if (isSpiderSite(site)) t3++;
    }

    for (const lv of Array.isArray(c.lives) ? c.lives : []) {
      if (!lv || typeof lv !== 'object') continue;
      const e = Object.assign({}, lv);
      if (typeof e.url === 'string') e.url = resolveAsset(it.url, e.url);
      if (typeof e.epg === 'string') e.epg = resolveAsset(it.url, e.epg);
      const k = (e.name || '') + '|' + (e.url || '');
      if (seenLive.has(k)) { stats.droppedLive++; continue; }
      seenLive.add(k);
      lives.push(e);
    }

    for (const p of Array.isArray(c.parses) ? c.parses : []) {
      if (!p || typeof p !== 'object') continue;
      const e = Object.assign({}, p);
      if (typeof e.url === 'string') e.url = resolveAsset(it.url, e.url);
      if (typeof e.ext === 'string') e.ext = resolveAsset(it.url, e.ext);
      const k = (e.name || '') + '|' + (e.url || '');
      if (seenParse.has(k)) { stats.droppedParse++; continue; }
      seenParse.add(k);
      parses.push(e);
    }

    for (const f of Array.isArray(c.flags) ? c.flags : []) {
      if (typeof f === 'string' && !flags.includes(f)) flags.push(f);
    }
    for (const r of Array.isArray(c.rules) ? c.rules : []) {
      if (!r || typeof r !== 'object') continue;
      const k = stableStringify(r);
      if (seenRule.has(k)) continue;
      seenRule.add(k);
      rules.push(r);
    }
    // wallpaper / danmaku 等其余标量字段：先到先得
    for (const k of Object.keys(c)) {
      if (['sites', 'lives', 'parses', 'flags', 'rules', 'spider', 'urls', 'storeHouse'].includes(k)) continue;
      if (k in rest) continue;
      const v = c[k];
      if (v === undefined || v === null || v === '') continue;
      rest[k] = isHttpUrl(v) ? resolveUrl(it.url, v) : v;
    }

    origins.push({
      name: it.name, url: it.url, kept, t3,
      spider: typeof c.spider === 'string' && c.spider ? resolveSpider(c.spider, it.url) : '',
    });
  }

  // ---- 全局 spider 投票：贡献 csp 站点最多的上游的 jar 胜出 ----
  let winner = -1, winnerVotes = -1;
  origins.forEach((og, i) => {
    if (!og.spider) return;
    const votes = o.jarPolicy === 'first' ? Infinity : og.t3;
    if (votes > winnerVotes) { winnerVotes = votes; winner = i; }
  });
  if (o.jarPolicy === 'none') winner = -1;

  // ---- site 级 jar 注入：败方 jar 的 csp 站点带上自己的 jar ----
  const outSites = sites.map(({ site, oi }) => {
    if (o.siteJarInject && isSpiderSite(site) && !site.jar) {
      const og = origins[oi];
      if (og && og.spider && oi !== winner) site.jar = og.spider;
    }
    return site;
  });

  if (o.maxSites > 0 && outSites.length > o.maxSites) outSites.length = o.maxSites;
  if (o.maxLives > 0 && lives.length > o.maxLives) lives.length = o.maxLives;
  if (o.maxParses > 0 && parses.length > o.maxParses) parses.length = o.maxParses;

  const config = {};
  if (winner >= 0) config.spider = origins[winner].spider;
  Object.assign(config, rest); // wallpaper 等放前面，保持常见字段顺序
  config.sites = outSites;
  config.lives = lives;
  config.parses = parses;
  if (flags.length) config.flags = flags;
  if (rules.length) config.rules = rules;

  stats.sitesKept = outSites.length;
  stats.livesKept = lives.length;
  stats.parsesKept = parses.length;
  stats.spiderSource = winner >= 0 ? origins[winner].name : '';
  stats.jarConflicts = origins
    .filter((og, i) => og.spider && i !== winner)
    .map(og => ({ name: og.name, spider: og.spider.slice(0, 80), cspSites: og.t3 }));
  stats.perOrigin = origins.map(og => ({ name: og.name, kept: og.kept, csp: og.t3 }));
  return { config, stats };
}

/** 稳定字符串化（对象键排序），用于 rules 去重 */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

module.exports = {
  isHttpUrl, resolveUrl, parseGithubUrl, toJsdelivrUrl,
  resolveSpider, mergeConfigs, stableStringify,
};