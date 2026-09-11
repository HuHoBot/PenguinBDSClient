'use strict';

/**
 * 附属插件目录加载器（SparkBridge3 模式）。
 *
 * 扫描 <插件根>/addons/ 下的每个子目录（含 index.js）或单个 .js 文件，
 * 在主插件初始化完成后加载，直接传入 API 上下文——
 * 无需 ll.imports、无需 manifest 依赖声明，也没有跨插件加载顺序问题。
 *
 * 目录约定：
 *   addons/<名称>/index.js    入口：module.exports = function (addon) { ... }
 *                             （也兼容 exports.onLoad = function (addon) {}）
 *   addons/<名称>/addon.json  可选元数据 { name, version, description, author }
 *   addons/<名称>.js          单文件附属插件（文件名即插件名）
 *
 * 元数据会自动注册到 Adapter（WebUI「附属插件」页 / 群指令「已加载插件」可见）。
 * huhobot reload 时：先全部卸载（撤销监听器/命令/元数据）再重新加载，
 * require 缓存会被清除，保证改了代码立即生效。
 */

const fs = require('fs');
const path = require('path');

const log = typeof logger !== 'undefined' ? logger : console;

/** 单个附属插件的上下文：注册即记录，卸载时统一撤销。 */
class AddonContext {
    constructor(manager, meta) {
        this.manager = manager;
        this.name = meta.name;
        this.meta = meta;
        this.logger = {
            info: (...a) => log.info('[' + meta.name + '] ' + a.join(' ')),
            warn: (...a) => log.warn('[' + meta.name + '] ' + a.join(' ')),
            error: (...a) => log.error('[' + meta.name + '] ' + a.join(' ')),
            debug: (...a) => { if (typeof log.debug === 'function') log.debug('[' + meta.name + '] ' + a.join(' ')); }
        };
        this._recvIds = [];
        this._cmdIds = [];
        this._privateIds = [];
        this._joinIds = [];
        this._readyIds = [];
        this._cmdKeys = [];
        this._regexIds = [];
        this._unloadFns = [];
        this._unloaded = false;
    }

    // ---- 事件监听（记录 id，卸载时自动注销） ----

    onRecvMsg(fn) { const id = this.manager.adapter.onRecvMsg(fn); this._recvIds.push(id); return id; }
    offRecvMsg(id) { this.manager.adapter.offRecvMsg(id); this._recvIds = this._recvIds.filter((x) => x !== id); }
    onBotCommand(fn) { const id = this.manager.adapter.onBotCommand(fn); this._cmdIds.push(id); return id; }
    offBotCommand(id) { this.manager.adapter.offBotCommand(id); this._cmdIds = this._cmdIds.filter((x) => x !== id); }
    onPrivateMsg(fn) { const id = this.manager.adapter.onPrivateMsg(fn); this._privateIds.push(id); return id; }
    offPrivateMsg(id) { this.manager.adapter.offPrivateMsg(id); this._privateIds = this._privateIds.filter((x) => x !== id); }
    onJoinRequest(fn) { const id = this.manager.adapter.onJoinRequest(fn); this._joinIds.push(id); return id; }
    offJoinRequest(id) { this.manager.adapter.offJoinRequest(id); this._joinIds = this._joinIds.filter((x) => x !== id); }
    onReady(fn) { const id = this.manager.adapter.onReady(fn); this._readyIds.push(id); return id; }
    offReady(id) { this.manager.adapter.offReady(id); this._readyIds = this._readyIds.filter((x) => x !== id); }

    // ---- 命令注册（记录 key/id，卸载时自动注销） ----

    registerBotCommand(key, command, permission, pushMenu) {
        const ok = this.manager.adapter.registerBotCommand(key, command, permission, pushMenu);
        if (ok) this._cmdKeys.push(String(key || '').trim());
        return ok;
    }

    unregisterBotCommand(key) {
        const k = String(key || '').trim();
        this._cmdKeys = this._cmdKeys.filter((x) => x !== k);
        return this.manager.adapter.unregisterBotCommand(k);
    }

    registerRegexCommand(pattern, flags, handler) {
        const id = this.manager.adapter.registerRegexCommand(pattern, flags, handler);
        if (id > 0) this._regexIds.push(id);
        return id;
    }

    unregisterRegexCommand(id) {
        this._regexIds = this._regexIds.filter((x) => x !== id);
        return this.manager.adapter.unregisterRegexCommand(id);
    }

    /** 注册卸载回调（reload / 插件卸载时调用）。 */
    onUnload(fn) {
        if (typeof fn === 'function') this._unloadFns.push(fn);
    }

    // ---- 消息发送（透传） ----

    sendGroupText(groupOpenId, text, msgId) { return this.manager.adapter.sendGroupText(groupOpenId, text, msgId); }
    sendGroupMarkdown(groupOpenId, markdown, msgId) { return this.manager.adapter.sendGroupMarkdown(groupOpenId, markdown, msgId); }
    sendAllGroupsText(text) { return this.manager.adapter.sendAllGroupsText(text); }
    sendAllGroupsMarkdown(markdown) { return this.manager.adapter.sendAllGroupsMarkdown(markdown); }
    sendPrivateText(userOpenId, text, msgId) { return this.manager.adapter.sendPrivateText(userOpenId, text, msgId); }

    // ---- 群管理（透传，机器人需群管理员） ----

    muteMember(groupOpenId, memberOpenid, durationSeconds) {
        return this.manager.adapter.muteMember(groupOpenId, memberOpenid, durationSeconds);
    }

    unmuteMember(groupOpenId, memberOpenid) {
        return this.manager.adapter.unmuteMember(groupOpenId, memberOpenid);
    }

    getJoinRequests(groupOpenId, cursor, limit) {
        return this.manager.adapter.getJoinRequests(groupOpenId, cursor, limit);
    }

    approveJoinRequest(groupOpenId, memberOpenid, options) {
        return this.manager.adapter.approveJoinRequest(groupOpenId, memberOpenid, options);
    }

    // ---- 查询（透传） ----

    getAuthenticatedQq(groupOpenId, openId) { return this.manager.adapter.getAuthenticatedQq(groupOpenId, openId); }
    getBindingName(groupOpenId, openId) { return this.manager.adapter.getBindingName(groupOpenId, openId); }
    isAdmin(groupOpenId, openId) { return this.manager.adapter.isAdmin(groupOpenId, openId); }
    getBotInfo() { return this.manager.adapter.getBotInfo(); }
    getVersion() { return this.manager.adapter.getVersion(); }
    getGroups() { return this.manager.adapter.getGroups(); }

    // ---- 内部：统一卸载 ----

    _unload() {
        if (this._unloaded) return;
        this._unloaded = true;
        for (const fn of this._unloadFns) {
            try { fn(); } catch (e) {
                log.error('[HuHoBotPenguin] 附属插件 ' + this.name + ' onUnload 回调出错：' + (e && e.stack || e));
            }
        }
        const a = this.manager.adapter;
        for (const id of this._recvIds) a.offRecvMsg(id);
        for (const id of this._cmdIds) a.offBotCommand(id);
        for (const id of this._privateIds) a.offPrivateMsg(id);
        for (const id of this._joinIds) a.offJoinRequest(id);
        for (const id of this._readyIds) a.offReady(id);
        for (const key of this._cmdKeys) a.unregisterBotCommand(key);
        for (const id of this._regexIds) a.unregisterRegexCommand(id);
        a.unregisterAddon(this.name);
        this._recvIds = []; this._cmdIds = []; this._privateIds = []; this._joinIds = [];
        this._readyIds = []; this._cmdKeys = []; this._regexIds = []; this._unloadFns = [];
    }
}

class AddonManager {
    /**
     * @param {object} adapter    Adapter 单例
     * @param {string} pluginRoot 插件根目录（addons/ 在其下）
     */
    constructor(adapter, pluginRoot) {
        this.adapter = adapter;
        this.dir = path.join(pluginRoot, 'addons');
        this.loaded = new Map(); // name -> AddonContext
    }

    /** 是否启用（features.load-addons，默认 true）。 */
    isEnabled(config) {
        return config ? config.getBool('features.load-addons', true) : true;
    }

    /** 扫描并加载 addons/ 目录下全部附属插件，返回成功加载数量。目录不存在时自动创建。 */
    loadAll() {
        let entries;
        try {
            if (!fs.existsSync(this.dir)) {
                // 首次运行自动创建 addons 目录，提示用户往里放附属插件
                fs.mkdirSync(this.dir, { recursive: true });
                log.info('[HuHoBotPenguin] 已创建附属插件目录：' + this.dir + '（将附属插件放入此目录即可自动加载）');
                return 0;
            }
            if (!fs.statSync(this.dir).isDirectory()) return 0;
            entries = fs.readdirSync(this.dir, { withFileTypes: true });
        } catch (e) {
            log.warn('[HuHoBotPenguin] 扫描 addons 目录失败：' + (e && e.message || e));
            return 0;
        }
        let count = 0;
        for (const ent of entries) {
            if (ent.isDirectory()) {
                if (this.load(ent.name)) count++;
            } else if (ent.isFile() && ent.name.endsWith('.js')) {
                if (this.load(ent.name.slice(0, -3))) count++;
            }
        }
        if (count > 0) log.info('[HuHoBotPenguin] 已加载 ' + count + ' 个附属插件（addons 目录）');
        return count;
    }

    /** 加载单个附属插件（目录名或 .js 文件名，不含扩展名）。 */
    load(entryName) {
        const dirPath = path.join(this.dir, entryName);
        const isDir = fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
        const entryPath = isDir ? path.join(dirPath, 'index.js') : path.join(this.dir, entryName + '.js');

        // 元数据：addon.json（可选），缺省用目录名
        let meta = { name: entryName, version: '', description: '', author: '' };
        const manifestPath = path.join(dirPath, 'addon.json');
        if (isDir && fs.existsSync(manifestPath)) {
            try {
                const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                meta = {
                    name: String(j.name || entryName).trim(),
                    version: String(j.version || '').trim(),
                    description: String(j.description || '').trim(),
                    author: String(j.author || '').trim()
                };
            } catch (e) {
                log.warn('[HuHoBotPenguin] 附属插件 ' + entryName + ' 的 addon.json 解析失败，使用默认元数据：' + (e && e.message || e));
            }
        }
        if (!fs.existsSync(dirPath) && !fs.existsSync(entryPath)) {
            log.warn('[HuHoBotPenguin] 附属插件 ' + entryName + ' 不存在');
            return false;
        }

        const ctx = new AddonContext(this, meta);
        try {
            if (!fs.existsSync(entryPath)) {
                log.warn('[HuHoBotPenguin] 附属插件 ' + meta.name + ' 缺少入口文件 index.js：' + entryPath);
                return false;
            }
            // 清除 require 缓存：huhobot reload 后重新加载最新代码
            const resolved = require.resolve(entryPath);
            if (require.cache[resolved]) delete require.cache[resolved];
            const mod = require(resolved);
            const entry = typeof mod === 'function' ? mod
                : (mod && typeof mod.onLoad === 'function' ? mod.onLoad.bind(mod) : null);
            if (typeof entry !== 'function') {
                log.warn('[HuHoBotPenguin] 附属插件 ' + meta.name + ' 入口未导出 function(addon)，已跳过');
                return false;
            }
            this.adapter.registerAddon(meta.name, meta.version, meta.description, meta.author);
            entry(ctx);
            this.loaded.set(meta.name, ctx);
            log.info('[HuHoBotPenguin] 附属插件已加载：' + meta.name + (meta.version ? ' v' + meta.version : ''));
            return true;
        } catch (e) {
            // 撤销该插件已注册的任何资源，避免残留
            ctx._unload();
            log.error('[HuHoBotPenguin] 附属插件 ' + meta.name + ' 加载失败：' + (e && e.stack || e));
            return false;
        }
    }

    /** 卸载全部附属插件（撤销监听器/命令/元数据，调用 onUnload 回调）。 */
    unloadAll() {
        for (const [, ctx] of Array.from(this.loaded.entries())) {
            ctx._unload();
        }
        this.loaded.clear();
    }

    /** 已加载的附属插件名列表。 */
    getNames() {
        return Array.from(this.loaded.keys());
    }
}

module.exports = { AddonManager, AddonContext };
