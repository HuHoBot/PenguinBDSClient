'use strict';

/**
 * QQ 官方指令面板同步（/v2/panels 接口）。
 *
 * 实测 QQ 客户端同一场景只展示一个面板，因此本插件只维护**一个** group 面板
 * （remark = PANEL_REMARK，跨重启按 remark 找回复用），上限 20 个命令：
 *   - 附属插件 registerBotCommand(pushMenu=true) 的命令优先；
 *   - 内置命令（features.push-menu=true 时）按定义顺序填充剩余位置，放不下的跳过并告警。
 *
 * panel_id / 命令镜像持久化在 command-state.json 的 "command-panel" 字段；
 * 旧版多面板格式（addon/builtin-N 多集合）会在启动时自动迁移并删除多余面板。
 *
 * 其他官方限制：item.name ≤ 14 字符；创建/修改 10 QPM —— 走串行队列避免并发冲突。
 */

const { requestJson } = require('./qqclient');
const { COMMANDS } = require('./commands');

const log = typeof logger !== 'undefined' ? logger : console;

const HOST = 'api.bot.qq.com';
const PANEL_REMARK = 'HuHoBotPenguin 附属命令面板';
const MAX_ITEMS = 20;
const MAX_NAME_LEN = 14;

class PanelSync {
    constructor() {
        this.bot = null;
        this._queue = Promise.resolve();
    }

    /** 每次 startRuntime 时挂载新 Bot 门面（提供 qqclient/config/state）。 */
    attachBot(bot) {
        this.bot = bot;
    }

    _ready() {
        return !!(this.bot && this.bot.qqclient && this.bot.qqclient.getAccessToken);
    }

    // ---- 持久化存储 ----

    /**
     * 取单一面板存储：{ panelId, builtin[], addon[], synced[] }。
     * 兼容迁移旧版格式（扁平单面板 / 多集合 addon+builtin-N）。
     */
    _store() {
        const data = this.bot.state.data;
        if (!data['command-panel'] || typeof data['command-panel'] !== 'object' || Array.isArray(data['command-panel'])) {
            data['command-panel'] = {};
        }
        const cp = data['command-panel'];
        if (!cp.main || typeof cp.main !== 'object') {
            cp.main = { panelId: null, builtin: [], addon: [], synced: [] };
            // 旧多集合格式：addon 集合收编为 main；其余集合保留待删除
            if (cp.collections && typeof cp.collections === 'object') {
                const oldAddon = cp.collections.addon;
                if (oldAddon && typeof oldAddon === 'object') {
                    cp.main.panelId = oldAddon.panelId || null;
                    cp.main.addon = Array.isArray(oldAddon.items) ? oldAddon.items : [];
                }
            }
            // 更旧的扁平格式
            if (!cp.main.panelId && cp.panelId) {
                cp.main.panelId = cp.panelId;
                cp.main.addon = Array.isArray(cp.items) ? cp.items : [];
            }
        }
        return cp.main;
    }

    /** 收集旧格式遗留的面板 id（启动同步后统一删除）。 */
    _stalePanelIds() {
        const data = this.bot.state.data;
        const ids = [];
        if (data['command-panel'] && typeof data['command-panel'].collections === 'object') {
            for (const [key, col] of Object.entries(data['command-panel'].collections)) {
                if (key !== 'main' && col && col.panelId) ids.push(col.panelId);
            }
        }
        return ids;
    }

    // ---- 队列与 HTTP ----

    _enqueue(fn) {
        const run = this._queue.then(fn);
        this._queue = run.catch(() => {});
        return run;
    }

    _api(method, path, body, label) {
        const client = this.bot.qqclient;
        return client.getAccessToken().then((token) => requestJson({
            host: HOST,
            path,
            method,
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': client.appId,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body,
            label
        }));
    }

    _toItem(entry) {
        const item = { type: 'command', name: entry.name };
        if (entry.onlyAdmin) item.only_admin = true;
        return item;
    }

    /** 找回或创建唯一面板，返回 Promise<panelId>。创建时必须携带非空 items。 */
    _ensurePanel(initItems) {
        const store = this._store();
        if (store.panelId) return Promise.resolve(store.panelId);

        const items = (initItems || []).map((i) => this._toItem(i));
        return this._api('GET', '/v2/panels?scope=group&limit=50', undefined, '查询指令面板').then((res) => {
            const records = (res && res.records) || [];
            const mine = records.find((r) => r && r.panel && r.panel.remark === PANEL_REMARK && r.panel_id);
            if (mine) {
                store.panelId = mine.panel_id;
                // 以服务端为准恢复已同步快照
                store.synced = (mine.panel.items || [])
                    .filter((i) => i && i.type === 'command' && i.name)
                    .map((i) => ({ name: i.name, onlyAdmin: !!i.only_admin }));
                this.bot.state.save();
                log.info('[HuHoBotPenguin] 已找回指令面板：' + store.panelId + '（' + store.synced.length + ' 个命令）');
                return store.panelId;
            }
            const groups = this.bot.config.getList('bot.groups').map(String);
            const body = { scope: 'group', target_type: groups.length ? 'specific' : 'all' };
            if (groups.length) body.group_openids = groups.slice(0, 20);
            body.panel = { items, remark: PANEL_REMARK };
            return this._api('POST', '/v2/panels', body, '创建指令面板').then((r) => {
                store.panelId = r && r.panel_id;
                if (!store.panelId) throw new Error('创建指令面板未返回 panel_id');
                store.synced = (initItems || []).map((i) => ({ name: i.name, onlyAdmin: !!i.onlyAdmin }));
                this.bot.state.save();
                log.info('[HuHoBotPenguin] 已创建指令面板：' + store.panelId +
                    '（target=' + body.target_type + (groups.length ? '，绑定 ' + body.group_openids.length + ' 个群' : '') +
                    '，' + store.synced.length + ' 个命令）');
                return store.panelId;
            });
        });
    }

    /**
     * 把内置 + 附属命令合并同步到唯一面板（不做去重/截断，调用方保证）。
     * 快照一致时跳过网络请求；完成后清理旧格式遗留的多余面板。
     */
    _syncMainNow() {
        const store = this._store();
        // 附属命令优先（显式 pushMenu 注册），内置命令按定义顺序填充剩余位置
        const desired = this._normalize(store.addon.concat(store.builtin)) || [];
        return this._ensurePanel(desired).then(() =>
            this._cleanupStale().then(() => {
                const same = store.synced.length === desired.length &&
                    store.synced.every((it, i) => it.name === desired[i].name && !!it.onlyAdmin === !!desired[i].onlyAdmin);
                if (same) return true;
                return this._api('PUT', '/v2/panels/' + encodeURIComponent(store.panelId),
                    { panel: { items: desired.map((i) => this._toItem(i)), remark: PANEL_REMARK } },
                    '更新指令面板').then(() => {
                    store.synced = desired.map((i) => ({ name: i.name, onlyAdmin: !!i.onlyAdmin }));
                    this.bot.state.save();
                    log.info('[HuHoBotPenguin] 指令面板已更新（' + desired.length + ' 个命令）');
                    return true;
                });
            })
        );
    }

    /** 删除旧格式遗留的多余面板（幂等，失败不影响主流程；面板已不存在视为成功）。 */
    _cleanupStale() {
        const ids = this._stalePanelIds();
        if (!ids.length) return Promise.resolve();
        const tasks = ids.map((id) =>
            this._api('DELETE', '/v2/panels/' + encodeURIComponent(id), undefined, '删除多余指令面板')
                .then(() => log.info('[HuHoBotPenguin] 已删除多余指令面板：' + id))
                .catch((e) => {
                    const msg = e && e.message || String(e);
                    // 40030006：服务端本就不存在（QQ 同场景创建会覆盖旧面板），视为已清理
                    if (msg.includes('40030006') || msg.includes('指令面板不存在')) {
                        log.info('[HuHoBotPenguin] 多余指令面板已不存在，跳过删除：' + id);
                        return;
                    }
                    log.warn('[HuHoBotPenguin] 删除多余指令面板失败（' + id + '）：' + msg);
                })
        );
        return Promise.all(tasks).then(() => {
            delete this.bot.state.data['command-panel'].collections;
            this.bot.state.save();
        });
    }

    /**
     * 规范化合并后的 items：截断 14 字符、去重、限制 20 个上限（超出部分告警丢弃）。
     */
    _normalize(items) {
        const out = [];
        for (const raw of items || []) {
            let name = String((raw && raw.name) || '').trim();
            if (!name) continue;
            if (name.length > MAX_NAME_LEN) {
                log.warn('[HuHoBotPenguin] 命令 "' + name + '" 超过面板名称 14 字符上限，已截断');
                name = name.slice(0, MAX_NAME_LEN);
            }
            if (out.some((i) => i.name === name)) continue;
            if (out.length >= MAX_ITEMS) {
                log.warn('[HuHoBotPenguin] 指令面板已达 ' + MAX_ITEMS + ' 个命令上限，"' + name + '" 未同步');
                continue;
            }
            out.push({ name, onlyAdmin: !!(raw && raw.onlyAdmin) });
        }
        return out;
    }

    /**
     * 内置命令同步（features.push-menu=true 时启动时调用一次）。
     * 只同步未被 commands.<名> 关闭的命令；与附属命令合并后共享 20 个上限。
     * @returns {Promise<boolean>}
     */
    syncBuiltins() {
        if (!this._ready()) return Promise.resolve(false);
        const enabled = COMMANDS
            .filter((cmd) => this.bot.config.getBool('commands.' + cmd.name, true))
            .filter((cmd) => this.bot.config.getBool('command-panel.' + cmd.name, true))
            .map((cmd) => ({ name: cmd.name, onlyAdmin: !!cmd.adminOnly }));
        return this._enqueue(() => {
            this._store().builtin = enabled;
            this.bot.state.save();
            return this._syncMainNow();
        }).catch((e) => {
            log.error('[HuHoBotPenguin] 内置命令同步指令面板失败：' + (e && e.message || e));
            return false;
        });
    }

    /**
     * 把运行时命令加入面板（pushMenu=true 时由 Adapter 调用）。附属命令优先于内置命令。
     * @returns {Promise<boolean>} 是否成功同步
     */
    addCommand(rawKey, onlyAdmin) {
        if (!this._ready()) return Promise.resolve(false);
        const key = String(rawKey || '').trim();
        if (!key) return Promise.resolve(false);
        if (key.length > MAX_NAME_LEN) {
            log.warn('[HuHoBotPenguin] 命令 "' + key + '" 超过面板名称 14 字符上限，已截断');
        }
        return this._enqueue(() => {
            const store = this._store();
            const name = key.slice(0, MAX_NAME_LEN);
            const exists = store.addon.some((i) => i.name.slice(0, MAX_NAME_LEN) === name);
            if (exists) {
                store.addon = store.addon.map((i) =>
                    (i.name.slice(0, MAX_NAME_LEN) === name ? { name: i.name.slice(0, MAX_NAME_LEN), onlyAdmin: !!onlyAdmin } : i));
            } else {
                store.addon.push({ name, onlyAdmin: !!onlyAdmin });
            }
            this.bot.state.save();
            return this._syncMainNow();
        }).catch((e) => {
            log.error('[HuHoBotPenguin] 同步指令面板失败（命令 ' + key + '）：' + (e && e.message || e));
            return false;
        });
    }

    /**
     * 从面板移除运行时命令（仅当此前同步过时才发网络请求）。
     * @returns {Promise<boolean>}
     */
    removeCommand(rawKey) {
        if (!this._ready()) return Promise.resolve(false);
        const name = String(rawKey || '').trim().slice(0, MAX_NAME_LEN);
        return this._enqueue(() => {
            const store = this._store();
            const remaining = store.addon.filter((i) => i.name.slice(0, MAX_NAME_LEN) !== name);
            if (remaining.length === store.addon.length) return false;
            store.addon = remaining;
            this.bot.state.save();
            return this._syncMainNow();
        }).catch((e) => {
            log.error('[HuHoBotPenguin] 从指令面板移除失败（命令 ' + name + '）：' + (e && e.message || e));
            return false;
        });
    }
}

module.exports = { PanelSync, PANEL_REMARK, MAX_ITEMS, MAX_NAME_LEN };
