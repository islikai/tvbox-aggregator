'use strict';
/**
 * TVBox 聚合源本地服务（零依赖，Node >= 18）
 *
 *   GET  /            管理落地页（状态、电视端配置地址、刷新按钮）
 *   GET  /config      聚合后的 TVBox 配置（电视上填这个地址）?refresh=1 强制先刷新
 *   GET  /status      JSON 状态（上游健康、合并统计、代理统计）
 *   GET|POST /refresh 触发一次后台刷新
 *   GET  /p/<b64url>  资产代理（ext/jar/解析/直播地址），带磁盘缓存与多级抓取链
 *
 * 启动：node server.js   （或 PORT=8080 node server.js）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { mergeConfigs, isHttpUrl } = require('./lib/merge.js');
const { expandUpstream } = require('./lib/upstream.js');
const proxy = require('./lib/proxy.js');

const ROOT = __dirname;
const CFG_PATH = path.join(ROOT, 'config.json');
const SNAP_DIR = path.join(ROOT, 'cache', 'snapshots');
const VERSION = require('./package.json').version;

const log = (...a) => console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}]`, ...a);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ---------------- 配置热重载 ----------------
let cfgCache = null;
function getConfig() {
  try {
    const st = fs.statSync(CFG_PATH);
    if (!cfgCache || cfgCache.mtime !== st.mtimeMs) {
      const data = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      // env 覆盖
      if (process.env.PORT) data.port = Number(process.env.PORT);
      if (process.env.HOST) data.host = process.env.HOST;
      cfgCache = { mtime: st.mtimeMs, data };
      // 每次配置变化都重新应用代理设置（initProxy 类型安全且幂等，mirrors/skipDirectHosts 热改即生效）
      proxy.initProxy({
        cacheDir: path.join(ROOT, 'cache', 'assets'),
        mirrors: data.mirrors,
        skipDirectHosts: data.skipDirectHosts,
      });
    }
  } catch (e) {
    if (!cfgCache) { console.error(`[fatal] 读取 config.json 失败: ${e.message}`); process.exit(1); }
    log(`[warn] config.json 热重载失败，沿用旧配置: ${e.message}`);
  }
  return cfgCache.data;
}

// ---------------- 服务状态 ----------------
const state = {
  startedAt: Date.now(),
  upstreams: [],        // {name,url,enabled,ok,error,via,ms,fetchedAt,count,config}
  mergedCache: new Map(), // host -> {at, str, stats}
  refreshing: false,
  lastRefreshAt: 0,
  lastRefreshError: null,
  prewarmDone: false,
};

function enabledUpstreams(cfg) {
  return (cfg.upstreams || []).filter(u => u && u.url && u.enabled !== false);
}

// ---------------- 上游快照（磁盘持久化，重启秒开） ----------------
function snapshotPath(url) { return path.join(SNAP_DIR, sha1(url) + '.json'); }
function loadSnapshots() {
  // 只载入当前配置里仍启用的上游，已停用/已删除上游的陈旧快照不再进入合并
  const enabled = new Set(enabledUpstreams(getConfig()).map(u => u.url));
  try {
    for (const f of fs.readdirSync(SNAP_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'));
        if (j && j.url && j.config && enabled.has(j.url)) {
          state.upstreams.push({
            name: j.name, url: j.url, enabled: true, ok: 'cached',
            via: j.via, fetchedAt: j.fetchedAt, ms: j.ms,
            count: countOf(j.config), config: j.config,
          });
        }
      } catch { /* 脏快照忽略 */ }
    }
  } catch { /* 目录不存在 */ }
  const n = state.upstreams.length;
  if (n) log(`[boot] 载入 ${n} 份上游快照（陈旧数据，后台刷新中）`);
}

function countOf(c) {
  return { sites: (c.sites || []).length, lives: (c.lives || []).length, parses: (c.parses || []).length };
}
function saveSnapshot(u) {
  try {
    fs.writeFileSync(snapshotPath(u.url), JSON.stringify({
      name: u.name, url: u.url, via: u.via, fetchedAt: u.fetchedAt, ms: u.ms, config: u.config,
    }));
  } catch (e) { log(`[warn] 快照保存失败 ${u.name}: ${e.message}`); }
}

// ---------------- 刷新 ----------------
async function refresh() {
  if (state.refreshing) return { skipped: true };
  state.refreshing = true;
  const cfg = getConfig();
  const t0 = Date.now();
  try {
    const list = enabledUpstreams(cfg);
    const queue = list.slice();
    const results = new Map(); // url -> {entry, error}
    await Promise.all(Array.from({ length: Math.min(4, Math.max(queue.length, 1)) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        const s = Date.now();
        try {
          const subs = await expandUpstream(item);
          const ms = Date.now() - s;
          // 同一上游展开多个子仓时，合并成一个大配置（等价于再跑一次 merge）
          let config;
          if (subs.length === 1) config = subs[0].config;
          else {
            const m = mergeConfigs(subs.map(x => ({ name: x.name, url: x.url, config: x.config })), { jarPolicy: 'first', siteJarInject: false, dedupeByName: true });
            config = m.config;
          }
          const entry = {
            name: item.name, url: item.url, enabled: true, ok: true,
            via: subs[0].via, fetchedAt: Date.now(), ms, count: countOf(config), config,
          };
          results.set(item.url, { entry });
        } catch (e) {
          results.set(item.url, { error: e.message, name: item.name, url: item.url });
        }
      }
    }));
    // 应用结果：失败的上游保留旧配置（有则继续参与合并）
    const old = new Map(state.upstreams.map(u => [u.url, u]));
    const next = [];
    for (const item of list) {
      const r = results.get(item.url);
      if (r && r.entry) { next.push(r.entry); saveSnapshot(r.entry); }
      else {
        const prev = old.get(item.url);
        const err = r ? r.error : '未执行';
        log(`[refresh] ✗ ${item.name}: ${err}`);
        if (prev && prev.config) next.push({ ...prev, ok: false, error: err });
        else next.push({ name: item.name, url: item.url, enabled: true, ok: false, error: err });
      }
    }
    state.upstreams = next;
    state.mergedCache.clear();
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    state.prewarmDone = false;
    const okN = next.filter(u => u.ok === true).length;
    log(`[refresh] 完成 ${okN}/${next.length} 个上游，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    buildAndPrewarm().catch(() => {});
    return { ok: okN, total: next.length };
  } catch (e) {
    state.lastRefreshError = e.message;
    log(`[refresh] 异常: ${e.message}`);
    return { error: e.message };
  } finally {
    state.refreshing = false;
  }
}

/** 用局域网地址预热合并结果与关键 jar（后台执行，不阻塞） */
async function buildAndPrewarm() {
  const lan = lanIps()[0] || '127.0.0.1';
  const cfg = getConfig();
  const host = `${lan}:${cfg.port}`;
  try { getMerged(host); } catch (e) { log(`[prewarm] 合并失败: ${e.message}`); }

  if (!cfg.prewarmJars || state.prewarmDone) return;
  state.prewarmDone = true;
  const merged = getMergedRaw();
  if (!merged) return;
  const jars = new Set();
  if (merged.config.spider) jars.add(merged.config.spider.split(';')[0]);
  for (const s of merged.config.sites || []) if (typeof s.jar === 'string' && s.jar) jars.add(s.jar.split(';')[0]);
  const list = [...jars].filter(isHttpUrl).slice(0, 10);
  for (const j of list) {
    try {
      const r = await proxy.assetFetch(j, { ttlMs: (cfg.assetTtlHours || 6) * 3600e3, timeout: 30000 });
      log(`[prewarm] ${r.ok ? '✓' : '✗'} jar ${j.slice(0, 70)} (${r.via}, ${r.body ? r.body.length : 0}B)`);
    } catch (e) { log(`[prewarm] ✗ jar ${j.slice(0, 70)}: ${e.message}`); }
  }
}
// ---------------- 合并与改写 ----------------
function getMergedRaw() {
  const cfg = getConfig();
  const items = state.upstreams.filter(u => u.config).map(u => ({ name: u.name, url: u.url, config: u.config }));
  if (!items.length) return null;
  const { config, stats } = mergeConfigs(items, {
    dedupeByName: cfg.dedupeByName !== false,
    jarPolicy: cfg.jarPolicy || 'vote',
    siteJarInject: cfg.siteJarInject !== false,
    maxSites: cfg.maxSites || 0,
    maxLives: cfg.maxLives || 0,
    maxParses: cfg.maxParses || 0,
  });
  return { config, stats, at: Date.now() };
}

function getMerged(host) {
  let c = state.mergedCache.get(host);
  if (c) return c;
  const raw = getMergedRaw();
  if (!raw) throw new Error('上游尚未就绪');
  const cfg = getConfig();
  const config = rewriteProxy(raw.config, `http://${host}`, cfg);
  c = { at: raw.at, str: JSON.stringify(config), stats: raw.stats };
  state.mergedCache.set(host, c);
  return c;
}

/** 把配置里 TVBox 要拉取的外链改成走本地 /p/ 代理（相对 127.0.0.1 的本地占位地址不动） */
function rewriteProxy(cfgObj, proxyBase, cfg) {
  if (!cfg.proxy) return cfgObj;
  const wrap = (u) => {
    if (!isHttpUrl(u)) return u;
    try {
      const h = new URL(u).host;
      // TVBox 本机占位地址（含端口）不代理，电视端自己访问
      if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h)) return u;
    } catch { return u; }
    return `${proxyBase}/p/${proxy.b64enc(u)}`;
  };
  const c = JSON.parse(JSON.stringify(cfgObj));
  // 「url;md5;hash」后缀约定：只代理 URL 段，后缀原样保留
  const wrapSemi = (v) => {
    const p = v.split(';');
    p[0] = wrap(p[0]);
    return p.join(';');
  };
  // ext 的「url|md5」后缀约定同理
  const wrapBar = (v) => {
    const p = v.split('|');
    p[0] = wrap(p[0]);
    return p.join('|');
  };
  if (typeof c.spider === 'string' && c.spider) c.spider = wrapSemi(c.spider);
  for (const s of c.sites || []) {
    if (typeof s.ext === 'string' && s.ext) s.ext = wrapBar(s.ext);
    if (typeof s.jar === 'string' && s.jar) s.jar = wrapSemi(s.jar);
  }
  for (const p of c.parses || []) {
    if (typeof p.url === 'string') p.url = wrap(p.url);
    if (typeof p.ext === 'string') p.ext = wrap(p.ext);
    else if (p.ext && typeof p.ext === 'object' && typeof p.ext.url === 'string') p.ext.url = wrap(p.ext.url);
  }
  if (cfg.proxyLives !== false) {
    for (const lv of c.lives || []) if (typeof lv.url === 'string') lv.url = wrap(lv.url);
  }
  return c;
}

// ---------------- 路由 ----------------
function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}
async function handleAsset(req, res, b64raw, search) {
  // 容错：客户端可能把「;md5;...」「|md5」后缀一起拼进路径，取有效 base64url 段
  const b64 = String(b64raw).split(/[;|]/)[0];
  let target;
  try { target = proxy.b64dec(b64); } catch { return sendJson(res, 400, { error: 'bad b64' }); }
  if (!isHttpUrl(target)) return sendJson(res, 400, { error: 'not http url' });
  // 查询参数透传（解析接口会带 ?url=... 之类）
  if (search) {
    const q = search.startsWith('?') ? search.slice(1) : search;
    if (q) target += (target.includes('?') ? '&' : '?') + q;
  }
  const cfg = getConfig();
  const r = await proxy.assetFetch(target, { ttlMs: (cfg.assetTtlHours || 6) * 3600e3 });
  if (r.ok) {
    res.writeHead(200, {
      'Content-Type': r.contentType || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'X-Proxy-Via': r.via,
      'X-Proxy-Cache': r.fromCache ? (r.age > 3600e3 ? 'stale' : 'hit') : 'miss',
      'Cache-Control': 'public, max-age=600',
    });
    return res.end(req.method === 'HEAD' ? undefined : r.body);
  }
  log(`[asset] ✗ ${target.slice(0, 90)} (${r.error}) → 302 回退`);
  res.writeHead(302, { Location: encodeURI(target), 'X-Proxy-Fallback': 'direct' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  getConfig(); // 每请求热重载配置
  try {
    if (p === '/' || p === '/index.html') return landingPage(req, res);
    if (p === '/config') {
      if (u.searchParams.get('refresh') === '1') await refresh();
      if (!state.upstreams.some(x => x.config)) {
        return sendJson(res, 503, { error: '上游尚未加载完成，稍后重试' }, { 'Retry-After': '10' });
      }
      const merged = getMerged(req.headers.host || `127.0.0.1:${getConfig().port}`);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      return res.end(merged.str);
    }
    if (p === '/status') return statusJson(req, res);
    if (p === '/refresh') {
      if (req.method === 'POST' || req.method === 'GET') {
        refresh().catch(() => {});
        return sendJson(res, 202, { started: true, note: '后台刷新已触发，稍后查看 /status' });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (p.startsWith('/p/')) return handleAsset(req, res, p.slice(3), u.search);
    if (p === '/icon.png') {
      try {
        const buf = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        return res.end(buf);
      } catch { res.writeHead(204); return res.end(); }
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    return sendJson(res, 404, { error: 'not found', routes: ['/', '/config', '/status', '/refresh', '/p/<b64url>'] });
  } catch (e) {
    log(`[error] ${p}: ${e.message}`);
    return sendJson(res, 500, { error: e.message });
  }
});

// ---------------- 状态与落地页 ----------------
function statusData() {
  const cfg = getConfig();
  const merged = (() => { try { return getMergedRaw(); } catch { return null; } })();
  return {
    version: VERSION,
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    refreshing: state.refreshing,
    lastRefreshAt: state.lastRefreshAt ? new Date(state.lastRefreshAt).toISOString() : null,
    nextRefreshAt: state.lastRefreshAt
      ? new Date(state.lastRefreshAt + Math.max(60, cfg.refreshMinutes || 60) * 60e3).toISOString()
      : null,
    lastRefreshError: state.lastRefreshError,
    merged: merged ? {
      at: new Date(merged.at).toISOString(),
      sites: merged.stats.sitesKept, lives: merged.stats.livesKept, parses: merged.stats.parsesKept,
      dupKey: merged.stats.dupKey, dupName: merged.stats.dupName,
      spiderSource: merged.stats.spiderSource,
      jarConflicts: merged.stats.jarConflicts,
      perOrigin: merged.stats.perOrigin,
    } : null,
    upstreams: state.upstreams.map(x => ({
      name: x.name, url: x.url, ok: x.ok, error: x.error || null, via: x.via || null,
      ms: x.ms || null, fetchedAt: x.fetchedAt ? new Date(x.fetchedAt).toISOString() : null,
      count: x.count || null,
    })),
    proxy: proxy.getStats(),
    configUrl: lanIps().map(ip => `http://${ip}:${cfg.port}/config`),
    settings: {
      port: cfg.port, refreshMinutes: cfg.refreshMinutes, proxy: cfg.proxy !== false,
      jarPolicy: cfg.jarPolicy || 'vote', siteJarInject: cfg.siteJarInject !== false,
    },
  };
}
function statusJson(req, res) { sendJson(res, 200, statusData()); }
// ---------------- 落地页（壳 + 客户端渲染，数据来自 /status 轮询，页面自动更新） ----------------
function landingPage(req, res) {
  const cfg = getConfig();
  const urls = lanIps().map(ip => `http://${ip}:${cfg.port}/config`);
  if (!urls.length) urls.push(`http://127.0.0.1:${cfg.port}/config`);
  const boot = { version: VERSION, port: cfg.port, urls };
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/icon.png">
<title>TVBox 聚合源服务</title>
<style>
  :root{color-scheme:dark;
    --bg:#0f1117;--panel:#161a23;--panel2:#1b2029;--line:#262c3a;--line2:#323a4d;
    --txt:#e2e7f0;--dim:#8b93a5;--faint:#5f6678;--blue:#6ea8ff;--green:#58d68d;--amber:#e6b455;--red:#ff7a76;--mono-url:#7ee1a1}
  *{box-sizing:border-box}
  body{font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--txt);margin:0;padding:28px 16px 40px;
    background:radial-gradient(1100px 500px at 70% -10%,#1a2030 0%,var(--bg) 55%) fixed}
  .wrap{max-width:920px;margin:0 auto}
  a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
  .hdr{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .hdr h1{display:flex;align-items:center;gap:9px;font-size:21px;margin:0;letter-spacing:.5px}
  .hdr h1 img{display:block;flex:none;width:30px;height:30px;border-radius:7px;box-shadow:0 1px 6px rgba(0,0,0,.4)}
  .chip{font-size:12px;color:var(--dim);border:1px solid var(--line2);border-radius:99px;padding:2px 10px}
  .hdr .sp{flex:1}
  .live{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--dim)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(88,214,141,.5);animation:pulse 2s infinite}
  .dot.busy{background:var(--amber)}
  .dot.down{background:var(--red);animation:none}
  @keyframes pulse{70%{box-shadow:0 0 0 7px rgba(88,214,141,0)}100%{box-shadow:0 0 0 0 rgba(88,214,141,0)}}
  .card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px;transition:border-color .2s}
  .card:hover{border-color:var(--line2)}
  .label{font-size:12.5px;color:var(--dim);letter-spacing:1px;margin-bottom:10px}
  .hero{border-color:#2c4a6e}
  .hero-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .hero-title{font-size:16.5px;font-weight:600;letter-spacing:2px}
  .hero-badge{font-size:11px;color:var(--blue);border:1px solid rgba(110,168,255,.35);background:rgba(110,168,255,.08);border-radius:99px;padding:1px 9px}
  .hero-sub{font-size:12.5px;color:var(--dim);margin:6px 0 12px}
  .hero .main{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .cfg{flex:1;min-width:200px;height:32px;display:flex;align-items:center;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:var(--mono-url);
    background:#0b0e14;border:1px solid var(--line);border-radius:8px;padding:0 12px;word-break:break-all;cursor:pointer;transition:border-color .2s,background .2s}
  .cfg:hover{border-color:#3a8f63;background:#0d1219}
  .altbox{margin-top:12px}
  .altbox summary{cursor:pointer;font-size:12.5px;color:var(--dim);user-select:none}
  .altbox summary:hover{color:var(--txt)}
  .altbox summary b{color:var(--blue)}
  .alts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .apill{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#9fd8b4;background:#0b0e14;border:1px dashed var(--line2);border-radius:8px;padding:5px 10px;cursor:pointer;word-break:break-all}
  .apill:hover{border-color:#3a8f63;color:var(--mono-url)}
  .hint-same{font-size:12px;color:var(--faint);margin-top:10px}
  .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .metric{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:14px 16px;text-align:center}
  .metric b{display:block;font-size:26px;color:var(--blue);font-variant-numeric:tabular-nums}
  .metric b.g{color:var(--green)}.metric b.a{color:var(--amber)}
  .metric span{color:var(--dim);font-size:12.5px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .row b{font-size:15.5px}
  button{border:0;cursor:pointer;font-family:inherit;letter-spacing:1px;transition:filter .15s,transform .12s,border-color .2s,color .2s}
  button:active{transform:translateY(1px)}
  button:disabled{opacity:.5;cursor:wait}
  .btn-primary{display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#3f7ae0,#2d6cdf);color:#fff;border-radius:8px;height:32px;padding:0 16px;font-size:13px;letter-spacing:1px;box-shadow:0 1px 6px rgba(45,108,223,.3)}
  .btn-primary:hover{filter:brightness(1.1);transform:translateY(-1px)}
  .tblwrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{color:var(--dim);font-weight:500;text-align:left;padding:6px 10px;border-bottom:1px solid var(--line2);white-space:nowrap}
  td{padding:10px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  .name{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pill{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;border-radius:99px;padding:2px 10px;white-space:nowrap}
  .pill.ok{color:var(--green);background:rgba(88,214,141,.1)}
  .pill.warn{color:var(--amber);background:rgba(230,180,85,.1)}
  .pill.bad{color:var(--red);background:rgba(255,122,118,.1)}
  .pill i{width:7px;height:7px;border-radius:50%;background:currentColor;font-style:normal}
  .err{color:var(--red);font-size:11.5px;margin-top:4px;max-width:280px;word-break:break-all}
  .num{white-space:nowrap;color:var(--dim);font-variant-numeric:tabular-nums}
  .bar{height:5px;border-radius:99px;background:#0c0f15;margin-top:6px;max-width:130px;overflow:hidden}
  .bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2d6cdf,#58d68d)}
  .foot{color:var(--dim);font-size:13px;margin-top:14px;line-height:1.9}
  .chips{display:flex;gap:8px;flex-wrap:wrap}
  .cchip{font-size:12px;color:var(--dim);border:1px solid var(--line);background:#12151d;border-radius:8px;padding:3px 10px}
  .cchip b{color:var(--txt);font-weight:600;font-variant-numeric:tabular-nums}
  .faint{color:var(--faint)}
  @media(max-width:680px){
    td:nth-child(4),th:nth-child(4),td:nth-child(5),th:nth-child(5){display:none}
    .cfg{font-size:12.5px;min-width:100%;height:auto;padding:10px 12px}
    .btn-primary{width:100%;height:40px}
    .hdr h1{font-size:18px}
  }
</style></head><body><div class="wrap">

<div class="hdr">
  <h1><img src="/icon.png" width="30" height="30" alt="TVBox"/>TVBox 聚合源服务</h1>
  <span class="chip">v<span id="ver"></span></span>
  <span class="sp"></span>
  <div class="live"><span class="dot" id="dot"></span><span id="live">连接中…</span></div>
</div>

<div class="card hero">
  <div class="hero-head">
    <span class="hero-title">电视端配置地址</span>
    <span class="hero-badge">局域网 · HTTP</span>
  </div>
  <div class="hero-sub">TVBox / 影视 / OK影视 → 设置 →「配置地址」粘贴即用；点地址或按钮复制</div>
  <div class="main">
    <span class="cfg" id="cfg-main" data-copy="" title="点击复制"></span>
    <button id="btn-main" class="btn-primary" data-copy="">复制</button>
  </div>
  <details class="altbox" id="altbox">
    <summary>备用入口（其他网卡 <b id="alt-n">0</b> 个，点击展开）</summary>
    <div class="alts" id="alt-urls"></div>
  </details>
  <div class="faint hint-same">电视与本机需在同一局域网；手机/模拟器同理</div>
</div>

<div class="metrics">
  <div class="metric"><b id="m-sites">–</b><span>聚合站点</span></div>
  <div class="metric"><b class="g" id="m-lives">–</b><span>直播分组</span></div>
  <div class="metric"><b id="m-parses">–</b><span>解析接口</span></div>
  <div class="metric"><b class="a" id="m-ups">–</b><span>上游在线</span></div>
</div>

<div class="card">
  <div class="row">
    <b>上游健康</b>
    <button id="btn-refresh" class="btn-primary" onclick="doRefresh()">立即刷新</button>
  </div>
  <div class="tblwrap">
  <table>
    <thead><tr><th>名称</th><th>状态</th><th>规模</th><th>来源 / 耗时</th><th>更新</th></tr></thead>
    <tbody id="rows"><tr><td colspan="5" class="faint">加载中…</td></tr></tbody>
  </table>
  </div>
  <div class="foot" id="foot-meta"></div>
</div>
<div class="card">
  <div class="label">代理通道 / 缓存（本机拉取上游与资产的实际路径）</div>
  <div class="chips" id="proxy-chips"><span class="cchip">…</span></div>
</div>

<div class="card foot">
  接口：<a href="/config">/config</a > · <a href="/status">/status</a > · <a href="/refresh">/refresh</a > · /p/&lt;url&gt; 资产代理<br>
  编辑 <b>config.json</b> 增删上游（保存即生效）；GitHub 云端部署见 DEPLOY.md · GITHUB-TUTORIAL.md
</div>

<script>
var BOOT = ${JSON.stringify(boot)};
var NEXT_AT = 0, LAST_AT = 0, BUSY = false, FOOT_BASE = '';

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function el(id){return document.getElementById(id);}
function fmtAgo(iso){
  if(!iso) return '-';
  var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return '即将';
  if (s < 90) return s + ' 秒前';
  if (s < 5400) return Math.round(s / 60) + ' 分钟前';
  return Math.round(s / 3600) + ' 小时前';
}
function fmtDur(sec){
  if (sec < 90) return sec + ' 秒';
  if (sec < 5400) return Math.round(sec / 60) + ' 分钟';
  return Math.round(sec / 3600) + ' 小时 ' + Math.round((sec % 3600) / 60) + ' 分';
}
function pillFor(ok){
  if (ok === true) return '<span class="pill ok"><i></i>在线</span>';
  if (ok === 'cached') return '<span class="pill warn"><i></i>快照</span>';
  return '<span class="pill bad"><i></i>失败</span>';
}
function countdown(){
  var s = Math.round((NEXT_AT - Date.now()) / 1000);
  if (s <= 0) return '马上';
  if (s < 90) return s + ' 秒后';
  return Math.round(s / 60) + ' 分钟后';
}

function render(s){
  var m = s.merged;
  el('ver').textContent = s.version;
  var dot = el('dot'), live = el('live');
  var upsOk = 0;
  for (var i = 0; i < s.upstreams.length; i++) if (s.upstreams[i].ok === true) upsOk++;
  if (s.refreshing) { dot.className = 'dot busy'; live.textContent = '正在刷新上游…'; }
  else if (!s.upstreams.length) { dot.className = 'dot down'; live.textContent = '等待首次刷新'; }
  else { dot.className = 'dot'; live.textContent = '运行中 · ' + fmtDur(s.uptimeSec) + ' · ' + upsOk + '/' + s.upstreams.length + ' 上游在线'; }
  BUSY = !!s.refreshing;
  var rb = el('btn-refresh'); rb.disabled = BUSY; rb.textContent = BUSY ? '刷新中…' : '立即刷新';

  var urls = s.configUrl && s.configUrl.length ? s.configUrl : BOOT.urls;
  el('cfg-main').setAttribute('data-copy', urls[0]);
  el('cfg-main').textContent = urls[0];
  el('btn-main').setAttribute('data-copy', urls[0]);
  el('btn-main').textContent = '复制';
  var altN = urls.length - 1;
  var box = el('altbox');
  if (altN > 0) {
    box.style.display = '';
    el('alt-n').textContent = altN;
    var alt = '';
    for (var j = 1; j < urls.length; j++) {
      alt += '<span class="apill" data-copy="' + esc(urls[j]) + '" title="点击复制">' + esc(urls[j]) + '</span>';
    }
    el('alt-urls').innerHTML = alt;
  } else {
    box.style.display = 'none';
  }

  el('m-sites').textContent = m ? m.sites : '–';
  el('m-lives').textContent = m ? m.lives : '–';
  el('m-parses').textContent = m ? m.parses : '–';
  el('m-ups').textContent = upsOk + '/' + s.upstreams.length;

  var maxSites = 1;
  for (var k = 0; k < s.upstreams.length; k++) {
    var c = s.upstreams[k].count;
    if (c && c.sites > maxSites) maxSites = c.sites;
  }
  var rows = '';
  for (var r = 0; r < s.upstreams.length; r++) {
    var u = s.upstreams[r];
    var cnt = u.count ? (u.count.sites + ' 站 / ' + u.count.lives + ' 直播') : '–';
    var bar = u.count && u.count.sites ? '<div class="bar"><i style="width:' + Math.max(4, Math.round(u.count.sites / maxSites * 100)) + '%"></i></div>' : '';
    var via = esc(u.via || '–') + (u.ms ? ' · ' + (u.ms / 1000).toFixed(1) + 's' : '');
    rows += '<tr>' +
      '<td class="name" title="' + esc(u.url) + '">' + esc(u.name) + '</td>' +
      '<td>' + pillFor(u.ok) + (u.error ? '<div class="err">' + esc(String(u.error).slice(0, 90)) + '</div>' : '') + '</td>' +
      '<td class="num">' + cnt + bar + '</td>' +
      '<td class="num">' + via + '</td>' +
      '<td class="num">' + fmtAgo(u.fetchedAt) + '</td>' +
      '</tr>';
  }
  el('rows').innerHTML = rows || '<tr><td colspan="5" class="faint">尚未加载（等待首次刷新）</td></tr>';

  var foot = '上次刷新：' + (s.lastRefreshAt ? fmtAgo(s.lastRefreshAt) : '尚未刷新');
  foot += ' · 下次自动刷新：【CD】';
  if (m) {
    foot += '<br>全局 spider 来自 <b>' + esc(m.spiderSource || '无') + '</b>';
    if (m.jarConflicts && m.jarConflicts.length) {
      foot += ' · <span style="color:var(--amber)">另有 ' + m.jarConflicts.length + ' 个上游 jar 不同，已按站点注入（FongMi 系生效）</span>';
    }
    foot += ' · 去重：键 ' + m.dupKey + ' + 名 ' + m.dupName;
  }
  FOOT_BASE = foot;
  el('foot-meta').innerHTML = foot.replace('【CD】', countdown());

  var p = s.proxy || {};
  var chips = [['直连', p.direct], ['jsDelivr', p.jsdelivr], ['镜像', p.mirror],
    ['GitHub API', p.githubApi], ['失败', p.fail], ['缓存命中', p.cacheHit]];
  var ch = '';
  for (var c2 = 0; c2 < chips.length; c2++) {
    ch += '<span class="cchip">' + chips[c2][0] + ' <b>' + (chips[c2][1] == null ? 0 : chips[c2][1]) + '</b></span>';
  }
  ch += '<span class="cchip">API 预算 <b>' + (p.apiBudgetLeft == null ? '–' : p.apiBudgetLeft) + '/40</b></span>';
  if (p.poisonedHosts && p.poisonedHosts.length) {
    ch += '<span class="cchip" style="color:var(--red)">被拦宿主 <b>' + esc(p.poisonedHosts.join(', ')) + '</b></span>';
  }
  el('proxy-chips').innerHTML = ch;

  LAST_AT = s.lastRefreshAt ? Date.parse(s.lastRefreshAt) : 0;
  NEXT_AT = s.nextRefreshAt ? Date.parse(s.nextRefreshAt) : 0;
}

async function poll(){
  try {
    var s = await (await fetch('/status')).json();
    render(s);
  } catch (e) {
    el('dot').className = 'dot down';
    el('live').textContent = '服务不可达';
  }
  setTimeout(poll, BUSY ? 1500 : 8000);
}

async function doRefresh(){
  var b = el('btn-refresh');
  b.disabled = true; b.textContent = '刷新中…';
  var before = LAST_AT;
  try { await fetch('/refresh', { method: 'POST' }); } catch (e) {}
  var t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await new Promise(function(r){ setTimeout(r, 1500); });
  try {
      var s = await (await fetch('/status')).json();
      render(s);
      if (s.lastRefreshAt && Date.parse(s.lastRefreshAt) > before) break;
    } catch (e) {}
  }
  b.disabled = false; b.textContent = '立即刷新';
}

// 复制：事件委托，任何带 data-copy 的元素点击即复制
document.addEventListener('click', function(ev){
  var n = ev.target.closest ? ev.target.closest('[data-copy]') : null;
  if (!n) return;
  var t = n.getAttribute('data-copy');
  if (!t) return;
  function ok(){
    var restore = n.tagName === 'BUTTON' ? '复制' : null;
    n.textContent = '已复制';
    setTimeout(function(){
      if (restore) n.textContent = restore; else n.textContent = t;
    }, 1300);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, ok);
  else ok();
});

poll();
setInterval(function(){
  if (FOOT_BASE && NEXT_AT && !BUSY) el('foot-meta').innerHTML = FOOT_BASE.replace('【CD】', countdown());
}, 1000);
</script>
</div></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
// ---------------- 启动 ----------------
function main() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const cfg = getConfig();
  loadSnapshots();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`端口 ${cfg.port} 已被占用（多半是另一个本服务实例还在跑）：`);
      try {
        const out = require('child_process')
          .execSync(`lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN -t`, { encoding: 'utf8' })
          .trim().split('\n').filter(Boolean);
        for (const pid of new Set(out)) {
          let cmd = '';
          try { cmd = require('child_process').execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).trim(); } catch {}
          log(`  PID ${pid}  ${cmd}`);
        }
      } catch { /* lsof 不可用就跳过 */ }
      log(`  结束它: kill <上面的PID>（或换端口启动: PORT=8080 node server.js）`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(cfg.port, cfg.host, () => {
    const ips = lanIps();
    log(`TVBox 聚合源服务 v${VERSION} 已启动`);
    log(`  本机:   http://127.0.0.1:${cfg.port}/`);
    ips.forEach(ip => log(`  局域网: http://${ip}:${cfg.port}/  ← 电视上填这个`));
    if (!ips.length) log(`  (未检测到局域网 IPv4 地址)`);
    log(`  配置:  http://127.0.0.1:${cfg.port}/config`);
  });
  refresh().catch(e => log(`[boot] 初始刷新失败: ${e.message}`));
  const loop = () => setTimeout(async () => {
    try { await refresh(); } catch (e) { log(`[timer] ${e.message}`); }
    loop();
  }, Math.max(60, (getConfig().refreshMinutes || 60)) * 60e3);
  loop();
}

if (require.main === module) main();
module.exports = { server, refresh, getMerged, state, main };