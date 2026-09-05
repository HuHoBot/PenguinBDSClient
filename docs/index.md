# HuHoBotPenguin

将 **QQ 开放平台官方机器人**（WebSocket 接入）接入 **Minecraft 基岩版服务器**（BDS + LeviLamina / LLSE Node.js 后端）：游戏聊天与 QQ 群双向转发、白名单管理、在线查询、命令执行、敏感词审核、QQ 指令面板同步、附属插件开放 API。

由 [HuHoBot/PenguinClient](https://github.com/HuHoBot/PenguinClient)（Java Spigot 版）移植而来，功能平级。

## 两个版本

| 版本 | 目录 | 说明 |
|---|---|---|
| **标准版** | [`HuHoBotPenguin-LLSE/`](https://github.com/HuHoBot/PenguinBDSClient/tree/main/HuHoBotPenguin-LLSE) | QQ ↔ BDS 双向转发、20+ 群指令、MOTD 状态图、Markdown 卡片、TPS/MSPT 统计、指令面板、附属插件 API |
| **AI 版（Llama）** | [`HuHoBotPenguin-LLSE-Llama/`](https://github.com/HuHoBot/PenguinBDSClient/tree/main/HuHoBotPenguin-LLSE-Llama) | 标准版全部功能 + 内置 LLM AI 助理（OpenAI 兼容接口）、function calling 工具、自定义 Skill、WebUI 管理面板 |

> 不需要 AI 用标准版；想要 AI 对话 / 管理面板用 AI 版。

## 核心特性

- **双向聊天转发**：游戏内 `#消息` ↔ QQ 群，格式模板可自定义
- **群指令系统**：查在线（含实时 TPS/MSPT）、白名单绑定、管理员、认证等 20+ 命令
- **📋 Markdown 卡片**：查在线 / 查白名单 / `motd` 命令，模板可自由编辑
- **🖼️ MOTD 状态图**：`motd.minebbs.com` 状态图嵌入查在线卡片
- **🛡️ 敏感词审核**：本地正则词库 + 可选 OpenAI 兼容接口 AI 二审
- **QQ 官方指令面板**：内置命令 + 附属插件命令自动同步到群指令面板
- **🔌 附属插件 API**：对齐 Java 版适配器公共 API，其他 LLSE 插件可监听消息、注册命令、调用群管理能力
- **零 npm 依赖**：自实现 RFC6455 WebSocket / HTTP(S) 客户端

## 快速导航

- [安装部署](quickstart.md)
- [配置说明](config.md)
- [群指令列表](commands.md)
- [QQ 指令面板](panel.md)
- [附属插件 API（开放接口）](addon-api.md)
- [AI 版功能](ai.md)
- [LuckyClover 联动](luckyclover.md)
- [故障排查](troubleshooting.md)

## License

[MIT](https://github.com/HuHoBot/PenguinBDSClient/blob/main/HuHoBotPenguin-LLSE/LICENSE) © 2026 HuHoBot
