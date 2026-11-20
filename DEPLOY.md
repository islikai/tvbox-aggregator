# 部署指南 · GitHub Actions 免费云部署（与本地模式双轨并存）

> 目标：把聚合配置托管到 GitHub，**电脑关机电视也能用**；同时本地 `npm start` 的完整服务照常可用。两种形态共用同一份 `config.json`，换源只改一处。
>
> 🆕 **完全没碰过 GitHub / 想在别的电脑上操作？** 逐步带截图位说明的零基础流程见 [GITHUB-TUTORIAL.md](GITHUB-TUTORIAL.md)（注册、装 git、推送、授权、报错自查、拿地址，一站到底）。

## 0. 你会得到什么

```
                    ┌─ 本地形态（完整功能）─────────────────┐
 config.json ──┬────┤ node server.js                        │
 (唯一配置源)  │    │   /p/ 代理加速 · 管理页 · 实时刷新      ├──> 电视填
              │    └────────────────────────────────────────┘   http://<Mac的IP>:4567/config
              │
              │    ┌─ 云端形态（零成本常驻）────────────────┐
              └────┤ push 到 GitHub                        │
                   │ Actions 每小时跑 scripts/build-static │──> 电视填
                   │ 产出 dist/config.json (纯静态)         │   https://cdn.jsdelivr.net/gh/<用户>/<仓库>@main/dist/config.json
                   └────────────────────────────────────────┘
```

- **费用**：公开仓库的 Actions 与分发全部免费，无服务器、无信用卡
- **刷新粒度**：云端每小时（cron `17 * * * *`），本地实时
- **注意**：云端产物是「纯配置」（没有 `/p/` 代理），ext/jar 等外链由电视直接拉取；本地形态才有代理加速

---

## 1. 推送到 GitHub

### 1.1 建仓库（必须是 Public）

打开 [github.com/new](https://github.com/new)：
- Repository name：随意，如 `tvbox-config`
- 选 **Public**（Private 仓库 jsDelivr 无法分发，Actions 免费时长也受限）

### 1.2 本地初始化并推送

在项目目录执行（把 `<你的用户名>` 和仓库名换成自己的）：

```bash
cd /Users/mac/Desktop/tvbox-aggregator

git init -b main
git add .
git commit -m "init: TVBox 聚合源服务（本地服务 + Actions 静态构建）"

# HTTPS 方式（会提示浏览器登录授权）
git remote add origin https://github.com/<你的用户名>/tvbox-config.git
git push -u origin main
```

### 1.3 ⚠️ 推送前先确认用哪个 GitHub 账号

**如果这台电脑上登录/保存的是公司或别人的 GitHub 凭据**，直接 push 会把仓库建到那个账号名下。先检查：

```bash
git config --global user.name          # 当前全局 git 身份（提交署名用）
git config --global user.email
gh auth status 2>/dev/null             # GitHub CLI 登录的账号（装了 gh 才有）
```

想用另一个私人账号推送，任选其一：

- **仓库级身份**（只影响提交署名，不影响推到哪）：
  ```bash
  git config user.name  "你的私人用户名"
  git config user.email "你的私人邮箱"
  ```
- **推送到私人账号**（凭据层面）：
  - 最干净：给私人账号生成 SSH key 并用 SSH 形式的 remote：`git remote set-url origin git@github.com:<你的用户名>/tvbox-config.git`（macOS 的 HTTPS 凭据存在钥匙串里，会自动用已登录的那个账号，注意区分）
  - 或者：浏览器**隐身窗口**登录私人账号建仓库，push 时 HTTPS 弹窗选「在浏览器登录」用私人账号授权
  - 或者：用 GitHub Desktop / gh 单独登录私人账号后再推

仓库是 Public 的，推到哪个账号名下就归谁展示——想清楚再推。

> 首次推送已包含 `dist/config.json`（本地刚构建过），所以**推完立刻就有可用地址**，不用等 Actions。
> `cache/` 已在 `.gitignore` 里，运行缓存不会进仓库。

---

## 2. 确认 Actions 跑通（首次建议手动触发一次）

1. 打开仓库页面 → 顶部 **Actions** 标签
2. 左侧选 **build-config** 工作流
3. 右侧 **Run workflow** → 分支 `main` → 点击运行
4. 点进这次运行，三个步骤全绿（聚合构建 / 提交产物 / 刷新 jsDelivr 缓存）即成功
5. 之后它会每小时自动跑；改 `config.json` 推上来也会立即触发重建

> 工作流已内置 `permissions: contents: write`，能自动把 `dist/` 提交回仓库，无需任何额外配置。

---

## 3. 获取电视上填的地址（重点）

设你的仓库是 `https://github.com/<用户>/<仓库>`，可用地址按国内可用性排序：

| 优先级 | 地址 | 说明 |
|---|---|---|
| ⭐ 首选 | `https://cdn.jsdelivr.net/gh/<用户>/<仓库>@main/dist/config.json` | jsDelivr CDN，国内家用网络一般可达；工作流每次构建后已自动 purge 缓存，正常几分钟内生效，偶尔有最长数小时延迟 |
| 备用 | `https://gh-proxy.com/https://raw.githubusercontent.com/<用户>/<仓库>/main/dist/config.json` | raw 原文件 + 国内加速壳，无缓存、永远最新；gh-proxy.com 不通时把域名换成 `gh-proxy.org`、`ghproxy.net` 试试 |
| 海外网络 | `https://raw.githubusercontent.com/<用户>/<仓库>/main/dist/config.json` | 原始文件，无缓存；国内直连通常不通 |
| 可选 | `https://<用户>.github.io/<仓库>/dist/config.json` | 需在 Settings → Pages 开启（Source 选 main 分支）；国内访问 github.io 基本被墙，仅海外或自备域名时用 |

> 💡 jsDelivr 偶发抽风想要更稳的国内直连？可以把成品镜像到**码云**拿一个国内 raw 地址，见文末第 8 节。

### 怎么验证地址可用？

**在电脑浏览器里打开上面的地址**，看到一大段 JSON（开头有 `"sites": [...]`）就是通了。也可以命令行验证：

```bash
curl -s "https://cdn.jsdelivr.net/gh/<用户>/<仓库>@main/dist/config.json" | head -c 200
```

看到 JSON 内容返回即成功。哪个地址通，电视上就填哪个。

### 建议的电视端策略

TVBox 可以保存多个配置随时切换：**主配置填 jsDelivr 地址**（电脑关机也能用），**再加一个本地地址** `http://<Mac的IP>:4567/config`（电脑开着时有代理加速）。哪个失效切哪个。

---

## 4. 电视端配置

1. TVBox / 影视 / OK影视 → 设置（遥控器按菜单键或长按 OK）
2. 找到「配置地址 / 接口」输入框
3. 用遥控器输入太慢的话：多数客户端支持**手机扫码**或**同一局域网网页推送**，也可以先在手机上复制地址再粘贴
4. 填入第 3 步选好的地址 → 确定 → 等待「配置获取成功」
5. 返回首页即见聚合出来的 686 个站点

---

## 5. 日常维护

| 想做什么 | 怎么做 |
|---|---|
| 换源 / 增删上游 | 编辑 `config.json` 的 `upstreams`（顺序 = 优先级）→ push → Actions 自动重建，几分钟生效 |
| 想要片源更多 | 把 `推荐大合集` 的 `enabled` 改 `true` 再 push（1630 站，电视加载会变慢） |
| 立刻重建不等定时 | Actions 页面手动 Run workflow，或本地 `node scripts/build-static.js` |
| 本地临时起完整服务 | `npm start`（管理页 `http://127.0.0.1:4567/`，含代理加速与健康监控） |
| 看云端构建质量 | 仓库里 `dist/status.json`（每次构建的上游存活、合并统计） |
| 调整合并行为 | `config.json` 的 `dedupeByName` / `jarPolicy` / `maxSites` 等字段，见 README |

---

## 6. 常见问题

**Q：jsDelivr 打开的还是旧配置？**
工作流已自动 purge；偶尔 purge 失效就等几小时（缓存自然过期），或手动访问一次：
`https://purge.jsdelivr.net/gh/<用户>/<仓库>@main/dist/config.json`
急用就换「备用」的 gh-proxy 地址（无缓存）。

**Q：Actions 里「聚合构建」步骤红了？**
点开日志看是哪个上游 `✗`。单个上游失败不影响整体（其余照常合并）；全挂了才会中止且不覆盖旧产物。上游地址换掉了就更新 `config.json` 里的 url。

**Q：为什么提交记录全是 github-actions bot？**
那是每小时自动重建的产物提交，正常现象。想留干净的 git 历史可以把 dist 提交改到单独分支（工作流里加 checkout 到 `dist` 分支即可）。

**Q：能改成 Private 仓库吗？**
jsDelivr 不支持私有仓库。Private 只能走 GitHub Pages（需绑自己的域名）或纯本地模式。

**Q：会超 GitHub 免费额度吗？**
公开仓库 Actions 分钟数免费无限额；Pages 带宽 100GB/月；jsDelivr 无硬性限额。每小时一次的构建量（几分钟）远远用不满。

**Q：电视上很多源点不动？**
两类原因：① 上游自身死链（如 lightconer 部分 ext，仓库已删文件）——换上游顺序或删掉它；② 你的网络拉不动某些 gh 链接——用本地模式（`/p/` 代理会代拉）或电视配双地址切换。

**Q：想部署到自己服务器 / VPS？**
本地形态就是完整服务：`npm start` 常驻即可（或 systemd / pm2 托管），不需要本文件的动作流程。

---

## 7. 安全提醒

- 仓库是 Public 的：`config.json`、构建产物全部公开可见（上游地址本来就是公开的，无隐私风险），但**别把任何私有 token、付费订阅地址写进配置**
- 本地服务无鉴权，仅适合家庭局域网使用，不要把端口暴露到公网（有需要请自行加反代 + 密码）

---

## 8. 可选：码云（Gitee）国内镜像

> 定位：**备用国内直连地址**，不是 GitHub 方案的替代品。GitHub 仍是唯一源头（Actions 在那边构建），码云只镜像成品 `dist/`。

**为什么不当主战场**：Gitee Pages 早已对新用户关闭；Gitee Go 的 CI 免费额度小且和 GitHub Actions 语法不兼容；最关键是 TVBox 影视聚合源属于 Gitee 内容审核的高危区，历史上大规模删过库——所以只放成品、随时可弃。

### 操作步骤

1. **注册码云**：[gitee.com](https://gitee.com) 用手机号注册
2. **建一个空仓库**：名字随意（如 `tvbox-config`），**不要**勾选「初始化仓库」（Readme/.gitignore 都不建，保持全空）
3. **关联 GitHub 同步**：进入刚建的仓库 → **管理 → 仓库镜像**（有的入口叫「强制同步」）→ 填你的 GitHub 仓库地址 `https://github.com/<用户>/<仓库>` → 点同步。免费版是**手动**触发：以后每次想刷新镜像，回来点一下即可
4. **拿电视地址**：镜像完成后，电视可填
   ```
   https://gitee.com/<用户>/<仓库>/raw/main/dist/config.json
   ```
   （分支名以镜像仓库里实际存在的为准——Gitee 新仓默认 `master`，从 GitHub 同步会把 `main` 带过来，用浏览器打开试一下就知道）
5. **验证**：浏览器打开上面的地址，看到 JSON 即通

### 使用策略（双地址对冲）

- TVBox 里**同时存两份配置**：主配置 = jsDelivr 地址（电脑关机也在），备配置 = Gitee raw 地址（国内直连最稳）
- 平时不用管；jsDelivr 抽风或想立刻拿新版时，去 Gitee 点一次「强制同步」再切换配置
- **万一 Gitee 删库**：源头还在 GitHub，重新建仓 + 同步就恢复了，什么都不用改

### 什么时候需要手动刷新镜像？

| 场景 | 要不要点同步 |
|---|---|
| 日常（每小时 GitHub 自动构建） | 不用，jsDelivr 地址本来就是新的 |
| jsDelivr 被墙/缓存迟迟不刷新，想用 Gitee 地址拿新版 | 点一次 |
| 刚在 GitHub 上改了 `config.json`，急着用 Gitee 地址 | 等 Actions 跑完（约 2 分钟）再点 |