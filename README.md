# Chatter 项目说明

两个人（或一小群好友）用的聊天 App：文字、表情包、图片、视频、文件、语音、视频通话，做成**单个网页文件**，放在 GitHub Pages 上，iPhone 用 Safari“添加到主屏幕”后像 App 一样用。后端是 Supabase 免费版。

- **线上地址**：<https://3855285335-gif.github.io/index.html/>
- **当前版本**：build 4.0（2026-11-07 发布）。需要的 SQL 一直到 `sql/7-setup-v8.sql`；“App 关掉也能收到通知”还需要在 Supabase 部署 `chatter-push` 函数（见第 5.5 节）。进 App 的“我”页面可以看到版本号。
- **本仓库的两个分支**
  - `main`：网站本身，GitHub Pages 从这里发布。**只放网页要用的文件**：`index.html`（图标已内嵌）、`sw.js`（后台小助手，只管通知，**不缓存页面**）、`manifest.webmanifest`（添加到主屏幕用）、`icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`badge-96.png`（安卓状态栏的小图标）。4.0 之前 `main` 上只有 `index.html`。
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
  sw.js              后台小助手（service worker）：收到推送弹通知、点通知打开聊天；不缓存页面
  build.py           把上面几样合成一个网页 → site/index.html；同时生成 site/sw.js、site/manifest.webmanifest
site/                要发布的文件（index.html、sw.js、manifest.webmanifest 由 build.py 生成）
  index.html  sw.js  manifest.webmanifest  icon-192.png  icon-512.png  icon-maskable-512.png  badge-96.png
supabase/functions/chatter-push/index.ts   推送函数（整段粘贴到 Supabase 后台的函数编辑器里部署，不用任何密钥）
sql/                 Supabase 后端脚本（按编号顺序运行，都可以重复运行）
  1-setup.sql        建表、权限（RLS）、触发器、RPC、实时通道策略、存储桶
  2-setup-v3.sql     已读回执（服务器时间）、存储空间清理权限
  3-setup-v5.sql     国内模式（信号信箱、长轮询、在线状态）+ 中转服务器配置表
  4-setup-keepalive.sql  保活签到函数（配合 GitHub 定时任务）
  5-setup-v6.sql     表情包（stickers 表）、视频 / 文件消息类型、单个文件上限 50MB、后端版本号 chatter_schema()
  6-setup-v7.sql     好友备注（friendships.remark、set_remark()）、存储用量 storage_used()
  7-setup-v8.sql     推送：push_subs（每台手机的推送地址）、push_keys（签名密钥）、push_log（防重复）、push_job() 等
  （5～7 都会先检查“是不是 Chatter 的数据库”，整份放在一个事务里：选错项目时直接报错，什么都不改）
  update-turn.sql    以后换中转账号 / 服务商只改这一段再运行，网页不用重传
  history/           已被合并、不用再单独运行的旧脚本
ops/
  keepalive.yml      保活定时任务（放在私有仓库 chatter-keepalive 的 .github/workflows/ 里，不要放进本仓库）
  worker.js          Cloudflare Worker 中转（备用方案，目前没用：workers.dev 在国内被封）
tests/               网页端自动测试（Node + Playwright 的 Chromium）
  fakelib.js         假的 Supabase 客户端（可模拟“国内网络拦住实时通道”）
  runall.sh          一键跑全部测试
  push/              推送函数的测试（Node 用 http_ece 交叉验证加密；Deno 原样运行函数文件）。依赖要先装：在 tests/push 里 npm install（这个环境要走代理）
  sql/               SQL 测试（本机 PostgreSQL 16 真实运行）
docs/
  国内模式-交接说明.md  国内模式的设计细节（给游戏窗口用过）
  限制清单.md        全部额度和限制（官网核实 + 代码里自己定的 + 手机系统的）
```

---

## 2. 构建与发布

```bash
python3 src/build.py          # 生成 site/index.html、site/sw.js、site/manifest.webmanifest
bash tests/runall.sh 2        # 网页测试跑两遍（见第 7 节）
```

发布（用户在 iPhone 上操作）：
1. 如果有新的 SQL，先在 Supabase 运行：<https://supabase.com/dashboard/project/uaoiqbxptnbrvkzjwguc/sql/new>
2. 把 `site/` 里的网页文件（`index.html`、`sw.js`、`manifest.webmanifest`、几个图标）放到 `main` 分支根目录。用户已决定由 Claude 直接推送，不再手动上传。如果要手动上传，就用 <https://github.com/3855285335-gif/index.html/upload/main>，**只提交一次**。然后等“操作”（Actions）页面变绿。
3. 手机上把 App 彻底关掉、再打开，GitHub Pages 本身有几分钟的缓存，可能要多开一两次。进“我”看版本号确认。
4. 两个人的手机都要换成新版，新旧版本混用可能互相收不到通话信号。

注意：GitHub Pages 同时有两个部署时可能卡住。每次只提交一次，等变绿后再做下一次。

---

## 3. 后端（Supabase）

- 项目：`uaoiqbxptnbrvkzjwguc`，网址 `https://uaoiqbxptnbrvkzjwguc.supabase.co`
- 网页里用的是**可发布密钥**（`sb_publishable_…`，本来就是公开的）。**秘密密钥绝不能放进网页或任何仓库。**
- 登录：账号转成假邮箱 `账号@chatter.local`。控制台里关掉了“Confirm email”（邮件确认），否则会碰到发信频率限制。
- 主要的表：`profiles`、`friend_requests`、`friendships`、`messages`、`conversations`（服务器维护未读数和预览）、`signals`（通话信号信箱）、`presence`（在线状态）、`app_config`（中转服务器配置）、`keepalive_state`、`stickers`（我的表情，只能看 / 改 / 删自己的，每人最多 500 个）。全部开启 RLS。新加的表不建任何策略，网页端只能通过 `security definer` 函数访问，函数只授权给登录用户。
- 存储：桶 `chat-media`，公开读，单个文件上限 50MB（Supabase 免费版允许的最大值；运行 `5-setup-v6.sql` 之前是 20MB）。每个人只能往自己的文件夹（`账号/`）上传，也只能列出、删除自己文件夹里的文件。文件名：普通消息 `时间戳_随机.扩展名`，头像 `avatar_…`，表情 `sticker_…`。
- 消息类型：`text`、`image`、`voice`、`call`、`recalled`，3.8 起加了 `sticker`（内容是 `e:emoji`、`t:文字贴纸编号` 或自己表情的地址）、`video`（地址，`dur` 是时长秒数）、`file`（`{"u":地址,"n":文件名,"s":字节数}`，数据库会检查格式）。
- 实时：每个用户一个私有广播频道 `u:账号`，用于秒到消息、通话信号、正在输入、已读、在线推送；另外订阅数据库变更（postgres_changes）和 Presence。
- **SQL 运行顺序**：`1-setup` → `2-setup-v3` → `3-setup-v5` → `4-setup-keepalive` → `5-setup-v6` → `6-setup-v7` → `7-setup-v8`。网页启动时调用 `chatter_schema()`（6 / 7 / 8）判断后端到了哪一版：没运行时对应功能给出提示，其他照常；运行之后回到页面就能用，不用刷新。线上项目实际运行过哪些，以用户确认为准：保活函数肯定运行过（定时任务成功过一次）；发布 build 3.6 时要运行最新的 `3-setup-v5.sql`（含 ExpressTURN）。所有脚本都可以重复运行，不确定时再跑一遍也没关系。

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
- 3.8 起删掉了“中转测试”按钮（用户要求）。“我 → 环境诊断”里仍然显示中转服务器列表和来源（数据库 / 内置）。

### 5.5 来电 / 消息提醒（build 4.0）

- **App 开着**：别的聊天来消息、有人加好友，屏幕顶部滑下横幅（点一下进聊天，往上划收起）；正开着的聊天、免打扰的聊天、正看着消息列表时不弹。
- **App 在后台但还没被系统关掉**（主要是安卓、电脑）：页面自己弹系统通知。已经开了推送的手机不再自己弹，免得一条弹两次。
- **App 完全关掉**：Web Push 推送。流程：
  1. 用户在“我 → 📳 通知”点“开启通知”（必须是点击里直接请求权限，iPhone 的要求）→ 浏览器给出这台手机的推送地址 → `push_save()` 存进 `push_subs`。
  2. 发消息成功、打电话、没接通就挂断、发好友请求时，**发送方**的网页请求 `chatter-push` 函数（带自己的登录凭证）。连发几条只请求最后一次（1.2 秒内合并，切到后台时立刻发出）；对方显示在线时不请求。
  3. 函数用登录凭证查出发送方，调用数据库 `push_job()`：必须是好友、对方不在线（75 秒内没报到）、消息真的是这个人 3 分钟内发的、同一条只推一次；算出标题（有备注用备注）、内容（引用回复只留回复的话；可以设成不显示内容）、未读总数。
  4. 函数用 WebCrypto 自己加密（RFC 8291）和签名（RFC 8292），只发给苹果 / 谷歌 / 火狐 / 微软的推送服务；推送服务说地址失效（404 / 410）就删掉。
  5. 手机上的 `sw.js` 弹通知：同一个人的消息互相替换（显示“[3条] …”）；来电通知一直留着，没接通会被替换成“未接来电”；点通知打开对应聊天（`#c=账号`、`#call=账号` 会马上取一次来电信号、`#req`）。
- 函数不需要任何手动设置的密钥：签名密钥第一次运行时自动生成，存在 `push_keys`（网页读不到）；访问数据库用 Supabase 自动提供给函数的 `SUPABASE_SECRET_KEYS`（旧项目回退到 `SUPABASE_SERVICE_ROLE_KEY`）。部署时保持默认的 JWT 校验（verify_jwt）打开。
- **限制**：iPhone 要 iOS 16.4 以上，而且必须从主屏幕图标打开 Chatter 才能开启（[WebKit 官方博客](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)）；iOS 16.4–18 要靠 manifest 里的 `display: standalone` 才算“网页 App”，所以 4.0 起 `main` 上放了单独的 `manifest.webmanifest`。安卓 Chrome 的网页推送走谷歌 FCM，国内网络一般收不到（未真机验证）。
- **额度**：Supabase 免费版每月 50 万次函数调用，浏览器的预检请求（OPTIONS）不算（[官方文档](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations)）。只有对方不在线时才调用，两个人用远远用不完。

### 额度（2026-11-05 在官网重新核实过，完整清单见 `docs/限制清单.md`）
| 服务 | 免费额度 | 来源 |
|---|---|---|
| ExpressTURN | 每月 1000GB；免费版只支持 3478 端口的 UDP/TCP | <https://expressturn.com/> |
| Metered | 方案名就叫 “Free: 500 MB trial”，每月 500MB（上传加下载合计）；超出后会怎样官网没写 | <https://metered.ca/pricing> |
| Supabase | 数据库 500MB、文件存储 1GB、流量每月 5GB（另有 5GB 缓存流量）、单个文件最大 50MB、7 天不活跃暂停、没有自动备份 | <https://supabase.com/pricing> |

---

## 6. 功能清单（build 4.0）

- **账号**：注册 / 登录，修改昵称、头像、密码。
- **好友**：搜索、请求、通过、删除，在线状态。
- **消息**：文字（网址可以点）、图片（原图不压缩，看大图可以左右滑、可以保存）、视频（原文件不压缩）、文件（任何类型，点开预览）、按住说话的语音。图片 / 视频 / 文件单个 ≤50MB，一次最多 9 个。
- **表情包**：表情面板三页——😀 表情（316 个 emoji，插到文字里）、🎭 表情库（最近使用、40 个自己画的文字贴纸、大表情）、⭐ 我的（从相册添加原图 / GIF，长按设关键词、移到最前、删除，最多 500 个）。顶部搜索框按关键词搜全部表情；输入框里打的字刚好是关键词时，上方冒出联想表情（像微信）。聊天里点对方的表情、长按图片都能“添加到表情”。
- **消息操作**：长按菜单（回复引用、复制、转发、添加到表情、保存到手机、2 分钟内撤回、删除仅自己）、正在输入、已读回执、草稿、搜索聊天记录、清空聊天记录、删除会话、会话置顶、消息免打扰（后几项只在本机生效）。
- **视频 / 语音通话**：见第 5 节。
- **存储空间**：查看和清理自己发过的图片、语音、视频、文件（对方也会看不到；头像和“我的表情”里正在用的表情不会被清理）。
- **好友备注 / 资料页**（3.9）：备注只有自己看得到，存在数据库里；资料页可以发消息、打电话、设备注、删好友（先确认）。
- **上传进度、存储快满提醒、导出聊天记录**（3.9）。
- **来电 / 消息提醒**（4.0）：见第 5.5 节。
- **国内模式**：见第 4 节；后台时标题闪烁提醒；发送失败后自动重发；本地缓存实现秒开；诊断页自动刷新。
- **没有做的**：群聊、忘记密码后自己找回、消息表情回应、编辑已发消息。

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
| relaytest / prtest / defaulttest | 中转配置来自数据库、省流量默认关、在线状态即时推送、内置默认的服务器列表 |
| metab | “我”页面：设置里只剩音效 / 存储空间 / 中转省流量；中转测试已删除，页面上没有 VPN 字样 |
| stktest | 表情面板、表情库、搜索、我的表情（上传原图、关键词、置顶、删除）、联想表情、添加到表情、发视频 / 文件、保存到手机（含 iPhone 分享面板）、转发、链接、置顶 / 免打扰、存储清理不删正在用的表情、快速通道丢弃格式不对的内容 |
| animcheck | 屏幕正中的弹窗（长按菜单、“⋯”菜单等）逐帧检查：动画全程左右都在正中，不会先偏到右下再跳回来 |
| nov6test | 还没运行 `5-setup-v6.sql` 时：文字图片照常、20MB 上限、表情 / 视频 / 文件给提示；运行后不用刷新就能用 |
| authnet / audiotest / vposter / ordertest | 连不上服务器时提示说对原因；通话声音只走一个出口；视频封面；手机时间不准时的消息顺序 |
| v39test | 好友备注（数据库 / 本机兜底 / 自动同步）、资料页、上传进度、存储快满提醒、导出聊天记录 |
| notiftest | 顶部横幅（什么时候弹、什么时候不弹、点了去哪）、后台系统通知、开启 / 关闭 / 不显示内容、发消息 / 打电话 / 未接来电 / 加好友时请求推送、点通知打开聊天、后台小助手收到推送弹通知、各种开不了的情况（没运行 SQL、函数没部署、iPhone 没加主屏幕、拒绝过权限、连不上推送服务） |
| push/fn-node.mjs / fn-deno.ts | 推送函数：加密用 web-push 官方的 http_ece 库解开、VAPID 签名验证、只发正规推送服务、失效地址清理、旧版密钥兼容；Deno 里原样运行函数文件 |
| configcheck / icecheck / pptest | 网页内置的中转列表和两份 SQL 完全一致、除主力外没有 UDP、STUN 列表；浏览器接受全部服务器地址；依赖库加载 |

目前每遍是 27 组网页测试，加 1 组国内网络下的在线状态测试，最后再跑 5 项检查。`runall.sh 2` 一共 2×28+5 = 61 项。

### SQL
```bash
bash tests/sql/run-sql-tests.sh   # 需要本机 PostgreSQL 16（initdb / pg_ctl / psql）
```
`stub.sql` 模拟 Supabase 的 auth、storage、realtime，`seed.sql` 建三个测试账号（alice、bob 互为好友，carol 是外人），然后真实运行全部 SQL 和权限测试（每份运行两次，确认可以重复运行）。输出里的 `ERROR: permission denied`、`not friends` 都是预期被拒绝的情况。`guard-tests.sh` 检查选错项目时 v6 / v7 / v8 什么都不改。

### 测试覆盖不到的（必须真机）
模拟环境全部通过，**不代表在用户的手机和网络上一定没问题**。下面这些只能真机测：
- iPhone Safari 和主屏幕 App 里的表现：摄像头、麦克风、长按、键盘、缓存更新。
- 真实国内网络下的消息延迟、来电、在线状态。
- 推送：真的弹出来（iPhone 锁屏 / 通知中心、角标）、点通知打开聊天、安卓在国内能不能收到。无头浏览器连不上谷歌的推送服务，测试里用的是假的推送登记；加密和签名用官方库交叉验证过，但没有真的发到苹果 / 谷歌。
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
- **3.7**：“中转测试”从“设置”挪到“环境诊断”里。
- **3.8**：删掉“中转测试”；表情包（表情库、我的表情、搜索、联想）、发视频、发文件、保存到手机、转发、网址可点、会话置顶 / 免打扰、emoji 从 22 个扩到 316 个（需要 `5-setup-v6.sql`）。
- **3.8.1**：修好长按菜单等屏幕正中的弹窗“先在右边闪一下再跑到中间”（弹出动画盖掉了居中位移；这个问题从有长按菜单起就存在）。
- **3.8.2**：连不上服务器时提示说对原因（不再误报“密码错误”“请先执行 setup.sql”）。
- **3.8.3**：通话声音加固、视频封面、手机时间不准时的消息顺序和卡顿、会话预览兜底。
- **3.9**：好友备注、好友资料页、上传进度、存储快满提醒、导出聊天记录（需要 `6-setup-v7.sql`）。
- **4.0**：来电 / 消息提醒——顶部横幅、后台系统通知、App 关掉后的推送（需要 `7-setup-v8.sql` 和 `chatter-push` 函数）；`main` 上加了 `sw.js`（只管通知）、`manifest.webmanifest` 和图标文件。
- **3.6**：中转服务器配置放进数据库（ExpressTURN 主力、Metered 备用且只留 TLS 443）、中转测试、“中转省流量”开关（默认关）、在线状态变化即时推送、页面关闭时报离线、STUN 按真机实测核对。
