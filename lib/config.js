'use strict';

/**
 * 配置加载核心：工具函数 + load() 工厂。
 * 两版 wrapper（standard/config.js、llama/config.js）各自提供
 * CONFIG_VERSION 和 DEFAULT_VALUES，调用 load(configVersion, defaults) 启动。
 */

const fs = require('fs');
const path = require('path');

const log = typeof logger !== 'undefined' ? logger : console;

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

function fillMissing(cfg, defaults) {
    let changed = false;
    for (const [key, value] of Object.entries(defaults)) {
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
        const p = prefix ? prefix + '.' + key : key;
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            flatten(item, p, out);
        } else {
            out[p] = item;
        }
    }
    return out;
}

/** 点号键映射 还原为嵌套 JSON。 */
function nest(flat) {
    const result = {};
    for (const [key, value] of Object.entries(flat)) {
        const parts = key.split('.');
        let node = result;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) {
                node[part] = {};
            }
            node = node[part];
        }
        node[parts[parts.length - 1]] = value;
    }
    return result;
}

/**
 * 加载并补全配置。
 * @param {number} configVersion 当前版本号（标准版 6 / Llama 版 8）
 * @param {Record<string, any>} defaults 完整默认值映射（含 config-version）
 */
function load(configVersion, defaults) {
    let nested = {};
    try {
        nested = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch (e) {
        log.warn('[HuHoBotPenguin] config.json 读取失败，使用默认配置：' + e.message);
    }

    const flat = flatten(nested, '', {});
    // config-version 必须在 fillMissing 之前读取：默认值补全会写入新版本号，覆盖旧值。
    const previousVersion = typeof flat['config-version'] === 'number' ? flat['config-version'] : 0;
    let changed = migratePostPrefix(flat);
    changed = fillMissing(flat, defaults) || changed;

    if (previousVersion !== configVersion) {
        flat['config-version'] = configVersion;
        changed = true;
    }

    if (changed) {
        try {
            fs.writeFileSync(configPath(), JSON.stringify(nest(flat), null, 2) + '\n', 'utf8');
        } catch (e) {
            log.warn('[HuHoBotPenguin] 配置写入失败：' + e.message);
        }
        if (previousVersion === 0) {
            log.info('[HuHoBotPenguin] 已生成默认配置文件（版本 ' + configVersion + '）');
        } else if (previousVersion !== configVersion) {
            log.info('[HuHoBotPenguin] 配置文件已升级到版本 ' + configVersion + '（旧版本：' + previousVersion + '）');
        }
    }

    return new Config(flat);
}

module.exports = { load, root, Config, flatten, nest };
