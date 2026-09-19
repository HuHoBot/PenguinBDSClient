# HuHoBotPenguin v1.6.0

> 附属插件新增撤回、机器人进出群、键盘互动等官方接口；修复互动回复 event_id。附属插件开发者推荐更新。

## 🔌 附属插件新 API

对照 [QQ 机器人官方文档](https://bot.q.qq.com/wiki/develop/api-v2/) 补齐：

### 撤回消息

```js
// 2 分钟内可撤；管理员可撤他人消息
addon.recallGroupMessage(groupOpenId, messageId);   // Promise
addon.recallPrivateMessage(userOpenId, messageId);  // 仅机器人自己的消息
```

### 状态事件

| 事件 | API |
|---|---|
| 机器人加入群 `GROUP_ADD_ROBOT` | `onBotJoinGroup` / `offBotJoinGroup` |
| 机器人退出群 `GROUP_DEL_ROBOT` | `onBotLeaveGroup` / `offBotLeaveGroup` |
| 资料页通知开关 `GROUP_MSG_RECEIVE`/`REJECT` | `onGroupNotifySwitch` / `offGroupNotifySwitch` |

说明：`GROUP_MSG_RECEIVE`/`REJECT` 官方文档有（Intent `1<<25`），**实测 QQ 往往不往 WebSocket 推送**；接口保留作兼容。资料卡「允许机器人主动发言」是 `INTERACTION` type 18/19，不是本事件。

### 键盘按钮与互动

- 发送带按钮消息：`sendGroupKeyboard(groupOpenId, content, keyboard[, msgId, opts])`
- 按钮/菜单回调：`onInteraction` / `offInteraction`（订阅 Intent `INTERACTION 1<<26`）
- type=11/12 默认自动 `PUT /interactions` 应答（`features.auto-ack-interaction`，默认开）
- 可手动：`ackInteraction(interactionId[, code])`

```js
addon.onInteraction((pack, event) => {
  if (pack.buttonData === 'api:ping') event.replyText('pong');
});
```

### 其他

- 事件被动回复优先 `event_id`（含 `INTERACTION_CREATE:` 完整 id）；被拒（40034025）自动回退主动消息
- 群成员加入/退出事件 pack 补充 `eventId`
- `registerAddon` 默认版本、5 参 `registerBotCommand` 等为 1.4.0 已有，本版无变更

## ⬆️ 升级

1. 下载对应版本 zip，替换 `plugins/` 下插件目录内容
2. 重启服务器（或 `huhobot reload`）
3. 配置自动迁移：新增 `features.auto-ack-interaction`（默认 `true`），无需手动改动

**完整变更**: https://github.com/HuHoBot/PenguinBDSClient/compare/v1.5.0...v1.6.0
