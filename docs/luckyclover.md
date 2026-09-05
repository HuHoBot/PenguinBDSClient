# LuckyClover 联动

当服务器装有 **LuckyClover**（头衔 / 聊天美化插件）且开启 `chatFormatMode: override` 时，游戏内聊天展示由 LuckyClover 接管。此时插件自带的 `onChat` 监听拿不到美化后的消息，需要走跨插件桥接接口。

## 桥接接口

本插件导出跨插件接口供 LuckyClover 调用，沿用 `ll.imports(namespace, functionName)` 机制：

- 导出：`ll.exports(fn, "HuHoBotPenguin", "send")`，即 `ll.imports("HuHoBotPenguin", "send")`
- 签名：`send(玩家名, 原始消息)`
- 内部**不会绕开 `#` 筛选**：先按 `chat-format.start-with`（默认 `#`）判断 → `auditText` 过滤 → `chat-format.from-game` 格式化 → 推送目标群
- 与插件自带的 `onChat` 转发共用 **1.5s 去重**，同一条消息不会被双发

## LuckyClover 配置

```yaml
chatBridge:
  namespace: "HuHoBotPenguin"
  functionName: "send"
```

!!! tip
    建议把原第三方 bot 插件（如 `sb3_LuckyCloverMC2QQ`）从服务器移除，避免命名冲突。
