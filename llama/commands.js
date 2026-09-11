'use strict';

/**
 * Llama 版 commands：注册 AI Agent 兜底处理器，再复用公共 commands。
 * 未命中任何内置命令/全量转发的消息会交给 Agent 处理。
 */

const { registerFallbackHandler } = require('./lib/commands');

const log = typeof logger !== 'undefined' ? logger : console;

registerFallbackHandler(function agentFallback(bot, message) {
    if (!bot.agent || !bot.agent.isEnabled()) return false;

    const ctx = {
        bot,
        msgId: message.id,
        groupId: message.groupId,
        userId: message.userId,
        username: message.username,
        memberRole: message.memberRole,
        content: String(message.content || '')
    };
    const msgId = message.id;
    const groupId = message.groupId;

    bot.agent.handleMessage(bot, ctx).then((aiReply) => {
        if (aiReply) {
            bot.qqclient.sendGroupMessage(groupId, aiReply, msgId);
        }
    }).catch((e) => {
        log.error('[HuHoBotPenguin] AI Agent 处理失败：' + (e && e.message || e));
    });
    return true; // AI 接管
});

module.exports = require('./lib/commands');
