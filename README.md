# 📺 TVBox 聚合源服务

零依赖 Node.js 本地服务：把多个远程 TVBox 配置**自动合并成一个聚合配置**，在局域网里给电视端（TVBox / 影视 / OK影视 / FongMi 系）当「配置地址」用。

```
  多个上游配置 ──┐                     ┌─> 电视上的 TVBox
  (GitHub 仓)    ├─ 拉取 → 去重合并 ──┤       只填一个地址
  (CMS 接口)     └─ 缓存 → 代理加速 ──┘
                        http://<本机IP>:4567/config
```

## 快速开始

```bash
cd tvbox-aggregator
node server.js          # 需要 Node >= 18；换端口: PORT=8080 node server.js
```

> 📡 **想要电脑关机也能用？** 推到 GitHub 让 Actions 每小时自动产出静态配置（电视填 jsDelivr 地址，永久免费），与本地模式共用同一份 `config.json` —— 完整步骤见 [DEPLOY.md](DEPLOY.md)。

启动后打开 `http://127.0.0.1:4567/` 看管理页。**在电视的「配置地址」里填**管理页顶部大字展示的局域网地址（如 `http://192.168.x.x:4567/config`），电视需与本机同网。

默认上游（2026-11-20 已逐一验证可拉取）：

| 上游 | 规模 | 说明 |
|---|---|---|
| qist 家庭电视版 | 150 站 | 上游维护者每日探活，ext 存活率实测 95% |
| hubeizgd 日更合并 | 164 站 + 36 直播组 | GitHub Actions 每日合并产物 |
| lightconer 聚合大仓 | 489 站 | 量最大；约 1/3 的 ext 是上游死链（仓库已重构），但仍是内容最多的补充源 |
| qiuzhu 实时聚合 | 822 站 | 自动刷新聚合，站名自带延迟标注（源自带探活）；实测真新增 612 站 |
| hanyurn 日聚合精选 | 98 站 | 「聚合后仍存活」精选（短剧/官源），直播每三天检测 |
| hebijunge 推荐大合集 | 1630 站 | 默认关闭，`enabled: true` 打开（电视端加载较慢） |

五源合并结果：**1338 站 / 44 直播组 / 80 解析**。嫌电视加载慢可把大源（qiuzhu/聚合大仓）的 `enabled` 设 `false`，或用 `maxSites` 设上限。

## 路由

| 路由 | 用途 |
|---|---|
| `GET /` | 管理页：上游健康、合并统计、配置地址、刷新按钮 |
| `GET /config` | **聚合配置（电视上填这个）**，`?refresh=1` 先刷新再返回 |
| `GET /status` | JSON 状态详情 |
| `GET /refresh` | 触发后台刷新（POST 亦可） |
| `GET /p/<b64url>` | 资产代理：ext / jar / 解析 / 直播地址都改写走这里，带磁盘缓存 |

## 它帮你做了什么

1. **合并去重**：按 `key` + 站点名去重（先到先得，顺序即优先级），`lives`/`parses` 按名+址去重，`flags`/`rules` 合并，`wallpaper` 等取第一个非空。
2. **相对路径绝对化**：上游配置里的 `./deps/x.jar`、`/json/y.json` 都基于上游 URL 解析成绝对地址，换基地址不失效。
3. **spider jar 投票**：TVBox 只认一个全局 `spider`，谁贡献的爬虫站多谁胜出；落败上游的爬虫站会注入**站点级 `jar`**（FongMi / 影视 / OK影视 系客户端支持，老 TVBoxOSC 忽略）。
4. **资产代理加速**（`proxy: true`）：配置里所有 ext/jar/解析/直播外链改写成 `/p/...`，由本机代拉并缓存（默认 6 小时）。抓取链逐级尝试：**直连 → jsDelivr（GitHub 文件）→ gh 镜像 → GitHub API（可拿 .jar）→ 302 回退原址**。最后一跳是关键：本机网络拉不到时直接 302 让电视用自己的网络去拉——本机在公司网/校园网受限不代表电视所在的网络也不通。
5. **缓存与自愈**：上游快照落盘（重启秒开，失败时继续用旧数据），每 60 分钟自动刷新；失败地址记 10 分钟负缓存，被墙域名记 10 分钟黑名单，均不落盘、不影响别的网络环境。
6. **配置热重载**：改 `config.json` 保存即生效，无需重启。

## config.json 常用字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` / `host` | `4567` / `0.0.0.0` | 监听地址；`PORT`/`HOST` 环境变量可覆盖 |
| `upstreams` | 见上 | `{name, url, enabled}` 数组，顺序 = 合并优先级 |
| `refreshMinutes` | `60` | 后台刷新周期 |
| `assetTtlHours` | `6` | 代理资产缓存时长 |
| `dedupeByName` | `true` | 站点同名去重（只想按 key 去重就关掉） |
| `jarPolicy` | `vote` | `vote` / `first` / `none` |
| `siteJarInject` | `true` | 败方 jar 按站点注入 |
| `proxy` / `proxyLives` | `true` | 资产/直播走本地代理；全关则输出纯净配置 |
| `maxSites` / `maxLives` / `maxParses` | `0`/`60`/`80` | 数量上限，`0` 不限 |
| `mirrors` | `["https://gh-proxy.org/"]` | gh 镜像列表，可加 `https://ghproxy.net/` 等 |
| `skipDirectHosts` | `["raw.githubusercontent.com"]` | 已知直连不通的宿主，跳过直连省时间 |

### 换源 / 加源

编辑 `config.json` 的 `upstreams`：把别的配置地址（`http://.xx.json`）填进 `url`，`enabled: true`，保存即可。支持三种形态：普通配置 JSON、txt 单行跳转文件、`{urls:[...]}` 多仓壳（自动展开，最多 12 个子仓）。

## 测试

```bash
npm test        # 17 个合并逻辑单测（node:test，无网络依赖）
```

## 常见问题

- **电视上源点不开**：先看管理页该上游是否 ✓；再 `/status` 看 `proxy` 统计里 `fail` 是否上涨。上游自身死链（如 lightconer 的部分 ext）无解，换源或调整顺序。
- **公司/校园网环境**：jsDelivr 和 GitHub API 通常是通的（本服务优先走它们）；gh-proxy 系镜像可能被网关拦，服务会自动识别并绕行，拿不到就 302 让电视自己拉。
- **开机自启**：`nohup node server.js >> tvbox.log 2>&1 &`，或用 launchd / systemd 托管。
- **给电视减负**：站点太多卡的话设 `maxSites: 600`，或关掉大仓。

## 目录结构

```
tvbox-aggregator/
├── server.js           # 入口：路由、调度、热重载、落地页
├── lib/merge.js        # 纯函数：URL 解析、合并去重、jar 投票
├── lib/proxy.js        # 智能抓取链 + 磁盘资产缓存
├── lib/upstream.js     # 上游解析：txt 跳转、多仓展开
├── config.json         # 服务设置 + 上游列表（改完即生效）
├── tests/merge.test.js # 单测
└── cache/              # 运行时生成：上游快照 + 资产缓存
```

仅供学习交流，请于 24 小时内删除并支持正版。