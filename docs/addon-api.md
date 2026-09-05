# 附属插件 API（开放接口）

对齐 Java 版适配器公共 API，供其他 LLSE 插件通过 `ll.imports("HuHoBotPenguin", "<函数名>")` 调用。

- API 实例为 `process` 级单例：`huhobot reload` 后已持有的引用不失效，`send` 桥接导出会自动路由到当前实例
- 所有 Promise 返回值需 `await` 或 `.then()` 处理
- Node 后端单线程运行，监听器内不要执行长时间阻塞操作

## 事件监听

| 函数 | 说明 |
|---|---|
| `onRecvMsg(fn)` | 监听所有 QQ 群消息（在公共命令处理前触发），返回监听器 id；fn 签名 `(msgPack, event)` |
| `offRecvMsg(id)` | 注销消息监听 |
| `onBotCommand(fn)` | 监听运行时命令命中（`msgPack.commandKey` / `commandArguments` 已填充），返回监听器 id |
| `offBotCommand(id)` | 注销命令监听 |
| `onReady(fn)` | 网关就绪（READY）时触发，fn(`{version}`) |
| `offReady(id)` | 注销就绪监听 |
| `onPrivateMsg(fn)` | 监听用户单聊消息（`C2C_MESSAGE_CREATE`），pack 含 `userOpenId` / `content`；`event.replyText` 自动走单聊被动回复 |
| `offPrivateMsg(id)` | 注销单聊监听 |
| `onJoinRequest(fn)` | 监听入群申请（`GROUP_JOIN_REQUEST`，机器人需群管理员），pack 含 `memberOpenid` / `username` / `joinRequestId` / `verifyMessage` |
| `offJoinRequest(id)` | 注销入群申请监听 |

## 命令注册

| 函数 | 说明 |
|---|---|
| `registerBotCommand(key, command, permission, pushMenu)` | 注册运行时自定义命令（`permission > 0` 仅管理员触发）；`pushMenu=true` 时同步到 QQ 指令面板 |
| `unregisterBotCommand(key)` | 注销运行时命令 |
| `registerRegexCommand(pattern, flags, handler)` | 注册正则命令：未命中内置/运行时命令的消息按注册顺序匹配；handler 签名 `(msgPack, match, event)`，`setCancelled` 取消默认处理；返回 id |
| `unregisterRegexCommand(id)` | 注销正则命令 |

命令模板占位符与自定义命令一致：`{params}`、`{group}`、`{user}`、`{0}/{1}...`、`&1/&2...`。

## 查询

| 函数 | 说明 |
|---|---|
| `getAuthenticatedQq(groupOpenId, openId)` | 查询认证状态；官方机器人拿不到真实 QQ 号，已认证返回 OpenID，未认证返回 `null` |
| `getBindingName(groupOpenId, openId)` | 查询白名单绑定游戏名，无绑定返回 `null` |
| `isAdmin(groupOpenId, openId)` | 是否管理员（基于 `admin.openids` 配置 + 手动管理员；群 QQ 管理员角色仅消息上下文可知） |
| `getVersion()` / `getGroups()` | 插件版本 / 配置的群列表 |
| `getBotInfo()` | 机器人信息（Promise：`{id, username, avatar}`，`GET /users/@me`） |

## 消息发送

| 函数 | 说明 |
|---|---|
| `sendGroupText(groupOpenId, text[, msgId])` | 向指定群发文本 |
| `sendGroupMarkdown(groupOpenId, markdown[, msgId])` | 向指定群发 Markdown（msg_type=2） |
| `sendAllGroupsText(text)` | 向所有配置群发文本 |
| `sendAllGroupsMarkdown(markdown)` | 向所有配置群发 Markdown |
| `sendPrivateText(userOpenId, text[, msgId])` | 发送单聊文本消息（主动消息有频控与每日上限） |

## 群管理（机器人需群管理员身份）

| 函数 | 说明 |
|---|---|
| `muteMember(groupOpenId, memberOpenid, durationSeconds)` | 禁言群成员（Promise；最长 30 天） |
| `unmuteMember(groupOpenId, memberOpenid)` | 解除禁言（Promise） |
| `getJoinRequests(groupOpenId[, cursor, limit])` | 拉取入群申请列表（Promise：`{list, next_cursor}`） |
| `approveJoinRequest(groupOpenId, memberOpenid, options)` | 审批入群申请（Promise；options：`{approve, joinRequestId, rejectReason, addToBlacklist}`） |

## MsgPack 快照

`msgPack` 为不可变消息快照：

| 字段 | 说明 |
|---|---|
| `messageId` | QQ 消息 ID（被动回复用） |
| `groupOpenId` | 群 OpenID（单聊场景为空） |
| `sender` | `{id, username, memberRole}` |
| `content` / `rawContent` | 处理后文本 / 原始文本 |
| `timestamp` | 消息时间戳 |
| `commandKey` / `commandArguments` | 命中运行时命令时填充 |
| `regexMatches` | 命中正则命令时的捕获组数组 |
| `mentions[]` / `attachments[]` | 官方群事件不含，恒为空数组 |

## event 控制器

- `event.replyText(text)` / `event.replyMarkdown(md)` → 被动回复触发消息（群消息走群回复，单聊走单聊回复），返回是否已提交
- `event.setCancelled()` → 取消事件，阻止后续默认处理
- `event.isCancelled()` → 查询取消状态

## 示例

```js
const onRecvMsg = ll.imports('HuHoBotPenguin', 'onRecvMsg');
const registerBotCommand = ll.imports('HuHoBotPenguin', 'registerBotCommand');
const registerRegexCommand = ll.imports('HuHoBotPenguin', 'registerRegexCommand');
const sendGroupText = ll.imports('HuHoBotPenguin', 'sendGroupText');
const muteMember = ll.imports('HuHoBotPenguin', 'muteMember');

// 过滤/审计所有群消息
onRecvMsg((msg, event) => {
    if (msg.content.includes('广告')) {
        event.replyText('请勿发送广告');
        event.setCancelled(); // 阻止内置命令/全量转发等默认处理
    }
});

// 注册运行时命令：群里发"签到" → 触发 onBotCommand 监听，未取消则执行 score add
registerBotCommand('签到', 'score add {user} 10', 0, true);

// 注册正则命令：消息匹配正则时触发
registerRegexCommand('^点歌\\s+(.+)$', '', (msg, match, event) => {
    event.replyText('收到点歌请求：' + match[1]);
});

// 主动推送
sendGroupText('<群OpenID>', '[公告] 服务器即将重启');

// 群管理（异步）
muteMember('<群OpenID>', '<成员OpenID>', 600).then(
    () => logger.info('禁言成功'),
    (e) => logger.error('禁言失败: ' + e.message)
);
```

## 消息处理顺序

```
OnBotRecvMsg（可取消）
  → 内置命令
  → 运行时命令 OnBotCommand（可取消，未取消执行命令模板）
  → 正则命令（可取消）
  → 全量转发（AI 版还有 AI Agent）
```

!!! note "msg_seq"
    被动回复自动携带递增 `msg_seq`：同一 `msg_id` 群聊最多回复 **5 次**、单聊 **4 次**，超出会被官方去重拦截。这是官方限制。
