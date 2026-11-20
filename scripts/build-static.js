#!/usr/bin/env node
'use strict';
/**
 * 静态构建：把 config.json 里的上游拉取并合并成 dist/config.json。
 *
 * 与本地模式（node server.js）共用 lib/ 和 config.json——一份配置、两种形态：
 *   本地模式：完整服务（/p/ 代理、管理页、实时刷新），电视填 http://<ip>:<port>/config
 *   云端模式：本脚本产出纯静态配置（无代理改写），由 GitHub Pages / jsDelivr 分发，
 *             电视填 https://cdn.jsdelivr.net/gh/<user>/<repo>@main/dist/config.json
 *
 * 供 GitHub Actions 定时执行，也可本地手动跑：
 *   node scripts/build-static.js [--out dist]
 *
 * 注意：静态产物不做 /p/ 代理改写（没有服务器可代理），ext/jar 等外链保持
 * 上游原样（已做相对路径绝对化），电视端直接拉取。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { mergeConfigs } = require('../lib/merge.js');
const { expandUpstream } = require('../lib/upstream.js');
const proxy = require('../lib/proxy.js');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outArg = outIdx >= 0 ? process.argv[outIdx + 1] : '';
  const outDir = path.resolve(ROOT, outArg || 'dist');
  // --repo <owner/name>：由 Actions 传入，产出电视端可用的分发地址
  const repoIdx = process.argv.indexOf('--repo');
  const repoArg = repoIdx >= 0 ? process.argv[repoIdx + 1] : '';
  const address = repoArg ? {
    jsdelivr: `https://cdn.jsdelivr.net/gh/${repoArg}@main/dist/config.json`,
    ghproxy: `https://gh-proxy.com/https://raw.githubusercontent.com/${repoArg}/main/dist/config.json`,
    raw: `https://raw.githubusercontent.com/${repoArg}/main/dist/config.json`,
  } : null;

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  proxy.initProxy({
    cacheDir: path.join(ROOT, 'cache', 'assets'),
    mirrors: cfg.mirrors,
    skipDirectHosts: cfg.skipDirectHosts,
  });

  const t0 = Date.now();
  const list = (cfg.upstreams || []).filter(u => u && u.url && u.enabled !== false);
  const items = [];
  const upstreamStatus = [];
  const queue = list.slice();
  await Promise.all(Array.from({ length: Math.min(4, Math.max(queue.length, 1)) }, async () => {
    while (queue.length) {
      const it = queue.shift();
      const s = Date.now();
      try {
        const subs = await expandUpstream(it);
        for (const sub of subs) items.push(sub);
        const ms = Date.now() - s; // 并发下不能回头读数组的最后一个元素（可能是别的 worker 推入的）
        upstreamStatus.push({
          name: it.name, url: it.url, ok: true, ms,
          count: {
            sites: subs.reduce((n, x) => n + (x.config.sites || []).length, 0),
            lives: subs.reduce((n, x) => n + (x.config.lives || []).length, 0),
          },
        });
        log(`✓ ${it.name} (${subs.length} 个配置, ${(ms / 1000).toFixed(1)}s)`);
      } catch (e) {
        upstreamStatus.push({ name: it.name, url: it.url, ok: false, error: e.message });
        log(`✗ ${it.name}: ${e.message}`);
      }
    }
  }));

  if (!items.length) {
    console.error('[build] 所有上游拉取失败，不产出（保留上一次 dist）');
    process.exit(1);
  }

  const { config, stats } = mergeConfigs(items, {
    dedupeByName: cfg.dedupeByName !== false,
    jarPolicy: cfg.jarPolicy || 'vote',
    siteJarInject: cfg.siteJarInject !== false,
    maxSites: cfg.maxSites || 0,
    maxLives: cfg.maxLives || 0,
    maxParses: cfg.maxParses || 0,
  });

  if (!config.sites || !config.sites.length) {
    console.error('[build] 合并结果为空，不产出');
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(outDir, 'status.json'), JSON.stringify({
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    ...(address ? { address } : {}),
    upstreams: upstreamStatus,
    merged: {
      sites: stats.sitesKept, lives: stats.livesKept, parses: stats.parsesKept,
      dupKey: stats.dupKey, dupName: stats.dupName,
      spiderSource: stats.spiderSource,
      perOrigin: stats.perOrigin,
    },
  }, null, 2));

  log(`构建完成：sites=${stats.sitesKept} lives=${stats.livesKept} parses=${stats.parsesKept} ` +
      `spider=${stats.spiderSource || '无'} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outDir}/config.json`);
  if (address) {
    log(`电视端地址: ${address.jsdelivr}`);
    log(`备用地址:   ${address.ghproxy}`);
  }
}

main().catch(e => { console.error('[build] 异常:', e); process.exit(1); });
