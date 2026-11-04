# Chatter 项目说明

两个人（或一小群好友）用的聊天 App：文字、图片、语音、视频通话，做成**单个网页文件**，放在 GitHub Pages 上，iPhone 用 Safari“添加到主屏幕”后像 App 一样用。后端是 Supabase 免费版。

- **线上地址**：<https://3855285335-gif.github.io/index.html/>
- **当前版本**：build 3.6（2026-11-04 完成）。线上在用户上传前还是 build 3.5，进 App 的“我”页面可以看到版本号。
- **本仓库的两个分支**
  - `main`：网站本身，只有根目录的 `index.html`（图标已经内嵌在页面里），GitHub Pages 从这里发布。**只放网页文件。** `sw.js` 和单独的图标文件从来没放到 `main` 上，所以网站实际没有启用离线缓存（Service Worker）。
  - `source`：全部源码、SQL、测试和这份说明。不会触发网站重新部署，也不会出现在网站上。

---

## 1. 目录结构（source 分支）

```
src/                 源码
  app.js             全部逻辑（登录、聊天、通话、国内模式……）
  shell.html         页面骨架和样式
  loader.html        Supabase 依赖库加载器（多个 CDN 竞速、本地缓存）
  logo.py            图标（SVG）
  favicon.svg / icon-180.png
  build.py           把上面几样合成一个网页 → site/index.html
site/                要发布的文件（index.html 由 build.py 生成）
  index.html  sw.js  icon-192.png  icon-512.png  icon-maskable-512.png
sql/                 Supabase 后端脚本（按编号顺序运行，都可以重复运行）
  1-setup.sql        建表、权限（RLS）、触发器、RPC、实时通道策略、存储桶
  2-setup-v3.sql     已读回执（服务器时间）、存储空间清理权限
  3-setup-v5.sql     国内模式（信号信箱、长轮询、在线状态）+ 中转服务器配置表
  4-setup-keepalive.sql  保活签到函数（配合 GitHub 定时任务）
  update-turn.sql    以后换中转账号 / 服务商只改这一段再运行，网页不用重传
  history/           已被合并、不用再单独运行的旧脚本
ops/
  keepalive.yml      保活定时任务（放在私有仓库 chatter-keepalive 的 .github/workflows/ 里，不要放进本仓库）
  worker.js          Cloudflare Worker 中转（备用方案，目前没用：workers.dev 在国内被封）
tests/               网页端自动测试（Node + Playwright 的 Chromium）
  fakelib.js         假的 Supabase 客户端（可模拟“国内网络拦住实时通道”）
  runall.sh          一键跑全部测试
  sql/               SQL 测试（本机 PostgreSQL 16 真实运行）
docs/
  国内模式-交接说明.md  国内模式的设计细节（给游戏窗口用过）
```

---

## 2. 构建与发布

```bash
python3 src/build.py          # 生成 site/index.html
bash tests/runall.sh 2        # 网页测试跑两遍（见第 7 节）
```

发布（用户在 iPhone 上操作）：
1. 如果有新的 SQL，先在 Supabase 运行：<https://supabase.com/dashboard/project/uaoiqbxptnbrvkzjwguc/sql/new>
2. 把 `site/index.html` 放到 `main` 分支根目录的 `index.html`。用户已决定由 Claude 直接推送，不再手动上传。如果要手动上传，就用 <https://github.com/3855285335-gif/index.html/upload/main>，**只提交一次**。然后等“操作”（Actions）页面变绿。
3. 手机上把 App 彻底关掉、再打开，GitHub Pages 本身有几分钟的缓存，可能要多开一两次。进“我”看版本号确认。
4. 两个人的手机都要换成新版，新旧版本混用可能互相收不到通话信号。

注意：GitHub Pages 同时有两个部署时可能卡住。每次只提交一次，等变绿后再做下一次。

---

## 3. 后端（Supabase）

- 项目：`uaoiqbxptnbrvkzjwguc`，网址 `https://uaoiqbxptnbrvkzjwguc.supabase.co`
- 网页里用的是**可发布密钥**（`sb_publishable_…`，本来就是公开的）。**秘密密钥绝不能放进网页或任何仓库。**
- 登录：账号转成假邮箱 `账号@chatter.local`。控制台里关掉了“Confirm email”（邮件确认），否则会碰到发信频率限制。
- 主要的表：`profiles`、`friend_requests`、`friendships`、`messages`、`conversations`（服务器维护未读数和预览）、`signals`（通话信号信箱）、`presence`（在线状态）、`app_config`（中转服务器配置）、`keepalive_state`。全部开启 RLS。新加的表不建任何策略，网页端只能通过 `security definer` 函数访问，函数只授权给登录用户。
- 存储：桶 `chat-media`，公开读，单个文件上限 20MB。每个人只能往自己的文件夹（`账号/`）上传，也只能列出、删除自己文件夹里的文件。
- 实时：每个用户一个私有广播频道 `u:账号`，用于秒到消息、通话信号、正在输入、已读、在线推送；另外订阅数据库变更（postgres_changes）和 Presence。
- **SQL 运行顺序**：`1-setup` → `2-setup-v3` → `3-setup-v5` → `4-setup-keepalive`。线上项目实际运行过哪些，以用户确认为准：保活函数肯定运行过（定时任务成功过一次）；发布 build 3.6 时要运行最新的 `3-setup-v5.sql`（含 ExpressTURN）。所有脚本都可以重复运行，不确定时再跑一遍也没关系。

### 保活（防止免费项目 7 天不活跃被暂停）
- 私有仓库 `chatter-keepalive` 里的 GitHub 定时任务（`ops/keepalive.yml`），每天北京时间 9 点左右调用一次 `keepalive()`。
- 放在**私有**仓库，是因为 GitHub 规定公开仓库 60 天没有提交，定时任务会被自动停用（[GitHub 文档](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)）。
- Supabase 官方说每天有几次请求“通常”就够了，但不保证（[Supabase 文档](https://supabase.com/docs/guides/platform/project-pausing)）。万一被暂停，会收到邮件，去控制台点“Resume project”恢复，一年内都能恢复。

---

## 4. 国内模式（不开 VPN 也能用）

**现象（用户实测）**：中国大陆不开 VPN 时，Supabase 的普通 HTTPS 请求是通的（数据库接口、登录、存储、广播的 HTTP 发送），**只有实时通道的 WebSocket 连不上**。

**做法**：只要实时通道没连上，就自动切到国内模式；连上了就自动切回去。
- **长轮询** `poll_inbox()`：服务器上有新消息或信号就立刻返回，没有就最多等 2.5 秒；手机拿到结果后马上再发下一个请求。模拟测试里延迟 0.1～0.3 秒。请求 10 秒没回就放弃、立刻重发。
- **通话信号**：每个信号同时走 HTTP 广播和数据库信箱（`send_signal`）两条路，靠唯一编号 `sq` 去重。信箱取走即删，超过 1 分钟的不再返回，避免“幽灵来电”。
- **在线状态**：变化了才推送（上线、下线、切后台），页面关闭时用 `fetch keepalive` 报离线；另外每 40 秒报到一次，服务器按 75 秒内报到过算在线。
- **已读**：`mark_read`（服务器时间）加 `peer_read` 轮询。
- 每台在国内模式下的手机会占用一个数据库连接，几个人用没问题，几十人同时在线不合适。

详细设计见 `docs/国内模式-交接说明.md`。

---

## 5. 通话

- WebRTC：默认画质“清晰”720p 约 2.5Mbps，可选“超清”1080p 约 4Mbps、“流畅”480p 约 1Mbps，选择会被记住；可以前后摄像头切换、大小画面互换，“通话信息”里显示分辨率、帧率、码率、延迟、丢包、直连还是中转。
- **STUN**（iPhone 5G 真机实测能用）：`stun.miwifi.com`、`stun.hitv.com`、`stun.chat.bilibili.com`、`stun.cloudflare.com`（都是 3478 端口）、`stun.l.google.com:19302`。`stun.qq.com` 实测不通，不用。
- **中转服务器（TURN）**：两台手机能直连时不走中转、不花额度；直连失败才走中转，按流量计费。
  - 主力是 ExpressTURN（`turn:free.expressturn.com:3478`，UDP 和 TCP 各一个），备用是 Metered（**只放 TLS 443**：`turns:global.relay.metered.ca:443?transport=tcp`）。
  - ⚠️ 浏览器（WebRTC）选中转时按协议定优先级：**UDP 2 > TCP 1 > TLS 0**，列表顺序只在同一种协议之间起作用（[WebRTC 源码评审记录：port.h](https://codereview.webrtc.org/2568833002/diff/1/webrtc/p2p/base/port.h)、[turnport.cc](https://codereview.webrtc.org/2568833002/diff/20001/webrtc/p2p/base/turnport.cc)）。用户实测国内不开 VPN（Wi-Fi 和 5G 一样）：ExpressTURN UDP ✗、TCP ✓，Metered UDP 80 ✓、TLS 443 ✓；开 VPN 全部 ✓。如果 Metered 留着 UDP，国内会优先走 Metered，很快用完它的 500MB。所以**除了主力，其他中转都不能放 UDP 地址**，`tests/configcheck.js` 会检查这一点。
  - 配置读取顺序：先读数据库 `app_config` 表里 key=`ice` 的那一行，读不到用 `src/app.js` 里的 `TURN_DEFAULT`。
  - 换账号或服务商：改 `sql/update-turn.sql` 再运行，**网页不用重传**。
- **“中转省流量”默认关**：走中转时不降画质，画质由用户自己选。用户在“我 → 📶 中转省流量”打开后，走中转时视频限制在约 300kbps、分辨率减半，语音约 24kbps；直连时不受影响。是否走中转每 4 秒复查一次。
- **“我 → 🛰 中转测试”**：每个 STUN、每家中转的每个地址分别单独测试。能拿到中转地址，只说明服务器连得上、账号正确，两台手机能不能真的打通要实际通话才知道。

### 额度（2026-11-04 在官网核实过）
| 服务 | 免费额度 | 来源 |
|---|---|---|
| ExpressTURN | 每月 1000GB；免费版只支持 3478 端口的 UDP/TCP | <https://expressturn.com/> |
| Metered | 方案名就叫 “Free: 500 MB trial”，每月 500MB（上传加下载合计）；超出后会怎样官网没写 | <https://metered.ca/pricing> |
| Supabase | 免费项目 7 天不活跃会暂停。存储、流量等其他额度这里没有重新核实，以官网为准 | <https://supabase.com/docs/guides/platform/project-pausing> |

---

## 6. 功能清单（build 3.6）

- **账号**：注册 / 登录，修改昵称、头像、密码。
- **好友**：搜索、请求、通过、删除，在线状态。
- **消息**：文字、表情、图片（原图不压缩，一次最多 9 张，单张 ≤20MB，看大图可以左右滑）、按住说话的语音。
- **消息操作**：长按菜单（回复引用、复制、2 分钟内撤回、删除仅自己）、正在输入、已读回执、草稿、搜索聊天记录、清空聊天记录、删除会话（这几项都只在本机生效）。
- **视频 / 语音通话**：见第 5 节。
- **存储空间**：查看和清理自己发过的图片、语音（对方也会看不到；头像不会被清理）。
- **国内模式**：见第 4 节；后台时标题闪烁提醒；发送失败后自动重发；本地缓存实现秒开；诊断页自动刷新。
- **没有做的**：群聊、App 关闭后的推送通知、发视频和文件、忘记密码后找回。

---

## 7. 测试

### 网页端
```bash
bash tests/runall.sh 2      # 需要 Node 和 Playwright（自带 Chromium）；最后会打印一共跑了几项、失败几项
```
用 `tests/fakelib.js` 代替真的 Supabase，两个浏览器页面分别扮演 alice 和 bob。主要的测试组：

| 测试 | 覆盖内容 |
|---|---|
| smoke | 登录、收发、撤回、图片、语音、来电铃声、通话接通/挂断、屏幕常亮 |
| vtest / stress | 视频画质、翻转摄像头、通话信息、大小画面；连打 6 通不泄漏 |
| chattest / chattest2 | 正在输入、已读、回复、长按菜单、多图原图、看图、自动重发、后台提醒、特殊字符 |
| storetest / acctest | 存储清理、改昵称 / 头像 / 密码、草稿、搜索、清空、删除会话 |
| skew / difftest / pptest | 手机时间不准、诊断页自动刷新、依赖库加载与缓存 |
| cntest / mix1-3 / hangtest | 国内模式：消息延迟、通话、一边开 VPN 一边不开、两条通道重复到达去重、没运行 SQL 时退回、请求被卡住后自动恢复 |
| relaytest / prtest / defaulttest | 中转配置来自数据库、省流量默认关、中转测试、在线状态即时推送、内置默认的服务器列表 |
| configcheck / icecheck / pptest | 网页内置的中转列表和两份 SQL 完全一致、除主力外没有 UDP、STUN 列表；浏览器接受全部服务器地址；依赖库加载 |

目前每遍是 17 组网页测试，加 1 组国内网络下的在线状态测试，最后再跑 3 项检查。`runall.sh 2` 一共 2×18+3 = 39 项。

### SQL
```bash
bash tests/sql/run-sql-tests.sh   # 需要本机 PostgreSQL 16（initdb / pg_ctl / psql）
```
`stub.sql` 模拟 Supabase 的 auth、storage、realtime，`seed.sql` 建三个测试账号（alice、bob 互为好友，carol 是外人），然后真实运行全部 SQL 和权限测试。输出里的 `ERROR: permission denied`、`not friends` 都是预期被拒绝的情况。

### 测试覆盖不到的（必须真机）
模拟环境全部通过，**不代表在用户的手机和网络上一定没问题**。下面这些只能真机测：
- iPhone Safari 和主屏幕 App 里的表现：摄像头、麦克风、长按、键盘、缓存更新。
- 真实国内网络下的消息延迟、来电、在线状态。
- 两台手机之间到底是直连还是走中转，以及中转服务器在国内能不能连上。用户实测过一次 ExpressTURN 和 Metered 都能拿到中转地址，但另有一次不开 VPN 时全部失败，原因还没查明。

---

## 8. 和用户合作的规矩（用户明确要求过）

- 全部用中文，包括步骤之间的进度说明。
- 改动攒成一次交付，尽量只让用户上传一次。说了“不用重新上传”就不能反悔。
- 反复测试、反复检查，用户最怕 bug。要写清楚哪些只在模拟环境测过、哪些还要真机测。
- 画质优先：图片、视频不压缩；**不经用户同意，不能为了省额度降低通话画质。**
- 可以改 SQL，但要先说清楚需要运行，并给出完整代码。
- GitHub 和 Supabase 的操作步骤，写 Safari 机翻后的中文按钮名，并附上直接网址。
- 所有数字、额度、地址，先查官网再说；没查过就明说“未核实”或“估算”。
- 以后可能会变的东西（服务器地址、账号、名单），一开始就放进数据库，改的时候只跑 SQL。
- 联网的数据一开始就按省额度设计：格式紧凑，变化了才发。
- 难以撤销的选择（比如建项目时选哪个地区），要在用户动手**之前**提醒。
- 每次交付都给用户看桌面图标。
- 用户在不同窗口分别做 Chatter 和游戏。写交接说明或待办之前，先读另一个窗口，确认每一步都需要、而且和之前说的一致。

---

## 9. 版本历史（简要）

- **3.0**（中间有多次更新，版本号没变）：极简图标、TURN 中转、语音播放修复；后来又加了 720p 默认画质、前后摄像头、通话信息、大小画面。
- **3.1**：输入提示、已读、回复、长按菜单、原图多图、看图、后台提醒、自动重发。
- **3.2**：已读永久保存（服务器时间）、存储空间清理（需要 `2-setup-v3.sql`）。
- **3.3**：改头像 / 昵称 / 密码、清空聊天记录、删除会话、草稿、搜索。
- **3.4**：诊断页自动刷新、依赖库缓存（修复 publicPath 报错）。
- **3.5**：国内模式（长轮询、数据库信号信箱、在线状态，需要 `3-setup-v5.sql` 的第一部分）。
- **3.6**：中转服务器配置放进数据库（ExpressTURN 主力、Metered 备用且只留 TLS 443）、中转测试、“中转省流量”开关（默认关）、在线状态变化即时推送、页面关闭时报离线、STUN 按真机实测核对。
