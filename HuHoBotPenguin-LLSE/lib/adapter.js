'use strict';

/**
 * 附属插件开放 API（对齐 Java 版 HuHoBotPenguin 适配器公共 API）。
 *
 * 通过 ll.exports 以命名空间 "HuHoBotPenguin" 导出给其他 LLSE 插件使用：
 *   - 事件监听：onRecvMsg / offRecvMsg、onBotCommand / offBotCommand
 *     （回调签名 fn(msgPack, event)；event 提供 replyText/replyMarkdown/setCancelled/isCancelled）
 *   - 运行时命令：registerBotCommand(key, command, permission, pushMenu) / unregisterBotCommand(key)
 *   - 认证查询：getAuthenticatedQq(groupOpenId, openId)
 *     （官方机器人 API 无法获取真实 QQ 号，已认证时返回该用户 OpenID 作为唯一标识）
 *   - 群发送：sendGroupText / sendGroupMarkdown / sendAllGroupsText / sendAllGroupsMarkdown
 *
 * 采用 globalThis 单例：huhobot reload 重建 Bot 后，附属插件持有的 API 引用仍然有效。
 */

const { renderCommand } = require('./customcommands');
const { PanelSync } = require('./panel');

const log = typeof logger !== 'undefined' ? logger : console;

const SINGLETON_KEY = '__huohoBotPenguinAdapter';

class Adapter {
    constructor() {
        this.bot = null;
        this.version = null;
        this._nextId = 1;
        this._recvListeners = new Map();   // id -> fn(msgPack, event)
        this._cmdListeners = new Map();    // id -> fn(msgPack, event)
        this._runtimeCommands = new Map(); // key -> { command, permission, pushMenu }
        this._readyListeners = new Map();      // id -> fn({version})
        this._privateListeners = new Map();    // id -> fn(msgPack, event)
        this._joinRequestListeners = new Map(); // id -> fn(msgPack, event)
        this._regexCommands = new Map();       // id -> { regex, handler }
        this.panel = new PanelSync();
    }

    /** 每次 startRuntime 时把新 Bot 门面挂到单例上。 */
    attachBot(bot) {
        this.bot = bot;
        this.panel.attachBot(bot);
    }

    /** 插件版本（main.js 启动时传入）。 */
    setVersion(version) {
        this.version = version;
    }

    getVersion() {
        if (this.version) return this.version;
        try {
            return require('../manifest.json').version || 'unknown';
        } catch (e) {
            return 'unknown';
        }
    }

    _ready() {
        return !!(this.bot && this.bot.qqclient);
    }

    // ---- MsgPack 快照 ----

    /**
     * 构造不可变消息快照（对齐 Java MsgPack 字段；官方群事件不含真实群号/附件，
     * groupId 恒为 null、mentions/attachments 恒为空数组）。
     * @param {object} message qqclient 发出的原始消息 { id, groupId, content, userId, username, memberRole, timestamp }
     * @param {object} [extras] 覆盖字段（如 commandKey / commandArguments）
     */
    buildMsgPack(message, extras) {
        const m = message || {};
        const pack = {
            messageId: String(m.id || ''),
            groupOpenId: String(m.groupId || ''),
            groupId: null,
            sender: {
                id: String(m.userId || ''),
                username: String(m.username || ''),
                memberRole: String(m.memberRole || '')
            },
            content: String(m.content == null ? '' : m.content),
            rawContent: String(m.rawContent == null ? (m.content == null ? '' : m.content) : m.rawContent),
            timestamp: m.timestamp || null,
            messageSequence: 0,
            commandKey: null,
            commandArguments: null,
            mentions: [],
            attachments: []
        };
        return Object.assign(pack, extras || {});
    }

    /** 构造事件控制器：replyText / replyMarkdown / setCancelled / isCancelled。 */
    _makeEvent(pack) {
        const self = this;
        let cancelled = false;
        const target = pack.groupOpenId || pack.userOpenId;
        const isPrivate = !pack.groupOpenId;
        return {
            pack,
            /** 回复触发消息（群消息被动回复 / 单聊被动回复），返回是否已提交发送。 */
            replyText(text) {
                if (!self._ready() || !target || text === undefined || text === null) return false;
                if (isPrivate) {
                    self.bot.qqclient.sendPrivateMessage(target, String(text), pack.messageId || undefined);
                } else {
                    self.bot.qqclient.sendGroupMessage(target, String(text), pack.messageId || undefined);
                }
                return true;
            },
            /** 回复 Markdown（msg_type=2），返回是否已提交发送。 */
            replyMarkdown(markdown) {
                if (!self._ready() || !target || markdown === undefined || markdown === null) return false;
                if (isPrivate) {
                    self.bot.qqclient.sendPrivateMessage(target, String(markdown), pack.messageId || undefined, 2);
                } else {
                    if (typeof self.bot.qqclient.sendMarkdown !== 'function') return false;
                    self.bot.qqclient.sendMarkdown(target, String(markdown), pack.messageId || undefined);
                }
                return true;
            },
            /** 取消事件，阻止后续默认处理（内置命令执行 / 命令模板执行 / 全量转发）。 */
            setCancelled() { cancelled = true; },
            isCancelled() { return cancelled; }
        };
    }

    // ---- 事件监听 ----

    /** 注册 QQ 消息监听（在公共命令处理前触发），返回监听器 id。 */
    onRecvMsg(fn) {
        if (typeof fn !== 'function') return -1;
        const id = this._nextId++;
        this._recvListeners.set(id, fn);
        return id;
    }

    offRecvMsg(id) {
        return this._recvListeners.delete(Number(id));
    }

    /** 注册自定义命令命中监听（pack 含 commandKey/commandArguments），返回监听器 id。 */
    onBotCommand(fn) {
        if (typeof fn !== 'function') return -1;
        const id = this._nextId++;
        this._cmdListeners.set(id, fn);
        return id;
    }

    offBotCommand(id) {
        return this._cmdListeners.delete(Number(id));
    }

    /**
     * 触发 OnBotRecvMsg。任一监听器取消即短路。
     * @returns {{cancelled: boolean}}
     */
    fireRecvMsg(message) {
        const result = { cancelled: false };
        if (this._recvListeners.size === 0) return result;
        const pack = this.buildMsgPack(message);
        const event = this._makeEvent(pack);
        for (const [id, fn] of Array.from(this._recvListeners.entries())) {
            try {
                fn(pack, event);
            } catch (e) {
                log.error('[HuHoBotPenguin] 附属插件 onRecvMsg 监听器 #' + id + ' 出错：' + (e && e.stack || e));
            }
            if (event.isCancelled()) {
                result.cancelled = true;
                break;
            }
        }
        return result;
    }

    /**
     * 触发 OnBotCommand（pack 需带 commandKey/commandArguments）。
     * @param {object} pack buildMsgPack 的产物
     * @returns {{cancelled: boolean}}
     */
    fireBotCommand(pack) {
        const result = { cancelled: false };
        const event = this._makeEvent(pack);
        for (const [id, fn] of Array.from(this._cmdListeners.entries())) {
            try {
                fn(pack, event);
            } catch (e) {
                log.error('[HuHoBotPenguin] 附属插件 onBotCommand 监听器 #' + id + ' 出错：' + (e && e.stack || e));
            }
            if (event.isCancelled()) {
                result.cancelled = true;
                break;
            }
        }
        return result;
    }

    // ---- 就绪 / 单聊 / 入群申请事件 ----

    /** 注册机器人就绪监听（网关 READY 后触发一次），返回监听器 id。 */
    onReady(fn) {
        if (typeof fn !== 'function') return -1;
        const id = this._nextId++;
        this._readyListeners.set(id, fn);
        return id;
    }

    offReady(id) {
        return this._readyListeners.delete(Number(id));
    }

    fireReady() {
        if (this._readyListeners.size === 0) return;
        const pack = { version: this.getVersion() };
        for (const [id, fn] of Array.from(this._readyListeners.entries())) {
            try { fn(pack); } catch (e) {
                log.error('[HuHoBotPenguin] 附属插件 onReady 监听器 #' + id + ' 出错：' + (e && e.stack || e));
            }
        }
    }

    /** 注册单聊消息监听（C2C_MESSAGE_CREATE），返回监听器 id。 */
    onPrivateMsg(fn) {
        if (typeof fn !== 'function') return -1;
        const id = this._nextId++;
        this._privateListeners.set(id, fn);
        return id;
    }

    offPrivateMsg(id) {
        return this._privateListeners.delete(Number(id));
    }

    firePrivateMsg(message) {
        if (this._privateListeners.size === 0) return;
        const pack = {
            messageId: String(message.id || ''),
            userOpenId: String(message.userOpenId || ''),
            content: String(message.content == null ? '' : message.content),
            timestamp: message.timestamp || null,
            mentions: [],
            attachments: []
        };
        const event = this._makeEvent(pack);
        for (const [id, fn] of Array.from(this._privateListeners.entries())) {
            try { fn(pack, event); } catch (e) {
                log.error('[HuHoBotPenguin] 附属插件 onPrivateMsg 监听器 #' + id + ' 出错：' + (e && e.stack || e));
            }
            if (event.isCancelled()) break;
        }
    }

    /** 注册入群申请监听（GROUP_JOIN_REQUEST，机器人需为群管理员），返回监听器 id。 */
    onJoinRequest(fn) {
        if (typeof fn !== 'function') return -1;
        const id = this._nextId++;
        this._joinRequestListeners.set(id, fn);
        return id;
    }

    offJoinRequest(id) {
        return this._joinRequestListeners.delete(Number(id));
    }

    fireJoinRequest(request) {
        if (this._joinRequestListeners.size === 0) return;
        const pack = {
            groupOpenId: String(request.groupOpenId || ''),
            memberOpenid: String(request.memberOpenid || ''),
            username: String(request.username || ''),
            joinRequestId: String(request.joinRequestId || ''),
            applyAt: String(request.applyAt || ''),
            verifyMessage: String(request.verifyMessage || ''),
            mentions: [],
            attachments: []
        };
        const event = this._makeEvent(pack);
        for (const [id, fn] of Array.from(this._joinRequestListeners.entries())) {
            try { fn(pack, event); } catch (e) {
                log.error('[HuHoBotPenguin] 附属插件 onJoinRequest 监听器 #' + id + ' 出错：' + (e && e.stack || e));
            }
            if (event.isCancelled()) break;
        }
    }

    // ---- 正则命令 ----

    /**
     * 注册正则命令：群消息未命中内置/运行时命令时，依次尝试正则匹配。
     * handler 签名 fn(msgPack, match, event)；event.setCancelled 可取消后续默认处理。
     * @returns {number} 监听器 id，参数非法返回 -1
     */
    registerRegexCommand(pattern, flags, handler) {
        if (typeof handler !== 'function' || !pattern) return -1;
        let regex;
        try {
            regex = new RegExp(String(pattern), String(flags || ''));
        } catch (e) {
            log.warn('[HuHoBotPenguin] registerRegexCommand 正则非法：' + (e && e.message || e));
            return -1;
        }
        const id = this._nextId++;
        this._regexCommands.set(id, { regex, handler });
        log.info('[HuHoBotPenguin] 附属插件注册正则命令：/' + pattern + '/' + (flags || ''));
        return id;
    }

    unregisterRegexCommand(id) {
        return this._regexCommands.delete(Number(id));
    }

    /**
     * 触发正则命令匹配（cleaned 为去 @ 前缀的消息文本）。
     * @returns {{cancelled: boolean}} cancelled=true 时取消后续默认处理
     */
    fireRegexCommands(cleaned, message) {
        const result = { cancelled: false };
        if (this._regexCommands.size === 0) return result;
        for (const [, item] of Array.from(this._regexCommands.entries())) {
            const match = item.regex.exec(cleaned);
            if (!match) continue;
            const pack = this.buildMsgPack(message, { regexMatches: match.slice(0) });
            const event = this._makeEvent(pack);
            try { item.handler(pack, match, event); } catch (e) {
                log.error('[HuHoBotPenguin] 附属插件正则命令出错：' + (e && e.stack || e));
            }
            if (event.isCancelled()) {
                result.cancelled = true;
                break;
            }
        }
        return result;
    }

    // ---- 元信息与管理能力包装 ----

    /** 配置的群 OpenID 列表副本。 */
    getGroups() {
        return this.bot ? this.bot.config.getList('bot.groups').slice() : [];
    }

    /**
     * 判断是否管理员（基于配置 admin.openids + 手动管理员；不含群 QQ 管理员角色，
     * 角色只在消息上下文可知）。
     */
    isAdmin(groupOpenId, openId) {
        if (!this.bot || !groupOpenId || !openId) return false;
        return this.bot.state.isManualAdmin(groupOpenId, openId);
    }

    /** 获取机器人信息（GET /users/@me），返回 Promise<{id, username, avatar}>。 */
    getBotInfo() {
        if (!this._ready()) return Promise.reject(new Error('QQ 机器人未启动'));
        return this.bot.qqclient.getBotInfo();
    }

    /** 发送单聊文本消息，返回是否已提交发送。 */
    sendPrivateText(userOpenId, text, msgId) {
        if (!this._ready() || !userOpenId || text === undefined || text === null) return false;
        this.bot.qqclient.sendPrivateMessage(String(userOpenId), String(text), msgId || undefined);
        return true;
    }

    /** 禁言群成员（机器人需群管理员，最长 30 天），返回 Promise。 */
    muteMember(groupOpenId, memberOpenid, durationSeconds) {
        if (!this._ready()) return Promise.reject(new Error('QQ 机器人未启动'));
        return this.bot.qqclient.muteMember(groupOpenId, memberOpenid, durationSeconds);
    }

    /** 解除群成员禁言，返回 Promise。 */
    unmuteMember(groupOpenId, memberOpenid) {
        if (!this._ready()) return Promise.reject(new Error('QQ 机器人未启动'));
        return this.bot.qqclient.unmuteMember(groupOpenId, memberOpenid);
    }

    /** 拉取入群申请列表，返回 Promise<{list, next_cursor}>。 */
    getJoinRequests(groupOpenId, cursor, limit) {
        if (!this._ready()) return Promise.reject(new Error('QQ 机器人未启动'));
        return this.bot.qqclient.getJoinRequests(groupOpenId, cursor, limit);
    }

    /** 审批入群申请（options: {approve, joinRequestId, rejectReason, addToBlacklist}），返回 Promise。 */
    approveJoinRequest(groupOpenId, memberOpenid, options) {
        if (!this._ready()) return Promise.reject(new Error('QQ 机器人未启动'));
        return this.bot.qqclient.approveJoinRequest(groupOpenId, memberOpenid, options);
    }

    // ---- 运行时命令 ----

    /**
     * 注册运行时自定义命令（对齐 Java registerBotCommand）。
     * pushMenu=true 时把命令同步到 QQ 官方 group 指令面板（异步，不阻塞注册）。
     */
    registerBotCommand(key, command, permission, pushMenu) {
        const k = String(key || '').trim();
        const c = String(command || '');
        if (!k || !c) {
            log.warn('[HuHoBotPenguin] registerBotCommand 参数非法：key/command 不能为空');
            return false;
        }
        const perm = Number(permission) > 0 ? 1 : 0;
        const menu = !!pushMenu;
        this._runtimeCommands.set(k, { command: c, permission: perm, pushMenu: menu });
        log.info('[HuHoBotPenguin] 附属插件注册运行时命令：' + k + ' → ' + c + '（permission=' + perm +
            (menu ? '，pushMenu' : '') + '）');
        if (menu) this.panel.addCommand(k, perm > 0);
        return true;
    }

    unregisterBotCommand(key) {
        const k = String(key || '').trim();
        const item = this._runtimeCommands.get(k);
        const removed = this._runtimeCommands.delete(k);
        if (removed) {
            log.info('[HuHoBotPenguin] 附属插件注销运行时命令：' + k);
            // 曾同步过面板（或无法确认）时尝试移除；removeCommand 本地镜像无记录时不发请求
            if (!item || item.pushMenu) this.panel.removeCommand(k);
        }
        return removed;
    }

    /** 按命令名长度降序匹配运行时命令（与内置命令同规则）。 */
    matchRuntimeCommand(cleaned) {
        const keys = Array.from(this._runtimeCommands.keys()).sort((a, b) => b.length - a.length);
        for (const key of keys) {
            if (cleaned === key || cleaned.startsWith(key + ' ')) {
                return { key, params: cleaned === key ? '' : cleaned.slice(key.length).trim() };
            }
        }
        return null;
    }

    /** 执行运行时命令模板（未被监听器取消时调用）。 */
    executeRuntimeCommand(match, message) {
        const item = this._runtimeCommands.get(match.key);
        if (!item || !this.bot) return false;
        const command = renderCommand(item.command, match.params, message.groupId, message.userId, 'huhobot adapter');
        this.bot.sendCommand(command);
        return true;
    }

    // ---- 认证查询 ----

    /**
     * 查询指定群指定用户的认证状态（对齐 Java getAuthenticatedQq）。
     * 官方机器人 API 拿不到真实 QQ 号，已认证时返回该用户 OpenID，未认证返回 null。
     */
    getAuthenticatedQq(groupOpenId, openId) {
        if (!this.bot || !groupOpenId || !openId) return null;
        return this.bot.state.isAuthenticated(groupOpenId, openId) ? String(openId) : null;
    }

    /** 查询绑定游戏名（LLSE 版扩展），无绑定返回 null。 */
    getBindingName(groupOpenId, openId) {
        if (!this.bot || !groupOpenId || !openId) return null;
        return this.bot.state.getBindingName(groupOpenId, openId);
    }

    // ---- 群发送 ----

    sendGroupText(groupOpenId, text, msgId) {
        if (!this._ready() || !groupOpenId || text === undefined || text === null) return false;
        this.bot.qqclient.sendGroupMessage(String(groupOpenId), String(text), msgId || undefined);
        return true;
    }

    sendGroupMarkdown(groupOpenId, markdown, msgId) {
        if (!this._ready() || !groupOpenId || markdown === undefined || markdown === null) return false;
        if (typeof this.bot.qqclient.sendMarkdown !== 'function') return false;
        this.bot.qqclient.sendMarkdown(String(groupOpenId), String(markdown), msgId || undefined);
        return true;
    }

    sendAllGroupsText(text) {
        if (!this._ready() || text === undefined || text === null) return false;
        this.bot.sendToAllGroups(String(text));
        return true;
    }

    sendAllGroupsMarkdown(markdown) {
        if (!this._ready() || markdown === undefined || markdown === null) return false;
        if (typeof this.bot.qqclient.sendMarkdown !== 'function') return false;
        for (const groupId of this.bot.config.getList('bot.groups')) {
            this.bot.qqclient.sendMarkdown(groupId, String(markdown));
        }
        return true;
    }
}

/**
 * 取跨热重载共享的单例：挂在 process 上（同一 Node 进程内跨脚本上下文可见），
 * globalThis 在 LSE 热重载的新上下文中是隔离的，不可用于跨 reload 共享。
 */
function getSharedAdapter() {
    const scope = (typeof process !== 'undefined' && process) ||
        (typeof globalThis !== 'undefined' ? globalThis : global);
    if (!scope[SINGLETON_KEY]) scope[SINGLETON_KEY] = new Adapter();
    return scope[SINGLETON_KEY];
}

module.exports = { Adapter, getSharedAdapter };
