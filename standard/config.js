'use strict';

/**
 * 标准版配置入口：定义 COMMAND_NAMES + DEFAULT_VALUES，委托 config-core 加载。
 */

const { load, root, Config, flatten, nest } = require('./lib/config');

const CONFIG_VERSION = 6;

const COMMAND_NAMES = [
    '查信息',
    '查管理',
    '加管理',
    '删管理',
    '管理方式',
    '添加白名单',
    '删除白名单',
    '查白名单',
    '查在线',
    '在线服务器',
    'motd',
    '发信息',
    '发消息',
    '执行命令',
    '执行',
    '管理员执行',
    '全量',
    '认证',
    '解除认证',
    '绑定白名单',
    '解绑白名单',
    '解除绑定',
    '已加载插件'
];

const DEFAULT_VALUES = {
    'config-version': CONFIG_VERSION,
    'bot.app-id': '',
    'bot.secret': '',
    'bot.name': 'HuHoBot',
    'bot.groups': [],
    'serverName': '',

    'chat-format.from-game': '[游戏] {name}: {message}',
    'chat-format.from-group': '[QQ] {name}: {message}',
    'chat-format.post-chat': true,
    'chat-format.start-with': '#',

    'whitelist.add-command': 'whitelist add {name}',
    'whitelist.del-command': 'whitelist remove {name}',

    'filter-regex': [],
    'admin.mode': 'both',
    'admin.openids': [],

    'features.full-amount': false,
    'features.markdown-query-online': true,
    'features.markdown-whitelist': true,
    'features.push-menu': true,
    'features.online-tps': true,
    'features.load-addons': true,
    'features.auto-ack-interaction': true,

    'addon-center.enabled': true,
    'addon-center.api-base': 'https://addon.txssb.cn/api.php',
    'addon-center.filter-lse-only': true,

    'motd.ip': '',
    'motd.port': 19132,
    'motd.use-markdown': true,
    'motd.api': 'https://motd.minebbs.com/api/status_img?ip={ip}&port={port}',
    'motd.text': '当前在线：{online} 人\n{players}',

    'join-leave.enabled': true,
    'join-leave.join-format': '[{server}] 🟢{name}进入服务器',
    'join-leave.leave-format': '[{server}] 🔴{name}退出服务器',

    'audit.base-url': '',
    'audit.api-key': '',
    'audit.model': 'gpt-4o-mini',

    'custom-commands': [],
    'debug.probe': false,
    'debug.log-events': false
};

for (const name of COMMAND_NAMES) {
    DEFAULT_VALUES['commands.' + name] = true;
    DEFAULT_VALUES['command-panel.' + name] = true;
}

function loadConfig() {
    return load(CONFIG_VERSION, DEFAULT_VALUES);
}

module.exports = { load: loadConfig, root, Config, CONFIG_VERSION, COMMAND_NAMES };
