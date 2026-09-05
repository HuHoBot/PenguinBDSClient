# 快速开始

## 1. 安装 LSE Node 引擎

在 LeviLamina 服务器上执行：

```bash
lip install github.com/LiteLDev/LegacyScriptEngine
```

并确认 `plugins/legacy-script-engine-nodejs/` 目录存在——本插件 manifest 依赖名为 `legacy-script-engine-nodejs`，若装的是 Lua / QuickJS 后端会报依赖缺失。

## 2. 下载插件

从 [Releases](https://github.com/HuHoBot/PenguinBDSClient/releases) 下载对应版本 zip：

- `HuHoBotPenguin-LLSE-<版本>.zip` —— 标准版
- `HuHoBotPenguin-LLSE-Llama-<版本>.zip` —— AI 版（Llama）

解压到服务器的 `plugins/HuHoBotPenguin-LLSE/`（或 `plugins/HuHoBotPenguin-LLSE-Llama/`）目录，保持 `manifest.json`、`main.js`、`lib/` 在同一层。

## 3. QQ 开放平台配置

1. 到 [q.qq.com](https://q.qq.com/) 创建机器人，**接入方式选择 WebSocket**（事件订阅：群聊 / 私聊事件）。
2. 在「开发设置」里拿到 **AppID** 与 **AppSecret**。
3. 若开启了 IP 白名单，把 BDS 服务器的公网出口 IP 加入白名单（否则网关连接会被拒）。

!!! warning "提审上线"
    本插件固定连接**正式环境**（api.bot.qq.com）。机器人需**提审上线**后才能在正式网关收到群事件——未提审时能连接但收不到任何消息，这是最常见的问题，详见[故障排查](troubleshooting.md)。

## 4. 填写配置

编辑 `plugins/HuHoBotPenguin-LLSE/config.json`（AI 版路径为 `-LLSE-Llama`）：

```json
{
  "bot": {
    "app-id": "你的AppID",
    "secret": "你的Secret",
    "groups": ["目标群的OpenID"]
  }
}
```

- `bot.groups` 为空 = 所有群都可触发
- 完整配置项见[配置说明](config.md)

## 5. 重启服务器

控制台应依次出现：

```text
[HuHoBotPenguin] HuHoBot Penguin 已加载（v1.2.1）
[HuHoBotPenguin] 正在获取 access_token…
[HuHoBotPenguin] 环境：正式，后端 api.bot.qq.com…
[HuHoBotPenguin] QQ 机器人已连接（session_id=…）
```

## 6. 验证（黄金路径）

1. 群内 @机器人 发送 `查信息` → 回复本群 OpenID、本人 OpenID
2. `认证` → 回复本人认证状态；管理员 `加管理 <OpenID>` → 落盘 `command-state.json`
3. `查在线` → 回复在线玩家 + TPS/MSPT（Markdown 卡片）
4. 游戏内发送 `#测试消息` → 群收到 `[游戏] 测试消息`
5. 群内 `发信息 hello` → 游戏内广播 `[QQ] … : hello`
6. 群内 `全量 开` 后发送普通 @消息 → 游戏内出现广播
7. 断网后控制台应自动重连（Resume 或重新 Identify）

## 控制台命令

| 命令 | 说明 |
|---|---|
| `huhobot reload` | 重新读取 `config.json` 并重启 QQ 网关，**无需重启服务器** |
| `huhobot info` | 查看平台、插件版本与运行模式 |

!!! note
    `reload` 会先停掉旧机器人连接再按新配置重建；改 `bot.app-id` / `bot.secret` 等连接凭据同样生效。
