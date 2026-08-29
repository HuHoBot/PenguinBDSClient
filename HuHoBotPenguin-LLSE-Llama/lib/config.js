'use strict';

/**
 * 配置加载：读取插件目录下 config.json，缺省补全 + config-version 版本升级。
 * 键名与原 Java 版 config.yml 保持一致（点号分层），读取方式对齐 Java ConfigManager。
 */

const fs = require('fs');
const path = require('path');

const log = typeof logger !== 'undefined' ? logger : console;

const CONFIG_VERSION = 7;

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
    '解除绑定'
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
    'chat-format.start-with': '',

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

    'motd.ip': '',
    'motd.port': 19132,
    'motd.use-markdown': true,
    'motd.api': 'https://motd.minebbs.com/api/status_img?ip={ip}&port={port}',
    'motd.text': '当前在线：{online} 人\n{players}',

    'ai.enabled': false,
    'ai.base-url': '',
    'ai.api-key': '',
    'ai.model': 'gpt-4o-mini',
    'ai.system-prompt': '你是服务器管理助理，用中文简洁回复。',
    'ai.max-tokens': 1000,
    'ai.temperature': 0.7,
    'ai.context-limit': 10,
    'ai.timeout': 15000,
    'ai.admin-openids': [],
    'ai.skills': [],

    'webui.enabled': false,
    'webui.port': 8088,
    'webui.host': '127.0.0.1',
    'webui.username': 'admin',
    'webui.password': '',

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

/** 插件根目录：node 后端的 __dirname 指向 lib/，上一级即插件根。 */
function root() {
    if (typeof __dirname !== 'undefined') return path.dirname(__dirname);
    if (typeof ll !== 'undefined' && ll.scriptsFolder) return ll.scriptsFolder;
    return process.cwd();
}

function configPath() {
    return path.join(root(), 'config.json');
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function fillMissing(cfg) {
    let changed = false;
    for (const [key, value] of Object.entries(DEFAULT_VALUES)) {
        if (!(key in cfg)) {
            cfg[key] = deepClone(value);
            changed = true;
        }
    }
    return changed;
}

/** 旧版 chat-format.post-prefix 迁移到 chat-format.start-with。 */
function migratePostPrefix(cfg) {
    if (!('chat-format.post-prefix' in cfg)) return false;
    if (!('chat-format.start-with' in cfg)) {
        cfg['chat-format.start-with'] = cfg['chat-format.post-prefix'];
    }
    delete cfg['chat-format.post-prefix'];
    return true;
}

/** 强类型读取门面，对齐 Java ConfigProvider 的用法。 */
class Config {
    constructor(raw) {
        this.raw = raw;
    }

    getString(key, def) {
        const v = this.raw[key];
        return v === undefined || v === null ? def : String(v);
    }

    getInt(key, def) {
        const v = this.raw[key];
        if (v === undefined || v === null) return def;
        const n = typeof v === 'number' ? v : parseInt(v, 10);
        return Number.isNaN(n) ? def : n;
    }

    getBool(key, def) {
        const v = this.raw[key];
        return v === undefined || v === null ? def : !!v;
    }

    getList(key) {
        const v = this.raw[key];
        return Array.isArray(v) ? v : [];
    }

    getSection(key) {
        const v = this.raw[key];
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }
}

/** 嵌套 JSON（bot.app-id 风格，人类友好）展平为点号键映射。 */
function flatten(value, prefix, out) {
    for (const [key, item] of Object.entries(value)) {
        const path = prefix ? prefix + '.' + key : key;
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            flatten(item, path, out);
        } else {
            out[path] = item;
        }
    }
    return out;
}

/** 点号键映射 还原为嵌套 JSON。 */
function nest(flat) {
    const root = {};
    for (const [key, value] of Object.entries(flat)) {
        const parts = key.split('.');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) {
                node[part] = {};
            }
            node = node[part];
        }
        node[parts[parts.length - 1]] = value;
    }
    return root;
}

function load() {
    let nested = {};
    try {
        nested = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch (e) {
        log.warn('[HuHoBotPenguin] config.json 读取失败，使用默认配置：' + e.message);
    }

    const flat = flatten(nested, '', {});
    let changed = migratePostPrefix(flat);
    changed = fillMissing(flat) || changed;

    const previousVersion = typeof flat['config-version'] === 'number' ? flat['config-version'] : 0;
    if (previousVersion !== CONFIG_VERSION) {
        flat['config-version'] = CONFIG_VERSION;
        changed = true;
    }

    if (changed) {
        try {
            fs.writeFileSync(configPath(), JSON.stringify(nest(flat), null, 2) + '\n', 'utf8');
        } catch (e) {
            log.warn('[HuHoBotPenguin] 配置写入失败：' + e.message);
        }
        log.info('[HuHoBotPenguin] 配置文件已升级到版本 ' + CONFIG_VERSION + '（旧版本：' + previousVersion + '）');
    }

    return new Config(flat);
}

module.exports = { load, root, Config, CONFIG_VERSION, COMMAND_NAMES };