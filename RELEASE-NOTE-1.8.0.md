# HuHoBotPenguin v1.8.0

> 修复热重载生命周期、安全边界和配置解析问题，提升 Llama AI、WebUI 与附属插件中心的稳定性。推荐更新。

## 🔄 热重载稳定性

- 修复旧版引擎 `onConsoleCmd` 监听器在多次 reload 后重复注册的问题
- 跨脚本上下文复用控制台命令注册，避免热重载后命令叠加
- Llama Agent 纳入运行时停止流程
- reload 时取消旧 AI 请求、清理 AI 队列和延迟写盘定时器
- 防止旧实例在新实例启动后继续回复消息或覆盖 AI 上下文

## 🔒 安全修复

- 限制附属插件卸载路径，阻止通过目录穿越删除 `addons/` 外部文件
- WebUI 增加请求体大小限制
- WebUI 增加登录失败限流、过期 Session 清理和 `SameSite` Cookie
- WebUI 校验跨站请求来源
- 插件中心限制 ZIP 包大小、解压后大小和文件数量，降低压缩包攻击风险

## 🧠 AI 与配置优化

- 修复字符串形式的 `false` 配置被误解析为 `true`
- 同一群组的 AI 请求改为串行处理，避免上下文乱序或相互覆盖
- AI 上下文写盘增加节流，减少高频同步 I/O
- WebUI 端口占用时采用指数退避并限制自动重试次数

## ⬆️ 升级

1. 下载对应版本 zip，替换 `plugins/` 下的插件目录内容
2. 重启服务器，或执行 `huhobot reload`
3. 现有配置、群状态、绑定信息和 AI 上下文文件无需迁移

**完整变更**: [v1.7.0...v1.8.0](https://github.com/HuHoBot/PenguinBDSClient/compare/v1.7.0...v1.8.0)
