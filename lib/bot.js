'use strict';

/**
 * HuHoBot 门面：承载 auditText / sendCommand / 消息格式化，供各模块引用。
 * 对应 Java 版 HuHoBot interface + QClient。
 */

const log = typeof logger !== 'undefined' ? logger : console;

class Bot {
    /**
     * @param {object} config   Config 门面
     * @param {object} state    State 实例
     * @param {object} qqclient QQClient 实例
     * @param {object} custom   CustomCommands 实例
     */
    constructor(config, state, qqclient, custom) {
        this.config = config;
        this.state = state;
        this.qqclient = qqclient;
        this.custom = custom;

        const { audit } = require('./filter');
        this._audit = audit;
    }

    /** 正则 + 敏感词 + AI 二审，返回 Promise<string>。 */
    auditText(text) {
        return this._audit(String(text == null ? '' : text), this.config);
    }

    /** 执行 BDS 控制台命令，返回 { success, output }（LLSE runcmdEx 同步返回）。 */
    sendCommand(command) {
        if (typeof mc === 'undefined' || !mc.runcmdEx) {
            log.error('[HuHoBotPenguin] mc.runcmdEx 不可用，无法执行命令：' + command);
            return { success: false, output: '' };
        }
        const raw = mc.runcmdEx(command);
        if (raw && typeof raw === 'object') {
            const success = raw.success !== undefined ? raw.success : !!raw.status;
            return { success: !!success, output: String(raw.output || '') };
        }
        return { success: false, output: String(raw || '') };
    }

    /** 广播消息到游戏大厅（不取消原消息，仅转发）。 */
    broadcast(message) {
        try {
            if (typeof mc !== 'undefined' && mc.broadcast) mc.broadcast(String(message));
        } catch (e) {
            log.error('[HuHoBotPenguin] mc.broadcast 失败：' + e.message);
        }
    }

    formatGameMessage(name, message) {
        const format = this.config.getString('chat-format.from-game', '[游戏] {name}: {message}');
        return format.replace(/{name}/g, String(name)).replace(/{message}/g, String(message));
    }

    formatGroupMessage(name, message) {
        const format = this.config.getString('chat-format.from-group', '[QQ] {name}: {message}');
        return format.replace(/{name}/g, String(name)).replace(/{message}/g, String(message));
    }

    /** 发送游戏消息到所有已配置群。 */
    sendToAllGroups(content) {
        const groups = this.config.getList('bot.groups');
        for (const groupId of groups) {
            this.qqclient.sendGroupMessage(groupId, content);
        }
    }
}

module.exports = { Bot };