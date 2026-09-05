# HuHoBotPenguin-Llama — LeviLamina (LLSE Node.js 后端)

QQ 开放平台官方机器人与 Minecraft 基岩版服务器之间的聊天 / 命令桥接插件，**内置 LLM AI 助理**（OpenAI 兼容接口，无需额外部署 AstrBot）。由 [HuHoBot/PenguinClient](https://github.com/HuHoBot/PenguinClient)（Java 版）移植。

> 本版名为 **Llama**（代指大模型），是在普通版 `HuHoBotPenguin-LLSE` 基础上额外集成 AI 对话能力。不需要 AI 请用普通版。

## AI 能力（相比普通版新增）

- **群内 AI 对话**：未命中命令的普通消息 → 发给配置的 LLM → 回复回群，**多轮上下文**（按群保留最近 N 条，重启不丢）
- **AI 工具调用（function calling）**：AI 可自动调用内置工具：`查询在线玩家` / `查询白名单` / `执行命令`（高危仅 `ai.admin-openids`）
- **自定义 Skill（🧩）**：在 WebUI 定义自己的 AI 技能，AI 调用后执行你配置的控制台命令（见下文）
- **零额外依赖**：内置 HTTP/HTTPS 客户端，零 npm 依赖

## 核心配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `ai.enabled` | `false` | AI 总开关；`false` 时行为与普通版完全一致 |
| `ai.base-url` | 空 | OpenAI 兼容接口地址，如 `https://api.openai.com/v1` 或本地 `http://127.0.0.1:11434/v1`（Ollama） |
| `ai.api-key` | 空 | API 密钥（本地无鉴权可留空） |
| `ai.model` | `gpt-4o-mini` | 模型名（需支持 function calling，如 DeepSeek / Qwen / GPT 系列） |
| `ai.system-prompt` | 服务器管理助理 | 系统提示词（插件会自动附加工具使用引导） |
| `ai.context-limit` | `10` | 每群保留最近 N 条上下文 |
| `ai.admin-openids` | `[]` | **AI 执行控制台命令 / 管理员 Skill 的 OpenID 白名单**（高危，配你的 QQ OpenID） |
| `ai.skills` | `[]` | 自定义 Skill 列表（见下文，也可在 WebUI 配置） |
| `ai.max-tokens` / `ai.temperature` / `ai.timeout` | 1000 / 0.7 / 15000 | 采样与超时参数 |
| `admin.mode` / `admin.openids` | `both` / `[]` | 群命令管理员判定（与 AI 执行命令用的 `ai.admin-openids` 不同） |

## AI 使用示例

```json
"ai": {
  "enabled": true,
  "base-url": "https://api.openai.com/v1",
  "api-key": "sk-xxx",
  "model": "gpt-4o-mini",
  "context-limit": 10,
  "admin-openids": ["你的QQOpenID"]
}
```

群内 @机器人 说"查在线""现在谁在玩""查一下白名单"等，AI 自动调用对应工具；要 AI 执行控制台命令（如 `执行命令 list`），需把**你的 QQ OpenID 填进 `ai.admin-openids`**。

## 自定义 Skill

在 WebUI「🧩 Skill 管理」页，或直接改 `ai.skills` 配置，定义 AI 可调用的自定义技能：

```json
"ai": { "skills": [
  { "key": "server_status", "name": "服务器状态", "desc": "查看服务器内存/性能", "command": "mem", "permission": 0 },
  { "key": "kick", "name": "踢出玩家", "desc": "将玩家踢出服务器", "command": "kick {0} 你被移除了", "permission": 1 }
]}
```

| 字段 | 说明 |
|---|---|
| `key` | Skill 名（AI 工具名，唯一，自动注册为 `skill__<key>`） |
| `name` | 显示名（可选） |
| `desc` | 给 AI 看的描述，说明这个技能做什么 |
| `command` | 控制台命令模板；`{0}`/`{1}`/`{params}` 为参数占位符（由 AI 按顺序提供），支持 `{group}`/`{user}` |
| `permission` | `0` 所有人可调；`1` 仅 `ai.admin-openids` 管理员可调 |

示例：定义 `kick`（`kick {0} 你被移除了`）后，群里说"把 Steve 踢了"，AI 会调用 `skill__kick` 执行 `kick Steve 你被移除了`（`permission:1` 时还需你的 OpenID 在 `ai.admin-openids`）。

## WebUI 管理面板

开启后访问 `http://127.0.0.1:8088`：**深色侧边栏 + 多页面**管理后台，无需改配置文件或进服。

| 配置 | 默认 | 说明 |
|---|---|---|
| `webui.enabled` | `false` | 是否启用 WebUI（Node http，lse-nodejs 可用） |
| `webui.host` | `127.0.0.1` | 监听地址：`127.0.0.1`=仅本机访问；`0.0.0.0`=监听所有网卡，**外网可访问**（务必配 `webui.password`） |
| `webui.port` | `8088` | 监听端口 |
| `webui.username` / `webui.password` | `admin` / 空 | 登录凭据；**不填密码则无登录校验**（仅本机可安全访问） |

页面功能：
- **📈 总览**：配置版本、可用工具数、快捷开关（AI / Markdown 一键切换）
- **🛠️ AI 工具**：展示 AI 可用工具与权限
- **🧩 Skill 管理**：增删改自定义 Skill（key/名称/权限/描述/命令模板），保存自动生效
- **💬 AI 对话**：发消息测试 AI（支持工具调用）
- **⚙️ 配置**：分组表单编辑全部配置，**保存后自动热重载生效**
- 移动端自动折叠为汉堡菜单

> 仅绑定 `127.0.0.1`；如需外网访问，请在宿主机/反向代理层自行加登录保护。

## 其余功能（同普通版）

- **双向转发**：游戏 `#消息` ↔ QQ 群；20+ 群指令（查在线/白名单/管理员/认证等）
- **📋 Markdown 卡片**：查在线 / 查白名单 / `motd` 命令（`motd.use-markdown` 总开关）
- **⚡ TPS / MSPT 统计**：“查在线”附带实时性能数据（`features.online-tps`，默认开）
- **MOTD 状态图 + 自定义模板**：`Markdown/online.md` 可编辑、`motd.api`/`motd.text` 模板
- **敏感词审核**：正则 + 本地词库 + OpenAI 二审
- **控制台命令**：`huhobot reload` / `huhobot info`

## 部署

1. 安装 LSE Node 引擎：`lip install github.com/LiteLDev/LegacyScriptEngine`
2. 放入 `plugins/HuHoBotPenguin-LLSE-Llama/`
3. 填 `bot.app-id` / `bot.secret`；AI 版额外填 `ai.*`
4. 重启服务器 → 控制台 `QQ 机器人已连接`

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
| `getBindingName(groupOpenId, openId)` | 查询白名单绑定游戏名，无绑定返回 `null` |
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

`msgPack` 为不可变消息快照：`messageId`、`groupOpenId`、`sender{id,username,memberRole}`、`content`、`rawContent`、`timestamp`、`commandKey?`、`commandArguments?`、`mentions[]`、`attachments[]`。

`event` 控制器：

- `event.replyText(text)` / `event.replyMarkdown(md)` → 被动回复触发消息，返回是否已提交
- `event.setCancelled()` → 取消事件，阻止后续默认处理（内置命令执行 / 命令模板执行 / 全量转发 / AI 回复）
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
        event.setCancelled(); // 阻止内置命令/全量转发/AI 等默认处理
    }
});

// 注册运行时命令：群里发"签到" → 触发 onBotCommand 监听，未取消则执行 score add
registerBotCommand('签到', 'score add {user} 10', 0, false);

// 主动向某群推送
sendGroupText('<群OpenID>', '[公告] 服务器即将重启');
```

处理顺序：`OnBotRecvMsg`（可取消）→ 内置命令 → 运行时命令 `OnBotCommand`（可取消，未取消执行模板）→ 正则命令（可取消）→ 全量转发 → AI Agent。Node 后端单线程运行，监听器内不要执行长时间阻塞操作。被动回复自动携带递增 `msg_seq`（同一 `msg_id` 群聊最多回复 5 次、单聊 4 次，超出会被官方去重拦截）。

- **指令面板同步**：启动时把开启的内置命令与附属插件注册的命令（pushMenu）自动同步到 QQ 官方群聊指令面板（`features.push-menu`，默认开；`commands.<名>` 关闭的命令不同步）

**指令面板同步（pushMenu）**：QQ 客户端同一场景只展示一个面板，本插件只维护一个 group 面板（跨重启按 remark 找回复用，`panel_id` 持久化在 `command-state.json`）。附属插件 `pushMenu=true` 的命令优先，内置命令按定义顺序填充剩余位置；上限 20 个命令、命令名截断到 14 字符、`permission > 0` 映射为"仅管理员可点"。首次创建时绑定 `bot.groups` 配置的群（未配群则全局生效）；旧版多面板格式会在启动时自动迁移并删除多余面板。内置命令可用 `command-panel.<命令名>: false` 单独从面板隐藏（命令本身仍可用）。

## License

[MIT](LICENSE) © 2026 HuHoBot
