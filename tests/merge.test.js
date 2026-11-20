'use strict';
/** lib/merge.js 单元测试：node --test tests/ */
const test = require('node:test');
const assert = require('node:assert');
const {
  resolveUrl, parseGithubUrl, toJsdelivrUrl, resolveSpider, mergeConfigs, stableStringify,
} = require('../lib/merge.js');

const BASE = 'https://example.com/config.json';

test('resolveUrl：绝对地址原样返回', () => {
  assert.equal(resolveUrl(BASE, 'http://a.com/x.json'), 'http://a.com/x.json');
  assert.equal(resolveUrl(BASE, 'https://a.com/x.json'), 'https://a.com/x.json');
});

test('resolveUrl：相对地址基于上游 URL 解析', () => {
  assert.equal(resolveUrl(BASE, './deps/lib.jar'), 'https://example.com/deps/lib.jar');
  assert.equal(resolveUrl('https://example.com/dir/c.json', 'ext/a.json'), 'https://example.com/dir/ext/a.json');
  assert.equal(resolveUrl(BASE, '/root.json'), 'https://example.com/root.json');
  assert.equal(resolveUrl(BASE, '//cdn.com/a'), 'http://cdn.com/a');
});

test('parseGithubUrl：raw 直链', () => {
  const g = parseGithubUrl('https://raw.githubusercontent.com/qist/tvbox/master/jar/spider.jar');
  assert.deepEqual(
    { owner: g.owner, repo: g.repo, branch: g.branch, path: g.path },
    { owner: 'qist', repo: 'tvbox', branch: 'master', path: 'jar/spider.jar' }
  );
});

test('parseGithubUrl：gh-proxy 加速链剥壳', () => {
  const g = parseGithubUrl('https://gh-proxy.com/https://raw.githubusercontent.com/a/b/main/c/d.json?x=1');
  assert.equal(g.owner, 'a');
  assert.equal(g.branch, 'main');
  assert.equal(g.path, 'c/d.json');
});

test('parseGithubUrl：github.com blob/raw 形式', () => {
  const g = parseGithubUrl('https://github.com/a/b/raw/main/c.json');
  assert.equal(g.owner, 'a');
  assert.equal(g.branch, 'main');
  assert.equal(g.raw, 'https://raw.githubusercontent.com/a/b/main/c.json');
});

test('parseGithubUrl：非 GitHub 链接返回 null', () => {
  assert.equal(parseGithubUrl('https://example.com/a.json'), null);
  assert.equal(parseGithubUrl('not a url'), null);
});

test('parseGithubUrl：jsDelivr 链接（含 repo 段与 @branch）', () => {
  const g = parseGithubUrl('https://cdn.jsdelivr.net/gh/hubeizgd1979/tvbox-config@main/dist/config.json');
  assert.deepEqual(
    { owner: g.owner, repo: g.repo, branch: g.branch, path: g.path, jsdelivr: g.jsdelivr },
    { owner: 'hubeizgd1979', repo: 'tvbox-config', branch: 'main', path: 'dist/config.json', jsdelivr: true }
  );
  assert.equal(g.raw, 'https://raw.githubusercontent.com/hubeizgd1979/tvbox-config/main/dist/config.json');
});

test('toJsdelivrUrl：转 jsDelivr（.jar 在 jsDelivr 上不可用属预期，链路里会走 API）', () => {
  assert.equal(
    toJsdelivrUrl('https://gh-proxy.com/https://raw.githubusercontent.com/a/b/main/c/d.json'),
    'https://cdn.jsdelivr.net/gh/a/b@main/c/d.json'
  );
  assert.equal(toJsdelivrUrl('https://example.com/a.json'), null);
});

test('resolveSpider：保留 ;md5; 后缀，只解析 URL 段', () => {
  assert.equal(
    resolveSpider('./jar/x.jar;md5;abc123', 'https://e.com/c.json'),
    'https://e.com/jar/x.jar;md5;abc123'
  );
  assert.equal(resolveSpider('http://x/jar;md5;h', BASE), 'http://x/jar;md5;h');
});

const items = () => ([
  {
    name: 'A', url: 'https://a.com/config.json',
    config: {
      spider: 'https://a.com/big.jar;md5;aaa',
      sites: [
        { key: 's1', name: '站一', type: 3, api: 'csp_One', ext: './ext1.json' },
        { key: 's2', name: '站二', type: 3, api: 'csp_Two' },
        { key: 's3', name: '采集', type: 1, api: 'https://cms.a/api.php/provide/vod/' },
      ],
      lives: [{ name: '直播', type: 0, url: 'https://a.com/live.txt' }],
      parses: [{ name: '解析1', type: 0, url: 'https://a.com/p1' }],
      flags: ['qq', 'youku'],
      rules: [{ host: 'a.com', rule: ['x'] }],
      wallpaper: 'https://a.com/wp.jpg',
    },
  },
  {
    name: 'B', url: 'https://b.com/config.json',
    config: {
      spider: 'https://b.com/other.jar',
      sites: [
        { key: 's1', name: '站一改名也没用同key', type: 3, api: 'csp_One' },   // 同 key 去重
        { key: 's2x', name: '站二', type: 3, api: 'csp_TwoB' },                // key 不同但同名 → 名称去重
        { key: 's4', name: 'B独有', type: 3, api: 'csp_Four' },
      ],
      lives: [{ name: '直播', type: 0, url: 'https://a.com/live.txt' }],       // 同名同址去重
      parses: [{ name: '解析1', type: 0, url: 'https://a.com/p1' }],           // 同名同址去重
      flags: ['qq', 'migu'],
      rules: [{ rule: ['x'], host: 'a.com' }],                                 // 键序不同也去重
      wallpaper: 'https://b.com/wp2.jpg',
    },
  },
]);

test('mergeConfigs：按 key 与名称去重，先到先得', () => {
  const { config, stats } = mergeConfigs(items());
  assert.equal(config.sites.length, 4);
  assert.equal(stats.dupKey, 1);
  assert.equal(stats.dupName, 1);
  const s2 = config.sites.find(s => s.key === 's2');
  assert.equal(s2.api, 'csp_Two'); // A 的赢
});

test('mergeConfigs：相对 ext 基于上游 URL 绝对化，爬虫类名 api 不被误解析', () => {
  const { config } = mergeConfigs(items());
  assert.equal(config.sites.find(s => s.key === 's1').ext, 'https://a.com/ext1.json');
  assert.equal(config.sites.find(s => s.key === 's1').api, 'csp_One');
  assert.equal(config.sites.find(s => s.key === 's3').api, 'https://cms.a/api.php/provide/vod/');
});

test('mergeConfigs：spider 投票——A 贡献 2 个保留的 csp 站、B 只剩 1 个，A 胜出', () => {
  const { config, stats } = mergeConfigs(items());
  assert.equal(config.spider, 'https://a.com/big.jar;md5;aaa');
  assert.equal(stats.spiderSource, 'A');
  // B 落败 jar 的 csp 站点被注入 site 级 jar
  const s4 = config.sites.find(s => s.key === 's4');
  assert.equal(s4.jar, 'https://b.com/other.jar');
  const s1 = config.sites.find(s => s.key === 's1');
  assert.equal(s1.jar, undefined); // 胜方站点不需要
});

test('mergeConfigs：siteJarInject=false 时不注入', () => {
  const { config } = mergeConfigs(items(), { siteJarInject: false });
  assert.equal(config.sites.find(s => s.key === 's4').jar, undefined);
});

test('mergeConfigs：lives/parses 同名同址去重', () => {
  const { config, stats } = mergeConfigs(items());
  assert.equal(config.lives.length, 1);
  assert.equal(config.parses.length, 1);
  assert.equal(stats.droppedLive, 1);
  assert.equal(stats.droppedParse, 1);
});

test('mergeConfigs：flags 并集、rules 键序无关去重、wallpaper 先到先得', () => {
  const { config } = mergeConfigs(items());
  assert.deepEqual(config.flags, ['qq', 'youku', 'migu']);
  assert.equal(config.rules.length, 1);
  assert.equal(config.wallpaper, 'https://a.com/wp.jpg');
});

test('mergeConfigs：maxSites 截断', () => {
  const { config } = mergeConfigs(items(), { maxSites: 2 });
  assert.equal(config.sites.length, 2);
});

test('mergeConfigs：jarPolicy=none 不设全局 spider', () => {
  const { config } = mergeConfigs(items(), { jarPolicy: 'none' });
  assert.equal(config.spider, undefined);
});

test('stableStringify：对象键顺序无关', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});