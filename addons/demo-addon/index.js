'use strict';

/**
 * DemoAddon — HuHoBotPenguin 附属插件测试样例（addons 目录模式）。
 *
 * 部署：把本目录整个放到 plugins/HuHoBotPenguin-LLSE/addons/demo-addon/
 * （或 Llama 版 plugins/HuHoBotPenguin-LLSE-Llama/addons/demo-addon/），重启即可。
 * 也可以直接放一个单文件 addons/demo-addon.js。
 *
 * 无需 manifest.json、无需声明依赖——主插件加载自身 API 后才加载附属插件，
 * 天然没有加载顺序问题。改代码后执行 huhobot reload 立即生效。
 */

module.exports = function (addon) {
    // addon.logger 自带 [demo-addon] 前缀；addon.* 即全部开放 API（自动随插件卸载注销）
    let msgCount = 0;

    addon.onReady(({ version }) => {
        addon.logger.info('HuHoBotPenguin v' + version + ' 网关已就绪，DemoAddon 生效');
    });

    addon.onRecvMsg((msg) => {
        msgCount++;
        if (msgCount % 10 === 0) {
            addon.logger.info('已处理 ' + msgCount + ' 条群消息（最新发送者：' +
                (msg.sender.username || msg.sender.id || '?') + '）');
        }
    });

    // 群里发 demo → 游戏内 say 广播（pushMenu=true 验证指令面板同步）
    addon.registerBotCommand('demo', 'say demo-addon 工作正常！触发者：{user}', 0, true);
    addon.onBotCommand((msg) => {
        if (msg.commandKey === 'demo') {
            addon.logger.info('运行时命令 demo 被 ' + (msg.sender.username || '?') + ' 触发');
        }
    });

    // 群里发 demo测试 → 被动回复
    addon.registerRegexCommand('^demo测试$', '', (msg, match, event) => {
        event.replyText('✓ DemoAddon 工作正常（HuHoBotPenguin v' + addon.getVersion() +
            '，消息计数：' + (msgCount + 1) + '）');
    });

    addon.onUnload(() => {
        addon.logger.info('已卸载');
    });

    addon.logger.info('已加载——群内发送 demo 或 demo测试 进行测试');
};
