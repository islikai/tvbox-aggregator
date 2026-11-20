'use strict';
/**
 * 上游语义层：把一个上游地址解析成若干「可用配置」。
 *  - 直接就是 TVBox 配置 JSON → 原样返回
 *  - 是「txt 跳转文件」（内容只有一行 URL）→ 跟随跳转（最多 2 层）
 *  - 是「多仓」{urls:[{name,url}]} / {storeHouse:[{sourceName,sourceUrl}]} → 展开成子上游（1 层）
 */
const { smartFetch } = require('./proxy.js');

const MAX_TXT_REDIRECT = 2;
const MAX_SUB_REPOS = 12;

/** 判断 JSON 是否是有效 TVBox 配置（至少有 sites/lives/parses 之一） */
function isTvboxConfig(j) {
  return j && typeof j === 'object' &&
    (Array.isArray(j.sites) || Array.isArray(j.lives) || Array.isArray(j.parses));
}

/** 判断是否是多仓壳 */
function multiRepoEntries(j) {
  if (!j || typeof j !== 'object') return null;
  let list = null;
  if (Array.isArray(j.urls) && !Array.isArray(j.sites)) list = j.urls;
  if (Array.isArray(j.storeHouse) && !Array.isArray(j.sites)) list = j.storeHouse;
  if (!list || !list.length) return null;
  const out = [];
  for (const e of list.slice(0, MAX_SUB_REPOS)) {
    const url = e && (e.url || e.sourceUrl);
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    out.push({ name: (e.name || e.sourceName || '子仓'), url });
  }
  return out.length ? out : null;
}

/**
 * 抓取并解析一个配置地址。
 * @returns {{config:object, via:string, redirected?:string}}
 * @throws Error（非 JSON / 无有效字段 / 抓取失败）
 */
async function fetchConfig(url, { timeout = 15000 } = {}) {
  let current = url, redirected = '';
  for (let hop = 0; hop <= MAX_TXT_REDIRECT; hop++) {
    const r = await smartFetch(current, { timeout });
    if (!r.ok) throw new Error(`抓取失败(${r.via}): ${r.error || r.status}`);
    const text = r.body.toString('utf8').trim();
    let j;
    try { j = JSON.parse(text); } catch {
      // txt 跳转：整个文件就是一行 URL
      if (/^https?:\/\/\S+$/i.test(text)) {
        redirected = current;
        current = text;
        continue;
      }
      throw new Error(`非 JSON 配置（${text.slice(0, 60)}...）`);
    }
    if (isTvboxConfig(j)) return { config: j, via: r.via, redirected };
    const multi = multiRepoEntries(j);
    if (multi) return { config: j, via: r.via, multi, redirected }; // 多仓壳，交给上层展开
    throw new Error('JSON 无 sites/lives/parses 字段');
  }
  throw new Error('txt 跳转层级过深');
}

/**
 * 展开一个上游（含多仓壳展开），返回 [{name, url, config, via}]。
 * 失败的子项不在返回里；全部失败时抛出携带原因的 Error（部分失败仅计入该 Error）。
 */
async function expandUpstream(item, { subTimeout = 15000 } = {}) {
  const r = await fetchConfig(item.url);
  if (!r.multi) return [{ name: item.name, url: item.url, config: r.config, via: r.via }];
  const subs = [];
  const errors = [];
  const queue = r.multi.slice(); // 并发 3
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const e = queue.shift();
      try {
        const sr = await fetchConfig(e.url, { timeout: subTimeout });
        if (isTvboxConfig(sr.config)) subs.push({ name: `${item.name}·${e.name}`, url: e.url, config: sr.config, via: sr.via });
        else errors.push(`${e.name}: 无有效字段`);
      } catch (err) { errors.push(`${e.name}: ${err.message}`); }
    }
  });
  await Promise.all(workers);
  if (!subs.length) throw new Error(`多仓展开全部失败: ${errors.slice(0, 3).join('; ')}`);
  return subs;
}

module.exports = { fetchConfig, expandUpstream };