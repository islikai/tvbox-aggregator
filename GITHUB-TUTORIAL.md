# GitHub 推送与部署完全教程（任意一台新电脑通用）

> 适用场景：你在**任何一台电脑**（家里的笔记本、新机器、朋友的电脑都行）上拿到本项目文件夹，从零开始：注册 GitHub → 推送 → 自动部署 → 拿到电视可用的地址。
> 全程约 20~30 分钟，零基础可跟。每一步都给出「预期输出」和「报错自救」。
>
> 如果那台电脑上已经登录过**别的（公司/别人的）GitHub 账号**，额外先看 DEPLOY.md 的 1.3 节做账号隔离；干净电脑无需这步。

## 0. 全程路线图

```
① 把项目文件夹弄到那台电脑
② 装好 git，配置你的署名身份
③ 注册一个 GitHub 账号（邮箱验证）
④ 网页上建一个空仓库
⑤ 终端里五条命令推上去（浏览器授权一次）
⑥ Actions 页面手动跑一次，确认绿灯
⑦ 浏览器打开 jsDelivr 地址看到 JSON → 电视上填它
```

之后就是无人值守：GitHub 每小时自动重建，电视永远有新配置，那台电脑可以关机。

---

## ① 把项目弄到那台电脑

任选其一：

| 方式 | 做法 |
|---|---|
| U盘 / 移动硬盘 | 把整个 `tvbox-aggregator` 文件夹拷过去 |
| 网盘 / 微信传输 | 压缩成 zip 传过去再解压 |
| 两台电脑同局域网 | AirDrop（Mac 之间）或 `scp -r tvbox-aggregator 用户名@对方IP:~/` |

拷过去后，`cache/` 文件夹没有也无所谓（那是运行缓存，会自动生成）。有这两样就够：`config.json`（上游列表）+ `lib/`、`scripts/`（构建逻辑）+ `server.js`（本地服务，可选保留）。

---

## ② 装好 git 并配置身份

**先检查有没有 git**（macOS 自带；Windows 装过 Git for Windows 也有）：

```bash
git --version
```

| 系统 | 没装时怎么装 |
|---|---|
| macOS | 弹窗提示装 Xcode 命令行工具，点安装即可（或已自带，如 `git version 2.x`） |
| Windows | 去 [git-scm.com/download/win](https://git-scm.com/download/win) 下载，安装**一路下一步**（默认选项即可），装完重开终端 |
| Linux | `sudo apt install git`（Debian/Ubuntu）或 `sudo yum install git`（CentOS） |

**配置你的署名**（commit 上显示的作者，改成你自己的）：

```bash
git config --global user.name  "你的GitHub用户名"
git config --global user.email "你的GitHub注册邮箱"
```

> 这只是「署名」，不决定能推到哪个账号（那由登录授权决定）。干净电脑直接设全局即可。
> Windows 用户：以下所有命令都在 **Git Bash** 里敲（项目文件夹上右键 → `Git Bash Here`），不要用 CMD。

---

## ③ 注册 GitHub 账号

1. 浏览器打开 [github.com/signup](https://github.com/signup)
2. 依次填：**邮箱**（常用邮箱即可）→ **密码**（设强点）→ **用户名**
3. 用户名注意两点：
   - 它会出现在电视填的地址里：`cdn.jsdelivr.net/gh/`**`<用户名>`**`/...`，建议**短、全小写字母**（电视遥控器输长地址很痛苦）
   - 想好再定，改起来麻烦
4. 免费计划（Free）→ 完成人机验证
5. **去邮箱点验证邮件**（没有这一步，推送会被拒；找不到就翻垃圾邮件文件夹）

---

## ④ 网页上建一个空仓库

1. 登录后点右上角 **`+` → New repository**
2. 只需要填三处：
   - **Repository name**：如 `tvbox-config`
   - 可见性：选 **Public**（必须。Private 仓库 jsDelivr 无法分发，Actions 免费时长也受限）
   - 下面所有勾选框**全部不勾**：不要 README、不要 .gitignore、不要 License——本地项目里都有了，勾了会产生冲突
3. 点 **Create repository**
4. 出现一个写满命令的提示页——**别关，下一步照着它敲**（本文下一节就是那些命令的中文注解版）

---

## ⑤ 推送：在项目文件夹打开终端，敲五条命令

**打开终端并进入项目目录**：

- macOS：`终端(Terminal)` → `cd 拖入项目文件夹`（拖进来自动补路径）→ 回车
- Windows：项目文件夹上右键 → **Git Bash Here**（一步到位，不用 cd）

**依次执行**（把 `<你的用户名>` 换成第 ③ 步注册的用户名）：

```bash
git init -b main
git add .
git commit -m "init: TVBox aggregator"
git remote add origin https://github.com/<你的用户名>/tvbox-config.git
git push -u origin main
```

每条命令干什么 / 预期输出：

| 命令 | 干什么 | 成功时看到 |
|---|---|---|
| `git init -b main` | 把这个文件夹变成 git 仓库，主分支叫 main | `Initialized empty Git repository ...` |
| `git add .` | 把所有文件放进「待提交清单」（cache/ 等已被 .gitignore 排除） | 无输出（正常） |
| `git commit -m "..."` | 提交到本地仓库 | `xx files changed, xxx insertions` |
| `git remote add origin ...` | 记住远端仓库地址，起名叫 origin | 无输出（正常） |
| `git push -u origin main` | 真正上传 | 见下方授权说明 |

**第一次 push 会弹浏览器授权**：

1. 弹出 GitHub 登录页 → 登录**你的私人账号**（弹的是已登录账号时，先确认是你自己的，不是就退出换号）
2. 点 **Authorize git-ecosystem**（或类似的 Authorize 按钮）
3. 浏览器提示成功，回到终端看到：

```
Enumerating objects: 20, done.
...
To https://github.com/<你的用户名>/tvbox-config.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

看到 `* [new branch] main -> main` 就是**推成功了**。刷新 GitHub 仓库网页，能看到完整文件列表（约 15 个文件 + `dist/config.json`）。

### 推送报错自救表

| 报错关键词 | 原因 | 解法 |
|---|---|---|| `fatal: not a git repository` | 没 cd 进项目目录 / 没执行 init | `pwd` 确认位置，回项目根目录重来 |
| `src refspec main does not match any` | commit 没成功（比如 git 身份没配） | `git log --oneline` 看有没有提交；没有就回第 ② 步配身份再 commit |
| `Authentication failed` / `401` | 邮箱没验证 / 授权弹窗登错账号 | 去邮箱点验证；重新 push 换账号授权 |
| `remote: Permission to ... denied` / `403` | 授权的账号不是仓库主人 | 确认仓库建在自己的账号下；浏览器退出当前 GitHub 账号重新 push 授权 |
| `fatal: unable to access`（超时/连接重置） | 当前网络连 github.com 不稳 | 多试几次 / 换时段 / 换网络；实在不行给 git 配代理：`git config --global http.proxy http://127.0.0.1:代理端口`（用完记得 `--unset`） |
| Windows 弹 Git Credential Manager 每次都要登录 | 凭据助手没记住 | 正常情况会自动记住；没记住就重装时保持默认选项 |

### （可选进阶）gh CLI 一条龙

不想敲五条命令的，装 GitHub 官方 CLI（`brew install gh` / [winget 安装](https://cli.github.com/)）：

```bash
cd tvbox-aggregator
gh auth login                  # 浏览器登录你的账号
gh repo create tvbox-config --public --source . --push
```

最后一条 = 建仓库 + 关联 + 推送，一步完成。

### （可选进阶）SSH 方式

多台电脑长期推送可用 SSH 免密（略读，用到再说）：`ssh-keygen -t ed25519` 生成密钥 → 公钥贴到 GitHub **Settings → SSH keys** → remote 地址换成 `git@github.com:<用户名>/tvbox-config.git`。

---

## ⑥ 让 Actions 跑起来（首次手动触发）

1. 仓库网页 → 顶部 **Actions** 标签
2. 首次进入可能显示「选择工作流模板」或「启用」提示 → 左侧找到 **build-config** → 点 **I understand my workflows, go ahead and enable them**（如有）
3. 左侧选中 **build-config** → 右侧点 **Run workflow** → 分支选 `main` → 绿色按钮 **Run workflow**
4. 黄点转圈 1~2 分钟 → 变 **绿 ✓**
5. 验证成果：回 **Code** 标签刷新 → 应看到一条新提交，作者是 **`github-actions[bot]`**，提交信息 `chore: rebuild aggregated config`——机器人开工了

**看详细日志**（排错用）：点进那次运行 → 点 `build` → 三个步骤逐个展开，「聚合构建」步骤里能看到每个上游的 `✓/✗`。

**失败自救**：

| 现象 | 处理 |
|---|---|
| 「聚合构建」步骤红 | 展开日志看哪个上游 `✗`——单个失败不影响整体（其余照常合并）；全部 `✗` 才会中止，多半是 GitHub 到上游的网络抽风，直接 Re-run 重试 |
| 「提交产物」红 | 检查 `.github/workflows/build.yml` 里有没有 `permissions: contents: write`（本项目已内置） |
| 定时任务没跑 | 高峰期延迟 5~30 分钟正常；超过 1 小时再手动跑一次看看 |

---

## ⑦ 获取电视上填的地址（核心成果）

把 `<你的用户名>`/`tvbox-config` 换成你的，按国内可用性排序：

| 优先级 | 地址 | 特点 |
|---|---|---|
| ⭐ 主选 | `https://cdn.jsdelivr.net/gh/<你的用户名>/tvbox-config@main/dist/config.json` | jsDelivr 国内 CDN；工作流每次构建后自动清缓存，一般几分钟生效 |
| 备用 | `https://gh-proxy.com/https://raw.githubusercontent.com/<你的用户名>/tvbox-config/main/dist/config.json` | 原文件+国内加速壳，**无缓存永远最新**；域名不通就换 `gh-proxy.org`、`ghproxy.net` |
| 海外网络 | `https://raw.githubusercontent.com/<你的用户名>/tvbox-config/main/dist/config.json` | 原始文件；国内直连通常不通 |
| 可选 | `https://<你的用户名>.github.io/tvbox-config/dist/config.json` | 需在 Settings → Pages 开启（Source 选 main / root）；国内基本被墙，仅海外用 |

**验证（必做）**：电脑浏览器打开主选地址——

- 看到 `{"spider":...,"sites":[{...` 这样一大坨 JSON → ✅ 成功，电视上填它
- **404** → 按序检查：仓库是不是 Public？分支是不是 `main`（仓库页面左上角下拉框看）？文件路径是不是 `dist/config.json`（Code 页面点进 dist 文件夹确认存在）？
- **打开很慢/超时** → 当前网络对 jsDelivr 抽风，换备用地址试试；电视所在的网络和电脑的网络连通性**不一定相同**，以电视实测为准

命令行党验证：

```bash
curl -s "https://cdn.jsdelivr.net/gh/<你的用户名>/tvbox-config@main/dist/config.json" | head -c 200
```

---

## ⑧ 电视上配置

1. TVBox / 影视 / OK影视 → **设置**（遥控器菜单键，或首页长按 OK）
2. 找到「**配置地址** / 接口地址」输入框
3. 输入第 ⑦ 步验证过的地址（遥控器输入慢，可先在手机上复制、用客户端的「手机扫码/网页推送配置」功能；或电视装个输入法带剪贴板）
4. 确定 → 提示「配置获取成功」→ 返回首页，能看到聚合出来的几百个站点

**建议双保险**：主配置存 jsDelivr 地址（电脑关机也在），再加一份本地地址 `http://<那台电脑的局域网IP>:4567/config`（电脑开 `node server.js` 时有代理加速）。哪个失效切哪个。

---

## ⑨ 之后的日常（维护速查）

| 想做什么 | 操作 |
|---|---|
| 换源/加源 | 改 `config.json` 的 `upstreams` → 仓库页面**网页直接编辑也行**（点文件铅笔图标）→ 提交 → 2 分钟后 Actions 自动重建生效 |
| 立刻重建不等整点 | Actions → build-config → Run workflow |
| 看配置新鲜度 | 仓库里 `dist/status.json`（每次构建的上游存活+合并统计） |
| 确认服务活着 | 仓库首页 Actions 徽章 / Actions 页面看最近一次是不是绿 ✓ |
| 完全不想要云端的了 | Actions → build-config → `⋯` → Disable workflow（本地 `npm start` 不受影响） |
| 换电脑继续维护 | 新电脑上 `git clone https://github.com/<你的用户名>/tvbox-config.git` 即可，`node server.js` 照跑 |

---

## ⑩ 术语小词典（30 秒版）

| 词 | 一句话解释 |
|---|---|
| repository（仓库） | GitHub 上的一个项目文件夹 |
| commit | 一次存档（快照），带作者、时间、说明 |
| push | 把本地的存档上传到 GitHub |
| clone | 把 GitHub 的仓库下载到本地 |
| branch / main | 分支；main 是默认主干，本项目只用它 |
| remote / origin | 远端仓库的地址代号，origin 是习惯名 |
| Actions / workflow | GitHub 的自动化机器人；workflow = 你写的 `.yml` 任务单 |
| GITHUB_TOKEN | 每次运行自动发的临时令牌，本项目靠它提交产物，**不需要你配任何密钥** |

---

## ⑪ 一屏命令卡（贴墙用）

```bash
# —— 任意新电脑，从零推送 ——
git config --global user.name  "<你的用户名>"
git config --global user.email "<你的邮箱>"
cd tvbox-aggregator                      # 进项目
git init -b main
git add .
git commit -m "init: TVBox aggregator"
git remote add origin https://github.com/<你的用户名>/tvbox-config.git
git push -u origin main                  # 浏览器授权一次

# —— 电视上填 ——
https://cdn.jsdelivr.net/gh/<你的用户名>/tvbox-config@main/dist/config.json
```

推送后：Actions → build-config → **Run workflow** → 绿 ✓ → 浏览器验证地址 → 电视填入。完事。