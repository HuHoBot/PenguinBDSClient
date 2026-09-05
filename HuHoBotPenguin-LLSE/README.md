# HuHoBotPenguin — LeviLamina (LLSE Node.js 后端)

QQ 开放平台官方机器人（WebSocket 接入）与 Minecraft 基岩版服务器之间的聊天 / 命令桥接插件。由 Java Spigot 版 HuHoBotPenguin 移植而来，功能平级。

## 工作原理

- **QQ → 游戏**：群内 @机器人 发出的消息（官方 `GROUP_AT_MESSAGE_CREATE` 事件）→ 命令分发 / 全量转发到游戏。
- **游戏 → QQ**：以 `chat-format.start-with`（默认 `#`）开头的游戏聊天 → 处理后发送到所有已配置的群。
- **命令执行**：`mc.runcmdEx` 同步执行 BDS 控制台命令并捕获输出，替代 Spigot 版的延迟捕获。

## 为什么要求 LSE 的 Node.js 后端

LLSE 自带的 `WSClient` 底层 `lightwebsocketclient` 不支持 TLS，无法连接 QQ 官方 `wss://` 网关。本插件通过 `lse-nodejs` 后端嵌入完整的 Node 运行时，用内置 `tls`/`net`/`crypto` 自实现最小 RFC6455 WebSocket 客户端，**零 npm 依赖**；REST 走内置 `https`。

## 部署

1. **安装 LSE Node 引擎**（LeviLamina 服上）：`lip install github.com/LiteLDev/LegacyScriptEngine`，并确认 `plugins/legacy-script-engine-nodejs/` 存在（本插件 manifest 依赖名为 `legacy-script-engine-nodejs`，若装了 Lua/QuickJS 后端会报依赖缺失）。
2. **拷贝插件**：把整个目录内容复制到服务器 `plugins/HuHoBotPenguin-LLSE/`（`manifest.json` 的 `type: lse-nodejs` 会指定走 Node 后端）。
3. **QQ 开放平台配置**：
   - 机器人创建后，接入方式选择 **WebSocket**（事件订阅：群聊/私聊事件）。
   - 在“开发设置”里拿到 **AppID** 与 **AppSecret**。
   - 若开启了 IP 白名单，把 BDS 服务器的公网出口 IP 加入白名单（否则网关连接会被拒）。
4. **填配置**：编辑 `plugins/HuHoBotPenguin-LLSE/config.json`，填入 `bot.app-id`、`bot.secret`，并把目标群 OpenID 填进 `bot.groups`（为空 = 所有群都可触发）。
5. **重启服务器**，控制台应依次出现：
   - `HuHoBot Penguin 已加载`
   - `正在获取 access_token…`
   - `环境：正式，后端 …` → `QQ 机器人已连接（session_id=…）`

> 注意：本版本固定连接**正式环境**（api.bot.qq.com），机器人需**提审上线**后才会在正式网关收到群事件。未上线调试请使用开发版（支持沙箱网关）或先在开放平台完成提审。

## 配置说明

| 配置 | 默认 | 说明 |
|---|---|---|
| `bot.app-id` / `bot.secret` | 空 | QQ 开放平台凭据，必填 |
| `bot.name` | HuHoBot | 机器人显示名（“在线服务器”命令回复用） |
| `serverName` | 空 | 进服/退服通知前缀 `{server}`；留空回退 `bot.name` |
| `bot.groups` | `[]` | 允许的群 OpenID 列表；空 = 所有群 |
| `chat-format.from-game` | `[游戏] {name}: {message}` | 游戏 → 群的格式（`{name}` 玩家名） |
| `chat-format.from-group` | `[QQ] {name}: {message}` | 群 → 游戏的格式（非命令转发时用） |
| `chat-format.post-chat` | `true` | 群内非命令消息是否广播进游戏（需配合全量转发） |
| `chat-format.start-with` | `#` | 游戏聊天触发前缀；**留空 = 所有游戏聊天都转发** |
| `whitelist.add-command` / `del-command` | whitelist add/remove {name} | 白名单命令模板 |
| `filter-regex` | `[]` | 正则过滤列表（JS 正则语法，命中整词替换为 `*`） |
| `admin.mode` | `both` | 管理员判定：`qq`（仅群主/管理员）、`manual`（仅手动添加）、`both`（任一即可） |
| `admin.openids` | `[]` | 全局手动管理员 OpenID（不受群管理方式约束） |
| `features.full-amount` | `false` | 全量转发默认值（可用“全量”命令按群覆盖） |
| `features.markdown-query-online` | `true` | “查在线”用自定义 Markdown 卡片展示（`msg_type=2`，官方已向所有机器人开放）；解析失败/发送失败自动回退纯文本 |
| `features.markdown-whitelist` | `true` | “查白名单”用自定义 Markdown 卡片展示（解析 `allowlist list` 的 JSON 输出）；失败自动回退纯文本 |
| `features.online-tps` | `true` | “查在线”输出附带实时 TPS / MSPT 统计（插件自行测量，`onTick` 不可用时自动隐藏） |
| `command-panel.<命令名>` | `true` | 单独开关某个内置命令**是否展示在 QQ 指令面板**（命令本身照常可用；彻底关闭命令用 `commands.<命令名>`） |
| `motd.ip` | 空 | 服务器公网地址（IP 或域名），填写后“查在线”卡片顶部显示 MOTD 状态图（motd.minebbs.com 需能连通该地址）；留空不显示 |
| `motd.port` | `19132` | 服务器端口（BDS 默认 19132） |
| `motd.use-markdown` | `true` | **Markdown 消息总开关**（对齐 Java 版）：`false` 时“查在线/查白名单/motd 命令”全部回退纯文本 |
| `motd.api` | `https://motd.minebbs.com/api/status_img?ip={ip}&port={port}` | MOTD 状态图 URL 模板（`{ip}`/`{port}` 替换，自动追加时间戳防缓存） |
| `motd.text` | `当前在线：{online} 人\n{players}` | 查在线纯文本模板（`{online}` 人数、`{players}` 玩家列表、`{server}` 服务器名） |
| `join-leave.enabled` | `true` | 进服/退服通知开关 |
| `join-leave.join-format` / `leave-format` | `[{server}] 🟢/🔴…` | 进/退服群通知模板；`{server}`=`serverName`（回退 `bot.name`）、`{name}`=玩家名 |
| `audit.base-url` / `audit.api-key` / `audit.model` | 空 / gpt-4o-mini | OpenAI 兼容二次审核端点；配齐后命中本地敏感词才调用 |
| `custom-commands` | `[]` | 自定义命令，见下节 |
| `commands.<命令名>` | `true` | 单独开关某个内置命令 |
| `debug.probe` | `false` | 开启后启动时打印环境/TLS 出口探针 |

敏感词：代码内置默认词 + `plugins/HuHoBotPenguin-LLSE/sensitive-words/*.txt`（每行一词，`#` 开头为注释，UTF-8）。

## 自定义查在线的 Markdown 输出

首次运行后在插件目录自动生成 `Markdown/online.md`，**可自由编辑**以定制“查在线”Markdown 卡片（对齐 Java 版；覆盖内置默认模板，改完 `huhobot reload` 生效）。

```markdown
# {{.server}} 在线玩家

![服务器状态 #480px #270px]({{.img_url}})

当前在线：**{{.online_num}}** 人

TPS：{{.tps}}（MSPT {{.mspt}}）

{{.player}}
```

| 占位符 | 说明 |
|---|---|
| `{{.server}}` | 服务器名（`serverName`，回退 `bot.name`） |
| `{{.img_url}}` | MOTD 状态图 URL（`motd.api` 模板，自动加时间戳防缓存） |
| `{{.online_num}}` | 在线人数 |
| `{{.tps}}` | TPS 状态（如 `🟢 20.0`）；统计不可用时自动移除所在行 |
| `{{.mspt}}` | MSPT（如 `53ms / 峰值 80ms`） |
| `{{.player}}` | 玩家列表（`1. **名字**` 换行格式） |

## 控制台命令

服务器控制台（或 BDS 后台）输入：

| 命令 | 说明 |
|---|---|
| `huhobot reload` | 重新读取 `config.json` 并重启 QQ 机器人网关，**无需重启服务器** |
| `huhobot info` | 查看平台、插件版本与运行模式 |

> 说明：`reload` 会先停掉旧机器人连接再按新配置重建；若改的是 `bot.app-id` / `bot.secret` 等连接凭据，`reload` 同样生效。

## LuckyClover 插件联动（游戏聊天桥接接口）

当服务器装有 LuckyClover（头衔/聊天美化）且开启 `chatFormatMode: override` 时，聊天展示由 LuckyClover 接管。本插件导出跨插件接口供其调用，沿用原本 LuckyClover→bot 的 `ll.imports(namespace, functionName)` 机制：

- 导出：`ll.exports(fn, "HuHoBotPenguin", "send")` —— 即 `ll.imports("HuHoBotPenguin", "send")`。
- 签名：`send(玩家名, 原始消息)`。内部**不会绕开 `#` 筛选**：先按 `chat-format.start-with`（默认 `#`）判断 → `auditText` 过滤 → `chat-format.from-game` 格式化 → 推送目标群。
- 与插件自带的 `onChat` 转发共用 **1.5s 去重**，同一条消息不会被双发。
- LuckyClover 配置：`chatBridge.namespace` 改为 `"HuHoBotPenguin"`，`functionName` 保持 `"send"`；建议把原第三方 bot 插件（如 `sb3_LuckyCloverMC2QQ`）从服务器移除，避免同命名冲突。

## 内置命令（20 个）

群内 @机器人 + 命令即可。标注 ⭐ 需管理员（按 `admin.mode` 判定）。

| 命令 | 说明 |
|---|---|
| `查信息` | 无参：本群 OpenID / 本人 OpenID / 角色 / 认证状态；带参 ⭐：查看指定 OpenID 认证状态 |
| `发信息 <内容>` | 过滤后广播进游戏（`[QQ] …`） |
| `发消息 <内容>` | `发信息` 的同义词 |
| `查在线` | 执行 `list` 返回在线玩家 + 实时 TPS / MSPT（默认 Markdown 卡片展示，可配置关闭） |
| `在线服务器` | 返回机器人名 + 在线状态 |
| `motd <地址[:端口]>` | 查询任意 Minecraft 服务器状态（motd.minebbs.com，支持基岩/Java，在线时 Markdown 卡片 + 状态图展示） |
| `执行 <key>` | 执行自定义命令（仅 `permission: 0` 的命令） |
| `执行命令 <命令>` ⭐ | 以管理员身份直接在服务器控制台执行任意命令 |
| `管理员执行 <key>` ⭐ | 执行任意权限的自定义命令 |
| `查管理` | 列出本群手动管理员 |
| `加管理 <OpenID>` ⭐ | 添加本群手动管理员 |
| `删管理 <OpenID>` ⭐ | 移除本群手动管理员 |
| `管理方式 <QQ/手动/双重>` ⭐ | 设置本群管理员判定方式 |
| `添加白名单 <玩家名>` ⭐ | 执行 `whitelist.add-command` 模板 |
| `删除白名单 <玩家名>` ⭐ | 执行 `whitelist.del-command` 模板 |
| `查白名单` | 执行 `allowlist list` 返回白名单玩家（默认 Markdown 卡片展示；BDS 1.21+，旧版需在源码改回 `whitelist list`） |
| `绑定白名单 <玩家名>` | 自助：把本人 QQ 与该游戏名绑定并加入白名单（绑定记录存 `bindings`） |
| `解除绑定` | 自助：解除本人绑定并移出白名单 |
| `解绑白名单 <玩家名>` ⭐ | 管理员：按游戏名反查绑定并解除，同时移出白名单（用于成员退群后手动解绑） |
| `认证` | 无参：本人认证状态；带参 ⭐：认证指定 OpenID（取最后一个词） |
| `解除认证 [<OpenID>]` | 无参：解除本人；带参 ⭐：解除指定 OpenID |
| `全量 <开/关>` ⭐ | 设置本群全量转发开关 |
| `已加载插件` | 列出已注册元数据的附属插件（名称/版本/描述/作者） |

## 自定义命令

```json
"custom-commands": [
  { "key": "服务器状态", "command": "mem", "permission": 0 },
  { "key": "踢人", "command": "kick {1} 你已被管理员移除", "permission": 1 }
]
```

- `permission: 0`：普通成员用 `执行 <key>`；`permission > 0`：仅 `管理员执行 <key>`。
- 占位符：`{params}` 全部参数、`{group}` 群 OpenID、`{user}` 用户 OpenID、`{0}/{1}...` 第 N 个参数、`&0/&1...` 同义。
- 命令为 BDS 控制台命令字符串，支持空格与参数展开。

## 测试（黄金路径）

1. 重启后确认 控制台 `QQ 机器人已连接`。
2. 目标群内 @机器人 发送 `查信息` → 回复本群 OpenID、本人 OpenID。
3. `认证` → 回复本人认证状态；群主/管理员 `加管理 <OpenID>` → `plugins/HuHoBotPenguin-LLSE/command-state.json` 落盘。
4. `执行 list` → 回复在线玩家。
5. 游戏内发送 `#测试消息` → 群收到 `[游戏] 测试消息`；群内 `发信息 hello` → 游戏内广播 `[QQ] <OpenID>: hello`。
6. 群内 `全量 开` 后发送普通（非命令）@消息 → 游戏内出现 `[QQ] …` 广播。
7. 断网/重启网关 → 控制台应自动重连（Resume 或重新 Identify）。

## 故障排查

- **连接后立刻关闭 / 4014**：Identify 的 `intents` 只订阅了群聊事件；若机器人能力未开通群聊或未切 WebSocket，会在后台拒绝。检查平台“开发设置 → 接入方式 → WebSocket 与事件订阅”。
- **能连接但收不到任何群事件（最常见）**：机器人**未提审上线**，正式网关不会推送事件。① 在开放平台完成机器人提审上线；② 确认机器人已被群主“添加到群聊”；③ 群设置里“机器人主动在群聊内发言”已开启。三者缺一都收不到。
- **加入了“扫码聊天/第三方 Agent”，群内开了“机器人可获取的群聊消息范围 = 获取群内全部消息”但仍收不到**：开启全量后，群里**每一条消息（包括 @ 消息）都以 `GROUP_MESSAGE_CREATE` 全量事件推送**，不再是 `GROUP_AT_MESSAGE_CREATE`。代码需同时处理该事件（`lib/qqclient.js` 已内置）。若此时仍零事件，检查机器人资料卡是否已被群主“添加到群聊”、群设置的“机器人主动在群聊内发言”是否开启。
- **回复报错 11273 / 鉴权失败**：发消息 `Authorization` 头必须是 `QQBot <token>`（不是 `Bearer`）。代码已按要求实现。
- **连不上网关**：`debug.probe: true` 打开看 TLS 出口；检查 IP 白名单。
- **日志没有 access_token 获取记录**：确认 `bot.app-id`/`bot.secret` 已填写且 `plugins/HuHoBotPenguin-LLSE/config.json` 是当前读取的那份。

## 已知限制

- 群消息事件有两类：默认仅推 @ 机器人的消息（`GROUP_AT_MESSAGE_CREATE`）；若群主在机器人资料卡开启了“获取群内全部消息”，则群里每条消息（含 @）都以 `GROUP_MESSAGE_CREATE` 全量事件推送，本插件两种都处理。仅收到 @ 事件时，“全量转发”只会转发 @ 且非命令的消息。
- 游戏 → 群方向不能改原消息，只做转发（与 Spigot 端一致）。
- 灵感移植自 Java 版，`motd.*`、`command-sender` 等死配置已丢弃。

## 附属插件开发

两种开发方式：**addons 目录**（推荐，简单直接）与 **ll.imports 跨插件接口**（适合需要独立插件结构的场景）。

### 方式一：addons 目录（推荐）

主插件启动时自动扫描 `plugins/HuHoBotPenguin-LLSE/addons/`（Llama 版为 `-LLSE-Llama/addons/`）目录并加载附属插件，直接传入 API 上下文——**无需 manifest 依赖声明，没有加载顺序问题**（`features.load-addons` 默认开）。改代码后 `huhobot reload` 立即生效。

目录结构（子目录或单 .js 文件均可）：

```text
plugins/HuHoBotPenguin-LLSE/
└── addons/
    └── demo-addon/
        ├── index.js     入口：module.exports = function (addon) { ... }
        └── addon.json   可选元数据 { name, version, description, author }
```

```js
// addons/demo-addon/index.js
module.exports = (addon) => {
    addon.logger.info('已加载');          // 自动带 [demo-addon] 前缀
    addon.onReady(({ version }) => {});
    addon.onRecvMsg((msg, event) => {});  // 可 event.setCancelled()
    addon.onPrivateMsg((msg, event) => {});
    addon.onJoinRequest((msg, event) => {});
    addon.registerBotCommand('demo', 'say hi {user}', 0, true);
    addon.registerRegexCommand('^点歌\\s+(.+)，供其他 LLSE 插件通过 `ll.imports("HuHoBotPenguin", "<函数名>")` 调用。API 实例为全局单例，`huhobot reload` 后已持有的引用不失效。

| 导出函数 | 说明 |
|---|---|
| `onRecvMsg(fn)` | 监听所有 QQ 消息（在公共命令处理前触发），返回监听器 id；fn 签名 `(msgPack, event)` |
| `offRecvMsg(id)` | 注销消息监听 |
| `onBotCommand(fn)` | 监听运行时命令命中（`msgPack.commandKey` / `commandArguments` 已填充），返回监听器 id |
| `offBotCommand(id)` | 注销命令监听 |
| `registerBotCommand(key, command, permission, pushMenu)` | 注册运行时自定义命令（`permission > 0` 仅管理员触发）；`pushMenu=true` 时同步到 QQ 官方群聊指令面板 |
| `unregisterBotCommand(key)` | 注销运行时命令 |
| `getAuthenticatedQq(groupOpenId, openId)` | 查询认证状态；官方机器人拿不到真实 QQ 号，已认证返回 OpenID，未认证返回 `null` |
| `getBindingName(groupOpenId, openId)` | 查询白名单绑定游戏名（LLSE 版扩展），无绑定返回 `null` |
| `sendGroupText(groupOpenId, text[, msgId])` | 向指定群发文本 |
| `sendGroupMarkdown(groupOpenId, markdown[, msgId])` | 向指定群发 Markdown（msg_type=2） |
| `sendAllGroupsText(text)` | 向所有配置群发文本 |
| `sendAllGroupsMarkdown(markdown)` | 向所有配置群发 Markdown |
| `onReady(fn)` | 网关就绪（READY）时触发，fn({version}) |
| `onPrivateMsg(fn)` | 监听用户单聊消息（C2C_MESSAGE_CREATE），pack 含 `userOpenId`/`content`；`event.replyText` 走单聊被动回复 |
| `onJoinRequest(fn)` | 监听入群申请（GROUP_JOIN_REQUEST，机器人需群管理员），pack 含 `memberOpenid`/`username`/`joinRequestId`/`verifyMessage` |
| `registerRegexCommand(pattern, flags, handler)` | 注册正则命令：未命中内置/运行时命令的消息按注册顺序匹配，handler(pack, match, event)，`setCancelled` 取消默认处理；返回 id |
| `unregisterRegexCommand(id)` | 注销正则命令 |
| `getVersion()` / `getGroups()` | 插件版本 / 配置的群列表 |
| `isAdmin(groupOpenId, openId)` | 是否管理员（基于 admin.openids 配置 + 手动管理员；群 QQ 管理员角色仅消息上下文可知） |
| `getBotInfo()` | 获取机器人信息（Promise：{id, username, avatar}，GET /users/@me） |
| `sendPrivateText(userOpenId, text[, msgId])` | 发送单聊文本消息 |
| `muteMember(groupOpenId, memberOpenid, durationSeconds)` / `unmuteMember(groupOpenId, memberOpenid)` | 群成员禁言 / 解除（Promise，机器人需群管理员，最长 30 天） |
| `getJoinRequests(groupOpenId[, cursor, limit])` / `approveJoinRequest(groupOpenId, memberOpenid, options)` | 入群申请列表 / 审批（Promise；options：{approve, joinRequestId, rejectReason, addToBlacklist}） |
| `registerAddon(name, version, description, author)` | 注册附属插件元数据（WebUI「附属插件」页与「已加载插件」指令展示用；重复调用覆盖更新） |
| `unregisterAddon(name)` | 注销附属插件元数据 |
| `getAddons()` | 已注册附属插件列表（数组） |

`msgPack` 为不可变消息快照：`messageId`、`groupOpenId`、`sender{id,username,memberRole}`、`content`、`rawContent`、`timestamp`、`commandKey?`、`commandArguments?`、`mentions[]`、`attachments[]`。

`event` 控制器：

- `event.replyText(text)` / `event.replyMarkdown(md)` → 被动回复触发消息，返回是否已提交
- `event.setCancelled()` → 取消事件，阻止后续默认处理（内置命令执行 / 命令模板执行 / 全量转发）
- `event.isCancelled()` → 查询取消状态

示例（附属插件内）：

```js
const onRecvMsg = ll.imports('HuHoBotPenguin', 'onRecvMsg');
const registerBotCommand = ll.imports('HuHoBotPenguin', 'registerBotCommand');
const sendGroupText = ll.imports('HuHoBotPenguin', 'sendGroupText');

// 过滤/审计所有群消息
onRecvMsg((msg, event) => {
    if (msg.content.includes('广告')) {
        event.replyText('请勿发送广告');
        event.setCancelled(); // 阻止内置命令/全量转发等默认处理
    }
});

// 注册运行时命令：群里发"签到" → 触发 onBotCommand 监听，未取消则执行 score add
registerBotCommand('签到', 'score add {user} 10', 0, false);

// 主动向某群推送
sendGroupText('<群OpenID>', '[公告] 服务器即将重启');
```

处理顺序：`OnBotRecvMsg`（可取消）→ 内置命令 → 运行时命令 `OnBotCommand`（可取消，未取消执行模板）→ 正则命令（可取消）→ 全量转发。Node 后端单线程运行，监听器内不要执行长时间阻塞操作。被动回复自动携带递增 `msg_seq`（同一 `msg_id` 群聊最多回复 5 次、单聊 4 次，超出会被官方去重拦截）。

- **指令面板同步**：启动时把开启的内置命令与附属插件注册的命令（pushMenu）自动同步到 QQ 官方群聊指令面板（`features.push-menu`，默认开；`commands.<名>` 关闭的命令不同步）

**指令面板同步（pushMenu）**：QQ 客户端同一场景只展示一个面板，本插件只维护一个 group 面板（跨重启按 remark 找回复用，`panel_id` 持久化在 `command-state.json`）。附属插件 `pushMenu=true` 的命令优先，内置命令按定义顺序填充剩余位置；上限 20 个命令、命令名截断到 14 字符、`permission > 0` 映射为"仅管理员可点"。首次创建时绑定 `bot.groups` 配置的群（未配群则全局生效）；旧版多面板格式会在启动时自动迁移并删除多余面板。内置命令可用 `command-panel.<命令名>: false` 单独从面板隐藏（命令本身仍可用）。

## License

[MIT](LICENSE) © 2026 HuHoBot。本插件由 [HuHoBot/PenguinClient](https://github.com/HuHoBot/PenguinClient)（Java 版）移植而来。



, '', (msg, match, event) => {
        event.replyText('收到：' + match[1]);
    });
    addon.sendGroupText('<群OpenID>', '[公告] …');
    addon.muteMember('<群OpenID>', '<成员OpenID>', 600); // Promise
    addon.onUnload(() => {});             // reload/卸载时自动调用
};
```

`addon` 上下文包含全部开放 API（与下表同名，另加 `logger` / `onUnload`）。**注册即记录**：插件卸载或 `huhobot reload` 时自动注销其监听器、命令、正则与元数据，无需手动清理。

### 方式二：ll.imports 跨插件接口（高级）

供独立 LLSE 插件结构使用（有自己的 manifest.json）。注意：附属插件可能先于主插件加载，`ll.imports` 需自行重试等待主插件注册。

### 指令面板同步

附属插件 `registerBotCommand(..., pushMenu=true)` 的命令会同步到 QQ 指令面板；`registerAddon` 注册的元数据会显示在 WebUI「附属插件」页与群指令「已加载插件」中。


---

## 附属插件 API（开放接口）

对齐 Java 版适配器公共 API，供其他 LLSE 插件通过 `ll.imports("HuHoBotPenguin", "<函数名>")` 调用。API 实例为全局单例，`huhobot reload` 后已持有的引用不失效。

| 导出函数 | 说明 |
|---|---|
| `onRecvMsg(fn)` | 监听所有 QQ 消息（在公共命令处理前触发），返回监听器 id；fn 签名 `(msgPack, event)` |
| `offRecvMsg(id)` | 注销消息监听 |
| `onBotCommand(fn)` | 监听运行时命令命中（`msgPack.commandKey` / `commandArguments` 已填充），返回监听器 id |
| `offBotCommand(id)` | 注销命令监听 |
| `registerBotCommand(key, command, permission, pushMenu)` | 注册运行时自定义命令（`permission > 0` 仅管理员触发）；`pushMenu=true` 时同步到 QQ 官方群聊指令面板 |
| `unregisterBotCommand(key)` | 注销运行时命令 |
| `getAuthenticatedQq(groupOpenId, openId)` | 查询认证状态；官方机器人拿不到真实 QQ 号，已认证返回 OpenID，未认证返回 `null` |
| `getBindingName(groupOpenId, openId)` | 查询白名单绑定游戏名（LLSE 版扩展），无绑定返回 `null` |
| `sendGroupText(groupOpenId, text[, msgId])` | 向指定群发文本 |
| `sendGroupMarkdown(groupOpenId, markdown[, msgId])` | 向指定群发 Markdown（msg_type=2） |
| `sendAllGroupsText(text)` | 向所有配置群发文本 |
| `sendAllGroupsMarkdown(markdown)` | 向所有配置群发 Markdown |
| `onReady(fn)` | 网关就绪（READY）时触发，fn({version}) |
| `onPrivateMsg(fn)` | 监听用户单聊消息（C2C_MESSAGE_CREATE），pack 含 `userOpenId`/`content`；`event.replyText` 走单聊被动回复 |
| `onJoinRequest(fn)` | 监听入群申请（GROUP_JOIN_REQUEST，机器人需群管理员），pack 含 `memberOpenid`/`username`/`joinRequestId`/`verifyMessage` |
| `registerRegexCommand(pattern, flags, handler)` | 注册正则命令：未命中内置/运行时命令的消息按注册顺序匹配，handler(pack, match, event)，`setCancelled` 取消默认处理；返回 id |
| `unregisterRegexCommand(id)` | 注销正则命令 |
| `getVersion()` / `getGroups()` | 插件版本 / 配置的群列表 |
| `isAdmin(groupOpenId, openId)` | 是否管理员（基于 admin.openids 配置 + 手动管理员；群 QQ 管理员角色仅消息上下文可知） |
| `getBotInfo()` | 获取机器人信息（Promise：{id, username, avatar}，GET /users/@me） |
| `sendPrivateText(userOpenId, text[, msgId])` | 发送单聊文本消息 |
| `muteMember(groupOpenId, memberOpenid, durationSeconds)` / `unmuteMember(groupOpenId, memberOpenid)` | 群成员禁言 / 解除（Promise，机器人需群管理员，最长 30 天） |
| `getJoinRequests(groupOpenId[, cursor, limit])` / `approveJoinRequest(groupOpenId, memberOpenid, options)` | 入群申请列表 / 审批（Promise；options：{approve, joinRequestId, rejectReason, addToBlacklist}） |
| `registerAddon(name, version, description, author)` | 注册附属插件元数据（WebUI「附属插件」页与「已加载插件」指令展示用；重复调用覆盖更新） |
| `unregisterAddon(name)` | 注销附属插件元数据 |
| `getAddons()` | 已注册附属插件列表（数组） |

`msgPack` 为不可变消息快照：`messageId`、`groupOpenId`、`sender{id,username,memberRole}`、`content`、`rawContent`、`timestamp`、`commandKey?`、`commandArguments?`、`mentions[]`、`attachments[]`。

`event` 控制器：

- `event.replyText(text)` / `event.replyMarkdown(md)` → 被动回复触发消息，返回是否已提交
- `event.setCancelled()` → 取消事件，阻止后续默认处理（内置命令执行 / 命令模板执行 / 全量转发）
- `event.isCancelled()` → 查询取消状态

示例（附属插件内）：

```js
const onRecvMsg = ll.imports('HuHoBotPenguin', 'onRecvMsg');
const registerBotCommand = ll.imports('HuHoBotPenguin', 'registerBotCommand');
const sendGroupText = ll.imports('HuHoBotPenguin', 'sendGroupText');

// 过滤/审计所有群消息
onRecvMsg((msg, event) => {
    if (msg.content.includes('广告')) {
        event.replyText('请勿发送广告');
        event.setCancelled(); // 阻止内置命令/全量转发等默认处理
    }
});

// 注册运行时命令：群里发"签到" → 触发 onBotCommand 监听，未取消则执行 score add
registerBotCommand('签到', 'score add {user} 10', 0, false);

// 主动向某群推送
sendGroupText('<群OpenID>', '[公告] 服务器即将重启');
```

处理顺序：`OnBotRecvMsg`（可取消）→ 内置命令 → 运行时命令 `OnBotCommand`（可取消，未取消执行模板）→ 正则命令（可取消）→ 全量转发。Node 后端单线程运行，监听器内不要执行长时间阻塞操作。被动回复自动携带递增 `msg_seq`（同一 `msg_id` 群聊最多回复 5 次、单聊 4 次，超出会被官方去重拦截）。

- **指令面板同步**：启动时把开启的内置命令与附属插件注册的命令（pushMenu）自动同步到 QQ 官方群聊指令面板（`features.push-menu`，默认开；`commands.<名>` 关闭的命令不同步）

**指令面板同步（pushMenu）**：QQ 客户端同一场景只展示一个面板，本插件只维护一个 group 面板（跨重启按 remark 找回复用，`panel_id` 持久化在 `command-state.json`）。附属插件 `pushMenu=true` 的命令优先，内置命令按定义顺序填充剩余位置；上限 20 个命令、命令名截断到 14 字符、`permission > 0` 映射为"仅管理员可点"。首次创建时绑定 `bot.groups` 配置的群（未配群则全局生效）；旧版多面板格式会在启动时自动迁移并删除多余面板。内置命令可用 `command-panel.<命令名>: false` 单独从面板隐藏（命令本身仍可用）。

## License

[MIT](LICENSE) © 2026 HuHoBot。本插件由 [HuHoBot/PenguinClient](https://github.com/HuHoBot/PenguinClient)（Java 版）移植而来。



