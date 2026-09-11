'use strict';

/**
 * 分群状态持久化：手动管理员 / 认证用户 / 管理方式 / 全量转发，逐群存档。
 * 对应 Java 版 command-state.ini（administrators / authenticated-users / administrator-modes / full-forwarding）。
 * 变更即写盘（tmp + rename 原子写）。
 */

const fs = require('fs');
const path = require('path');
const { root } = require('./config');

const log = typeof logger !== 'undefined' ? logger : console;

const MODE_QQ = 'QQ';
const MODE_MANUAL = 'MANUAL';
const MODE_BOTH = 'BOTH';

/** 配置值 qq/config/both → QQ/MANUAL/BOTH，对齐 Java AdminMode.from。 */
function mapConfigMode(value) {
    if (value === 'qq') return MODE_QQ;
    if (value === 'config' || value === 'manual') return MODE_MANUAL;
    return MODE_BOTH;
}

function isValidMode(value) {
    return value === MODE_QQ || value === MODE_MANUAL || value === MODE_BOTH;
}

class State {
    constructor(cfg) {
        this.cfg = cfg;
        this.file = path.join(root(), 'command-state.json');
        this.data = {
            administrators: {},
            'authenticated-users': {},
            'administrator-modes': {},
            'full-forwarding': {},
            bindings: {},
            'command-panel': { collections: {} }
        };
        this.load();
    }

    load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (raw.administrators && typeof raw.administrators === 'object') this.data.administrators = raw.administrators;
            if (raw['authenticated-users'] && typeof raw['authenticated-users'] === 'object') this.data['authenticated-users'] = raw['authenticated-users'];
            if (raw['administrator-modes'] && typeof raw['administrator-modes'] === 'object') this.data['administrator-modes'] = raw['administrator-modes'];
            if (raw['full-forwarding'] && typeof raw['full-forwarding'] === 'object') this.data['full-forwarding'] = raw['full-forwarding'];
            if (raw.bindings && typeof raw.bindings === 'object') this.data.bindings = raw.bindings;
            if (raw['command-panel'] && typeof raw['command-panel'] === 'object' && !Array.isArray(raw['command-panel'])) {
                const cp = raw['command-panel'];
                if (cp.collections && typeof cp.collections === 'object' && !Array.isArray(cp.collections)) {
                    this.data['command-panel'] = { collections: cp.collections };
                } else if (cp.panelId) {
                    // 旧版单面板格式：迁移为 addon 集合
                    this.data['command-panel'] = {
                        collections: {
                            addon: { panelId: cp.panelId || null, items: Array.isArray(cp.items) ? cp.items : [] }
                        }
                    };
                }
            }
        } catch (e) {
            // 首次运行没有状态文件，使用空状态
        }
    }

    save() {
        const tmp = this.file + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
            fs.renameSync(tmp, this.file);
        } catch (e) {
            log.error('[HuHoBotPenguin] 状态写入失败：' + e.message);
        }
    }

    // ---- 手动管理员 ----

    _manualAdmins(group) {
        if (!this.data.administrators[group]) this.data.administrators[group] = [];
        return this.data.administrators[group];
    }

    listAdmins(group) {
        return this.data.administrators[group] || [];
    }

    containsManualAdmin(group, openid) {
        return this._manualAdmins(group).includes(openid);
    }

    addAdmin(group, openid) {
        const list = this._manualAdmins(group);
        if (!list.includes(openid)) {
            list.push(openid);
            this.save();
        }
    }

    removeAdmin(group, openid) {
        const list = this._manualAdmins(group);
        const index = list.indexOf(openid);
        if (index !== -1) {
            list.splice(index, 1);
            this.save();
        }
    }

    /** openid 是否在 手动管理员 + admin.openids 配置 的并集中。 */
    isManualAdmin(group, openid) {
        if (this.cfg.getList('admin.openids').includes(openid)) return true;
        return this.containsManualAdmin(group, openid);
    }

    // ---- 认证用户 ----

    _authenticated(group) {
        if (!this.data['authenticated-users'][group]) this.data['authenticated-users'][group] = [];
        return this.data['authenticated-users'][group];
    }

    isAuthenticated(group, openid) {
        return this._authenticated(group).includes(openid);
    }

    authenticate(group, openid) {
        const list = this._authenticated(group);
        if (!list.includes(openid)) {
            list.push(openid);
            this.save();
        }
    }

    revoke(group, openid) {
        const list = this._authenticated(group);
        const index = list.indexOf(openid);
        if (index !== -1) {
            list.splice(index, 1);
            this.save();
        }
    }

    // ---- 管理方式（每群覆盖，缺省取配置 admin.mode） ----

    mode(group) {
        const stored = this.data['administrator-modes'][group];
        if (stored && isValidMode(stored)) return stored;
        return mapConfigMode(this.cfg.getString('admin.mode', 'both'));
    }

    setMode(group, mode) {
        this.data['administrator-modes'][group] = mode;
        this.save();
    }

    /** 以角色 + 管理方式判定是否管理员（对齐 CommandSupport.requireAdmin）。 */
    isAdmin(group, openid, role) {
        const mode = this.mode(group);
        const roleOk = role === 'owner' || role === 'admin';
        const manualOk = this.isManualAdmin(group, openid);
        if (mode === MODE_QQ) return roleOk;
        if (mode === MODE_MANUAL) return manualOk;
        return roleOk || manualOk;
    }

    // ---- 全量转发（每群覆盖，缺省取配置 features.full-amount） ----

    isFullForwarding(group) {
        const value = this.data['full-forwarding'][group];
        if (value !== undefined) return !!value;
        return this.cfg.getBool('features.full-amount', false);
    }

    setFullForwarding(group, enabled) {
        this.data['full-forwarding'][group] = !!enabled;
        this.save();
    }

    // ---- 白名单绑定（QQ OpenID ⇄ 游戏名）：自助绑定 / 管理员解绑 ----

    _bindings(group) {
        if (!this.data.bindings) this.data.bindings = {};
        if (!this.data.bindings[group] || typeof this.data.bindings[group] !== 'object') {
            this.data.bindings[group] = {};
        }
        return this.data.bindings[group];
    }

    /** 查询 openid 在该群绑定的游戏名，无绑定返回 null。 */
    getBindingName(group, openid) {
        const groupMap = this.data.bindings && this.data.bindings[group];
        return groupMap && groupMap[openid] ? String(groupMap[openid]) : null;
    }

    bindName(group, openid, gameName) {
        this._bindings(group)[openid] = String(gameName);
        this.save();
        return String(gameName);
    }

    /** 解除 openid 在该群的绑定，返回原游戏名（无绑定返回 null）。 */
    unbindOpenid(group, openid) {
        const groupMap = this.data.bindings && this.data.bindings[group];
        if (!groupMap || !groupMap[openid]) return null;
        const gameName = String(groupMap[openid]);
        delete groupMap[openid];
        this.save();
        return gameName;
    }

    /** 按游戏名反查绑定它的 OpenID（管理员手动解绑用），未找到返回 null。 */
    findOpenidByGameName(group, gameName) {
        const groupMap = this.data.bindings && this.data.bindings[group];
        if (!groupMap) return null;
        const key = String(gameName).toLowerCase();
        for (const [openid, stored] of Object.entries(groupMap)) {
            if (String(stored).toLowerCase() === key) return openid;
        }
        return null;
    }
}

module.exports = { State, MODE_QQ, MODE_MANUAL, MODE_BOTH, mapConfigMode, isValidMode };