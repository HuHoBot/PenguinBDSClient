# 配置说明

配置文件：`plugins/HuHoBotPenguin-LLSE/config.json`（AI 版为 `HuHoBotPenguin-LLSE-Llama`）。
首次启动自动生成并补全缺失项；`config-version` 升级时自动迁移。

## 基础

| 配置 | 默认 | 说明 |
|---|---|---|
| `bot.app-id` / `bot.secret` | 空 | QQ 开放平台凭据，**必填** |
| `bot.name` | HuHoBot | 机器人显示名（"在线服务器"命令回复用） |
| `bot.groups` | `[]` | 允许的群 OpenID 列表；**空 = 所有群**。注意：游戏→群的转发只发给这里配置的群 |
| `serverName` | 空 | 进服/退服通知前缀 `{server}`；留空回退 `bot.name` |

## 聊天格式

| 配置 | 默认 | 说明 |
|---|---|---|
| `chat-format.from-game` | `[游戏] {name}: {message}` | 游戏 → 群的格式 |
| `chat-format.from-group` | `[QQ] {name}: {message}` | 群 → 游戏的格式（非命令转发时用） |
| `chat-format.post-chat` | `true` | 群内非命令消息是否广播进游戏（需配合全量转发） |
| `chat-format.start-with` | `#` | 游戏聊天触发前缀；**留空 = 所有游戏聊天都转发** |

## 管理员

| 配置 | 默认 | 说明 |
|---|---|---|
| `admin.mode` | `both` | 管理员判定：`qq`（仅群主/群管理员）、`manual`（仅手动添加）、`both`（任一即可） |
| `admin.openids` | `[]` | 全局手动管理员 OpenID（不受群管理方式约束） |

每群的管理方式可用 `管理方式 <QQ/手动/双重>` 命令单独覆盖（存 `command-state.json`）。

## 白名单

| 配置 | 默认 | 说明 |
|---|---|---|
| `whitelist.add-command` | `whitelist add {name}` | 添加白名单命令模板 |
| `whitelist.del-command` | `whitelist remove {name}` | 移除白名单命令模板 |

## 功能开关

| 配置 | 默认 | 说明 |
|---|---|---|
| `features.full-amount` | `false` | 全量转发默认值（可用 `全量` 命令按群覆盖） |
| `features.markdown-query-online` | `true` | "查在线"用自定义 Markdown 卡片展示（`msg_type=2`）；失败自动回退纯文本 |
| `features.markdown-whitelist` | `true` | "查白名单"用自定义 Markdown 卡片展示；失败自动回退纯文本 |
| `features.online-tps` | `true` | "查在线"输出附带实时 TPS / MSPT 统计（插件自行测量，`onTick` 不可用时自动隐藏） |
| `features.push-menu` | `true` | 启动时把内置命令与附属插件命令同步到 QQ 官方群聊指令面板，详见[指令面板](panel.md) |
| `command-panel.<命令名>` | `true` | 单独开关某个内置命令**是否展示在指令面板**（命令本身照常可用；彻底关闭命令用 `commands.<命令名>`） |

## MOTD / 查在线

| 配置 | 默认 | 说明 |
|---|---|---|
| `motd.ip` | 空 | 服务器公网地址，填写后"查在线"卡片顶部显示 MOTD 状态图；留空不显示 |
| `motd.port` | `19132` | 服务器端口（BDS 默认） |
| `motd.use-markdown` | `true` | **Markdown 消息总开关**：`false` 时"查在线/查白名单/motd"全部回退纯文本 |
| `motd.api` | `https://motd.minebbs.com/api/status_img?ip={ip}&port={port}` | 状态图 URL 模板 |
| `motd.text` | `当前在线：{online} 人\n{players}` | 查在线纯文本模板（`{online}`/`{players}`/`{server}`） |

## 进服 / 退服通知

| 配置 | 默认 | 说明 |
|---|---|---|
| `join-leave.enabled` | `true` | 通知开关 |
| `join-leave.join-format` | `[{server}] 🟢{name}进入服务器` | 进服模板 |
| `join-leave.leave-format` | `[{server}] 🔴{name}退出服务器` | 退服模板 |

占位符：`{server}` = `serverName`（回退 `bot.name`）、`{name}` = 玩家名。

## 查在线 Markdown 模板

首次运行后在插件目录生成 `Markdown/online.md`，**可自由编辑**（改完 `huhobot reload` 生效）：

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
| `{{.img_url}}` | MOTD 状态图 URL（自动加时间戳防缓存） |
| `{{.online_num}}` | 在线人数 |
| `{{.tps}}` | TPS 状态（如 `🟢 20.0`）；统计不可用时自动移除所在行 |
| `{{.mspt}}` | MSPT（如 `53ms / 峰值 80ms`） |
| `{{.player}}` | 玩家列表（`1. **名字**` 换行格式） |

## 敏感词审核

| 配置 | 默认 | 说明 |
|---|---|---|
| `filter-regex` | `[]` | 正则过滤列表（JS 正则语法，命中整词替换为 `*`） |
| `audit.base-url` / `audit.api-key` / `audit.model` | 空 / gpt-4o-mini | OpenAI 兼容二次审核端点；配齐后命中本地敏感词才调用 |

敏感词来源：代码内置默认词 + `plugins/HuHoBotPenguin-LLSE/sensitive-words/*.txt`（每行一词，`#` 开头为注释，UTF-8）。

## 命令开关与自定义命令

| 配置 | 默认 | 说明 |
|---|---|---|
| `commands.<命令名>` | `true` | 单独开关某个内置命令 |
| `custom-commands` | `[]` | 自定义命令，见[群指令](commands.md) |

## 调试

| 配置 | 默认 | 说明 |
|---|---|---|
| `debug.probe` | `false` | 启动时打印环境 / TLS 出口探针 |
| `debug.log-events` | `false` | 输出网关事件与消息收发日志 |

## AI 版（Llama）专属

`ai.*` 与 `webui.*` 配置见 [AI 版（Llama）](ai.md)。
