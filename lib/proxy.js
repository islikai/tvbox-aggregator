'use strict';
/**
 * 传输层：智能抓取链 + 磁盘资产缓存。
 * 抓取链（逐级尝试，成功即返）：
 *   1. 直连（可配置跳过已知不通的宿主，默认跳过 raw.githubusercontent.com）
 *   2. jsDelivr（仅 GitHub 文件；.jar 会被 jsDelivr 拒绝，自动落到下一级）
 *   3. gh 镜像（默认 https://gh-proxy.org/，可配多个）
 *   4. GitHub API（api.github.com 的 tree+blobs 接口，可拿任意文件含 .jar；有速率预算）
 *   5. 全部失败 → 调用方拿到 ok:false，路由层 302 回退原始 URL 让客户端自己试
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseGithubUrl, toJsdelivrUrl } = require('./merge.js');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 TVBoxAggregator/1.0';

let settings = {
  cacheDir: path.join(__dirname, '..', 'cache', 'assets'),
  mirrors: ['https://gh-proxy.org/'],
  skipDirectHosts: ['raw.githubusercontent.com'],
  apiBudgetPerHour: 40,   // api.github.com 未认证限额 60/h，留余量
};

const stats = { direct: 0, jsdelivr: 0, mirror: 0, githubApi: 0, fail: 0, cacheHit: 0 };
const apiCalls = []; // 时间戳窗口
const treeCache = new Map(); // repo -> {at, map(path->sha)}

/**
 * 更新代理设置（可反复调用以支持 config.json 热重载）。
 * 只接受类型正确的字段，undefined / 类型不符一律沿用当前值，
 * 避免 config.json 少写字段导致抓取链 TypeError。
 */
function initProxy(opts = {}) {
  settings = Object.assign({}, settings, {
    ...(typeof opts.cacheDir === 'string' ? { cacheDir: opts.cacheDir } : {}),
    ...(Array.isArray(opts.mirrors) ? { mirrors: opts.mirrors } : {}),
    ...(Array.isArray(opts.skipDirectHosts) ? { skipDirectHosts: opts.skipDirectHosts } : {}),
    ...(Number.isFinite(opts.apiBudgetPerHour) ? { apiBudgetPerHour: opts.apiBudgetPerHour } : {}),
  });
  fs.mkdirSync(settings.cacheDir, { recursive: true });
}

function apiBudgetLeft() {
  const now = Date.now();
  while (apiCalls.length && now - apiCalls[0] > 3600e3) apiCalls.shift();
  return settings.apiBudgetPerHour - apiCalls.length;
}

/** 底层 HTTP GET，返回 Buffer */
async function httpGet(url, { timeout = 12000, accept } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) },
    });
    const body = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, body, contentType: r.headers.get('content-type') || '', url: r.url };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e), body: null, contentType: '' };
  } finally { clearTimeout(timer); }
}

/** GitHub API GET（带预算记账） */
async function ghApiGet(apiPath, { timeout = 15000, accept = 'application/vnd.github+json' } = {}) {
  if (apiBudgetLeft() <= 0) return { ok: false, status: 429, error: 'api-budget-exhausted', body: null };
  apiCalls.push(Date.now());
  return httpGet(`https://api.github.com${apiPath}`, { timeout, accept });
}

/** 取仓库文件树（path -> blob sha），10 分钟内存缓存 */
async function ghTree(owner, repo, branch) {
  const key = `${owner}/${repo}@${branch}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.map;
  const r = await ghApiGet(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch || 'HEAD')}?recursive=1`, { timeout: 20000 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.body.toString('utf8'));
    const map = new Map();
    for (const t of j.tree || []) if (t.type === 'blob') map.set(t.path, t.sha);
    treeCache.set(key, { at: Date.now(), map });
    return map;
  } catch { return null; }
}

/** 通过 GitHub API 拉仓库文件原始内容（tree 定位 sha → blobs 原始流） */
async function ghApiFile(g) {  const tree = await ghTree(g.owner, g.repo, g.branch);
  if (!tree) return { ok: false, status: 0, error: 'tree-unavailable', body: null, contentType: '' };
  const sha = tree.get(g.path);
  if (!sha) return { ok: false, status: 404, error: 'path-not-in-tree', body: null, contentType: '' };
  const r = await ghApiGet(`/repos/${g.owner}/${g.repo}/git/blobs/${sha}`, { accept: 'application/vnd.github.raw', timeout: 30000 });
  return r;
}

/**
 * 智能抓取任意 URL（不做缓存，缓存由 asset 层负责）。
 * @returns {{ok:boolean, status:number, body:Buffer|null, contentType:string, via:string, error?:string}}
 */
function safeHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// 被墙/被安全网关「软拦截」的宿主（返回 200+HTML 拦截页），10 分钟内跳过直连
const poisoned = new Map(); // host -> 失效时间戳
function hostPoisoned(h) {
  const t = poisoned.get(h);
  if (t === undefined) return false;
  if (Date.now() > t) { poisoned.delete(h); return false; }
  return true;
}

/** 识别 200 + text/html 的拦截页（本服务代理的资产永远不会是 HTML） */
function isHtmlIntercept(r) {
  if (!r || !r.ok || !r.body) return false;
  if (!/text\/html/i.test(r.contentType)) return false;
  const head = r.body.toString('utf8', 0, 256);
  return /^\s*(<!doctype html|<html)/i.test(head);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function smartFetch(url, { timeout = 12000 } = {}) {
  const g = parseGithubUrl(url);
  const tried = [];
  // tryHop: 试一个加速地址；statKey 是 stats 计数键，via 保留完整来源（如 mirror:gh-proxy.org）供展示
  const tryHop = async (hopUrl, statKey, via, timeoutMs) => {
    const r = await httpGet(hopUrl, { timeout: timeoutMs });
    if (r.ok && !isHtmlIntercept(r)) { stats[statKey]++; return { ...r, via }; }
    return null;
  };

  // 1) 直连（已知不通或被软拦截的宿主跳过；瞬时网络错误歇 1 秒重试一次）
  const directHost = safeHost(url);
  const skipDirect = settings.skipDirectHosts.includes(directHost) || hostPoisoned(directHost);
  if (!skipDirect) {
    let r = await httpGet(url, { timeout });
    if (isHtmlIntercept(r)) {
      poisoned.set(directHost, Date.now() + 10 * 60e3);
      tried.push('direct:html-intercept');
    } else {
      if (!r.ok && r.status === 0) { await sleep(1000); r = await httpGet(url, { timeout }); }
      if (r.ok && !isHtmlIntercept(r)) { stats.direct++; return { ...r, via: 'direct' }; }
      tried.push(`direct:${r.status || r.error}`);
    }
  }

  if (g && g.owner && g.branch) {
    // 2) jsDelivr（.json/.js 等文本可用；.jar 403 后继续。本身就是 jsDelivr 链接则跳过）
    if (!g.jsdelivr) {
      const js = toJsdelivrUrl(url);
      if (js) {
        const r = await tryHop(js, 'jsdelivr', 'jsdelivr', timeout);
        if (r) return r;
        tried.push(`jsdelivr:fail`);
      }
    }
    // 3) gh 镜像（配置了坏地址的镜像跳过，不让一个异常打断整条链）
    const rawUrl = g.raw || `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${g.branch}/${g.pathEnc}`;
    for (const m of settings.mirrors) {
      const host = safeHost(m);
      if (!host) { tried.push('mirror:bad-url'); continue; }
      const r = await tryHop(m.replace(/\/$/, '') + '/' + rawUrl, 'mirror', `mirror:${host}`, timeout);
      if (r) return r;
      tried.push(`mirror:fail`);
    }
    // 4) GitHub API（可拿任意文件，含 .jar）
    if (apiBudgetLeft() > 0) {
      const r = await ghApiFile(g);
      if (r.ok && !isHtmlIntercept(r)) { stats.githubApi++; return { ...r, via: 'github-api' }; }
      tried.push(`api:${r.status || r.error}`);
    }
  }

  stats.fail++;
  return { ok: false, status: 0, contentType: '', via: 'none', error: tried.join(' | ') || 'no-route' };
}

// ---------- 磁盘资产缓存 ----------
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function assetPaths(url) {
  const h = sha1(url);
  return { bin: path.join(settings.cacheDir, h + '.bin'), meta: path.join(settings.cacheDir, h + '.meta.json') };
}

/** 读磁盘缓存（新鲜与否由调用方按 age 与 ttl 判断），无缓存或损坏返回 null */
function assetRead(url) {
  const { bin, meta } = assetPaths(url);
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const body = fs.readFileSync(bin);
    return { ...m, body, age: Date.now() - m.savedAt };
  } catch { return null; }
}

function assetWrite(url, { body, contentType, via, status }) {
  const { bin, meta } = assetPaths(url);
  try {
    fs.writeFileSync(bin, body);
    fs.writeFileSync(meta, JSON.stringify({ url, contentType, via, status, savedAt: Date.now() }, null, 2));
  } catch (e) { console.error('[cache] 写入失败', e.message); }
}

/**
 * 取资产：新鲜缓存 → 直接回；否则走智能链抓取并落盘。
 * 失败的地址记 10 分钟负缓存，避免同一死链反复全链重试。
 * @returns {{ok:boolean, body:Buffer, contentType:string, via:string, fromCache:boolean, age:number}}
 */
const negCache = new Map(); // url -> 失效时间戳
async function assetFetch(url, { ttlMs = 6 * 3600e3, nocache = false, timeout } = {}) {
  const neg = negCache.get(url);
  if (neg !== undefined) {
    if (Date.now() < neg) return { ok: false, error: 'negative-cache', via: 'none', body: null, contentType: '', fromCache: false, age: 0 };
    negCache.delete(url);
  }
  const c = assetRead(url);
  if (c && !nocache && c.age < ttlMs) {
    stats.cacheHit++;
    return { ok: true, body: c.body, contentType: c.contentType, via: c.via, fromCache: true, age: c.age };
  }
  const r = await smartFetch(url, { timeout });
  if (r.ok) {
    assetWrite(url, { body: r.body, contentType: r.contentType, via: r.via, status: r.status });
    return { ok: true, body: r.body, contentType: r.contentType, via: r.via, fromCache: false, age: 0 };
  }
  negCache.set(url, Date.now() + 10 * 60e3);
  // 抓取失败：有陈旧缓存就先凑合用
  if (c) return { ok: true, body: c.body, contentType: c.contentType, via: c.via + '(stale)', fromCache: true, age: c.age };
  return { ok: false, error: r.error, via: 'none', body: null, contentType: '', fromCache: false, age: 0 };
}

// ---------- 编解码 ----------
const b64enc = (s) => Buffer.from(s, 'utf8').toString('base64url');
const b64dec = (s) => Buffer.from(s, 'base64url').toString('utf8');

function getStats() {
  return {
    ...stats, apiBudgetLeft: apiBudgetLeft(), treeCacheSize: treeCache.size,
    poisonedHosts: [...poisoned.keys()],
  };
}

module.exports = { initProxy, smartFetch, assetFetch, b64enc, b64dec, getStats };
