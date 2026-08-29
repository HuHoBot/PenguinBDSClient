# HuHoBotPenguin — LeviLamina (LLSE Node.js)

📌 **本项目由 [HuHoBot/PenguinClient](https://github.com/HuHoBot/PenguinClient)（Java 版）移植**，为 LeviLamina（LLSE Node.js 后端）下的 Minecraft 基岩版（BDS）服务器提供 **QQ 开放平台官方机器人**接入插件。

该仓库包含两个版本，按需二选一部署到 `plugins/` 下：

| 目录 | 版本 | 说明 |
|---|---|---|
| [`HuHoBotPenguin-LLSE/`](./HuHoBotPenguin-LLSE/README.md) | **标准版** | QQ ↔ BDS 双向转发、20+ 群指令、MOTD 状态图、Markdown 卡片 |
| [`HuHoBotPenguin-LLSE-Llama/`](./HuHoBotPenguin-LLSE-Llama/README.md) | **AI 版（Llama）** | 标准版全部功能 + 内置 LLM AI 助理（无需 AstrBot）、function calling 工具、自定义 Skill、WebUI 管理面板 |

> 不需要 AI 请使用标准版；想要 AI 对话 / 管理面板请用 AI 版。

## 共同功能

- **游戏 ↔ QQ 双向转发**：游戏内 `#消息` ↔ QQ 群；群指令系统（查在线 / 白名单 / 管理员 / 认证等 20+ 命令）
- **📋 Markdown 卡片**：查在线 / 查白名单 / `motd` 命令（`motd.use-markdown` 总开关）
- **⚡ TPS / MSPT 统计**：查在线附带实时性能数据（插件自行测量）
- **🖼️ MOTD 状态图 + 可编辑模板**：`Markdown/online.md`、`motd.api` / `motd.text` 模板
- **🛡️ 敏感词审核**：正则 + 本地词库 + 可选 OpenAI 兼容二审
- **🎛️ 控制台命令**：`huhobot reload` / `huhobot info`
- **🔌 附属插件 API**：对齐 Java 版适配器公共 API（事件监听 / 运行时命令 / 认证查询 / 群发送），供其他 LLSE 插件扩展
- **零 npm 依赖**：自实现 WebSocket / HTTP(S)，零依赖

## AI 版（Llama）专属

- **AI 对话**：内置 LLM（OpenAI 兼容，支持 Ollama/DeepSeek/Qwen/GPT），多轮上下文
- **function calling 工具**：AI 自动调用查在线 / 查白名单 / 执行命令
- **自定义 Skill**：WebUI 定义 AI 技能执行控制台命令（含 LegacyMoney / 踢人 / 封禁预设）
- **WebUI 管理面板**：深色侧边栏多页面（状态 / 工具 / Skill / AI 对话 / 配置）

详见各自 `README.md`。

## 安装

1. 安装 LSE Node 引擎：`lip install github.com/LiteLDev/LegacyScriptEngine`
2. 解压对应版本的 zip 到 `plugins/<版本目录>/`（如 `plugins/HuHoBotPenguin-LLSE/` 或 `plugins/HuHoBotPenguin-LLSE-Llama/`）
3. 填 `config.json`（`bot.app-id` / `bot.secret`；首次启动自动生成）
4. 重启服务器 → 控制台 `QQ 机器人已连接`

## License

[MIT](LICENSE) © 2026 HuHoBot
