'use strict';

/**
 * 自定义命令：对齐 Java CustomCommandRegistry。
 * 配置形如 { "key": "某某", "command": "say {params}", "permission": 0 }
 * permission > 0 的命令只能由管理员执行（管理员执行）。
 * 占位符：{params} 全部参数、{group} 群 OpenID、{user} 用户 OpenID、
 *         {0}/{1}... 第 N 个参数、&0/&1... 同义。
 */

const log = typeof logger !== 'undefined' ? logger : console;

function renderCommand(command, params, groupId, userId, prefix) {
    const tokens = String(params || '').trim().split(/\s+/).filter(Boolean);
    let out = String(command);
    out = out.split('{params}').join(params);
    out = out.split('{group}').join(groupId);
    out = out.split('{user}').join(userId);
    if (prefix) out = out.split('{prefix}').join(prefix);
    tokens.forEach((token, index) => {
        out = out.split('{' + index + '}').join(token);
        out = out.split('&' + index).join(token);
    });
    return out;
}

class CustomCommands {
    constructor(cfg) {
        this.cfg = cfg;
        this.list = [];
        this.reload();
    }

    reload() {
        this.list = [];
        for (const item of this.cfg.getList('custom-commands')) {
            if (!item || typeof item !== 'object') continue;
            const key = String(item.key || '').trim();
            const command = String(item.command || '').trim();
            const permission = Number.isInteger(item.permission)
                ? item.permission
                : (parseInt(item.permission, 10) || 0);
            if (!key || !command) {
                log.warn('[HuHoBotPenguin] 忽略缺少 key 或 command 的自定义命令配置');
                continue;
            }
            this.list.push({ key, command, permission });
        }
    }

    find(key) {
        return this.list.find((item) => item.key === String(key || '').trim()) || null;
    }

    /** 执行：仅权限为 0 的命令可被普通成员使用。 */
    resolveRun(key) {
        const item = this.find(key);
        if (!item || item.permission > 0) return null;
        return item;
    }

    /** 管理员执行：任意权限。 */
    resolveAdminRun(key) {
        return this.find(key);
    }
}

module.exports = { CustomCommands, renderCommand };