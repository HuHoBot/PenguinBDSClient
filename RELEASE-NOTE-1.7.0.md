# HuHoBotPenguin v1.7.0

> 新增 QR 扫码绑定机器人：控制台打印二维码、WebUI 快速开始引导页，手机 QQ 扫一次即可写入凭据。首次配置不再需要手动编辑 config.json。

## 📱 QR 扫码绑定

手机 QQ 扫码自动写入 `bot.app-id` / `bot.secret` 并热重载，无需手动编辑配置文件。

### 控制台

```
huhobot qr        # 生成二维码（控制台打印字符画 + 生成 qr-login.svg）
huhobot qrcancel  # 取消进行中的扫码会话
```

- 启动时若凭据为空，自动触发扫码（`bot.auto-qr` 默认 `true`）
- 二维码过期自动刷新
- 终端使用半块字符（▀▄█）渲染，高度紧凑适配 BDS 控制台

### WebUI 快速开始页（Llama 版）

登录后自动检测凭据状态：

- **未配置** → 进入快速开始引导页，支持两种方式：
  - 📱 扫码绑定：生成二维码，手机 QQ 扫码
  - ✏️ 手动填写：直接输入 AppID + Secret
- **已配置** → 正常进入主界面

### 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `bot.auto-qr` | `true` | 启动时若凭据为空，自动打印二维码引导绑定 |

## ⬆️ 升级

1. 下载对应版本 zip，替换 `plugins/` 下插件目录内容
2. 重启服务器（或 `huhobot reload`）
3. 配置自动迁移：新增 `bot.auto-qr`（默认 `true`），无需手动改动

**完整变更**: [v1.6.0...v1.7.0](https://github.com/HuHoBot/PenguinBDSClient/compare/v1.6.0...v1.7.0)
