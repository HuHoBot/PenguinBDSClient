'use strict';

/**
 * HuHoBotPenguin 入口（LLSE Node 后端）。
 * 启动：读配置 → 读状态 → 注册 onChat → 启动 QQ 网关。
 * 控制台命令：huhobot reload（重载配置并重启机器人）/ huhobot info（查看版本信息）。
 * unload：停止网关、清理定时器。
 */

const configLoader = require('./lib/config');
const { State } = require('./lib/state');
const { QQClient } = require('./lib/qqclient');
const { CustomCommands } = require('./lib/customcommands');
const { handleGroupMessage } = require('./lib/commands');
const { Bot } = require('./lib/bot');
const { getSharedAdapter } = require('./lib/adapter');
const { AddonManager } = require('./lib/addonmanager');
const { TickMonitor } = require('./lib/tickmonitor');

const log = typeof logger !== 'undefined' ? logger : console;

let bot = null;
let runtime = null;

/** 插件版本（读取 manifest.json）。 */
const VERSION = (() => {
    try {
        return require('./manifest.json').version || 'unknown';
    } catch (e) {
        return 'unknown';
    }
})();

/** 环境探针（debug.probe=true 时输出，用于排查节点后端/TLS 出口）。 */
async function runProbe() {
    log.info('[probe] process.version = ' + process.version);
    log.info('[probe] typeof mc = ' + typeof mc + '，typeof ll = ' + typeof ll);
    log.info('[probe] mc.runcmdEx = ' + typeof mc.runcmdEx + '，mc.broadcast = ' + typeof mc.broadcast);
    log.info('[probe] crypto/tls/net 模块 = ' +
        [typeof require('crypto'), typeof require('tls'), typeof require('net')].join(' / '));

    const tls = require('tls');
    await new Promise((resolve) => {
        const sock = tls.connect({ host: 'api.sgroup.qq.com', port: 443 }, () => {
            log.info('[probe] TLS 出口到 api.sgroup.qq.com:443 OK，加密套件=' + (sock.getCipher() && sock.getCipher().name));
            sock.destroy();
            resolve();
        });
        sock.on('error', (err) => {
            log.error('[probe] TLS 出口连接失败：' + err.message);
            resolve();
        });
        sock.setTimeout(5000, () => {
            log.error('[probe] TLS 出口连接超时');
            sock.destroy();
            resolve();
        });
    });
}

function main() {
    const config = configLoader.load();

    if (config.getBool('debug.probe', false)) {
        runProbe().catch((e) => log.error('[probe] 探针执行出错：' + e.message));
    }

    const appId = config.getString('bot.app-id', '');
    const secret = config.getString('bot.secret', '');
    if (!appId || !secret) {
        log.warn('[HuHoBotPenguin] 未配置 bot.app-id / bot.secret，QQ 机器人未启动。请编辑 plugins/HuHoBotPenguin-LLSE/config.json');
        return null;
    }

    const state = new State(config);
    const custom = new CustomCommands(config);
    const client = new QQClient(config);
    bot = new Bot(config, state, client, custom);

    // 附属插件开放 API（globalThis 单例，reload 后引用不失效）
    const adapter = getSharedAdapter();
    adapter.attachBot(bot);
    adapter.setVersion(VERSION);
    bot.adapter = adapter;
    
    // 启动时打印群白名单状态，帮助定位问题
    const groups = config.getList('bot.groups');
    log.info('[HuHoBotPenguin] 群白名单配置：' + (groups.length === 0 ? '未配置（允许所有群）' : '已配置 ' + groups.length + ' 个群：' + JSON.stringify(groups)));

    client.on('groupMessage', (message) => handleGroupMessage(bot, message));
    client.on('ready', () => adapter.fireReady());
    client.on('privateMessage', (message) => adapter.firePrivateMsg(message));
    client.on('joinRequest', (request) => adapter.fireJoinRequest(request));

    // addons/ 目录附属插件加载（SparkBridge3 模式；features.load-addons 默认开）
    const addonMgr = new AddonManager(adapter, configLoader.root ? configLoader.root() : process.cwd());
    if (addonMgr.isEnabled(config)) addonMgr.loadAll();

    // 游戏 → QQ：转发以 chat-format.start-with 开头（默认 #）的游戏聊天到所有已配置群。
    // 同时导出 ll.exports("HuHoBotPenguin","send") 供 LuckyClover 等插件调用——
    // 两路共用 forwardGameMessage，并有 1.5s 去重，避免同一条消息双发。
    // 去重表挂在共享作用域上：热重载期间多实例并存时也不会双发。
    const recentForwards = globalScope.__huohoBotPenguinRecentForwards ||
        (globalScope.__huohoBotPenguinRecentForwards = []);
    function forwardGameMessage(playerName, rawMsg) {
        if (!bot) return;
        const startWith = config.getString('chat-format.start-with', '');
        const raw = String(rawMsg || '');
        if (!raw || (startWith && !raw.startsWith(startWith))) return;
        const content = startWith ? raw.slice(startWith.length) : raw;
        const key = String(playerName || '') + '\n' + content;
        const now = Date.now();
        while (recentForwards.length && now - recentForwards[0].ts > 1500) recentForwards.shift();
        if (recentForwards.some((e) => e.key === key)) return;
        recentForwards.push({ key, ts: now });

        bot.auditText(content).then((filtered) => {
            bot.sendToAllGroups(bot.formatGameMessage(playerName, filtered));
        });
    }

    const onChatHandle = mc.listen('onChat', (player, msg) => {
        if (!aliveFlag.alive) return; // 旧实例监听器（引擎未移除时）自禁用
        forwardGameMessage(player && player.name, msg);
    });

    // 进服/退服通知 → 群（前缀 + 🟢/🔴 + 玩家名；前缀=serverName，缺省回退 bot.name）
    const serverName = config.getString('serverName', '') || config.getString('bot.name', 'HuHoBot');
    // 进退服跨实例去重：热重载后旧监听器若未被引擎移除，同一条事件会被处理两次
    const recentJoins = globalScope.__huohoBotPenguinRecentJoins ||
        (globalScope.__huohoBotPenguinRecentJoins = []);
    function notifyJoinLeave(player, isJoin) {
        if (!aliveFlag.alive) return; // 旧实例监听器自禁用
        if (!bot || !config.getBool('join-leave.enabled', true)) return;
        const name = (player && player.name) || '未知';
        const now = Date.now();
        const key = (isJoin ? 'join|' : 'leave|') + name;
        while (recentJoins.length && now - recentJoins[0].ts > 2000) recentJoins.shift();
        if (recentJoins.some((e) => e.key === key)) return;
        recentJoins.push({ key, ts: now });
        const fmtKey = isJoin ? 'join-leave.join-format' : 'join-leave.leave-format';
        const defFmt = isJoin ? '[{server}] 🟢{name}进入服务器' : '[{server}] 🔴{name}退出服务器';
        const text = config.getString(fmtKey, defFmt)
            .replace(/{server}/g, serverName)
            .replace(/{name}/g, name);
        bot.sendToAllGroups(text);
    }
    const onPlayerJoinHandle = mc.listen('onJoin', (player) => notifyJoinLeave(player, true));
    const onPlayerLeftHandle = mc.listen('onLeft', (player) => notifyJoinLeave(player, false));

    // TPS/MSPT 统计（查在线命令输出用；onTick 不可用时静默降级）
    const tickMonitor = new TickMonitor();
    bot.tick = tickMonitor;
    tickMonitor.start();

    // 实例存活标志：stopRuntime 时置 false，旧监听器即使未被引擎移除也会自禁用
    const aliveFlag = { alive: true };

    client.start();
    log.info('[HuHoBotPenguin] HuHoBot Penguin 已加载（v' + VERSION + '）');

    // 内置命令同步到 QQ 指令面板（features.push-menu，默认开；异步不阻塞启动）
    if (config.getBool('features.push-menu', true)) {
        adapter.panel.syncBuiltins();
    }

    if (typeof ll.exports === 'function') {
        try {
            // 通过 globalThis 委托到当前实例：热重载后旧注册的导出依然路由到新实例
            globalScope.__huohoBotPenguinForward = (playerName, rawMsg) => forwardGameMessage(String(playerName || ''), String(rawMsg || ''));
            ll.exports((playerName, rawMsg) => {
                const fwd = globalScope.__huohoBotPenguinForward;
                if (fwd) fwd(playerName, rawMsg);
            }, 'HuHoBotPenguin', 'send');
            log.info('[HuHoBotPenguin] 已导出桥接接口：ll.imports("HuHoBotPenguin","send")(玩家名, 原始消息)');
            registerAdapterExports(adapter);
        } catch (e) {
            // 导出失败（如 reload 时同名导出已存在）不影响本插件自身功能
            log.warn('[HuHoBotPenguin] ll.exports 注册失败（不影响自身功能）：' + (e && e.message || e));
        }
    }

    return { client, onChatHandle, onPlayerJoinHandle, onPlayerLeftHandle, tickMonitor, addonMgr, aliveFlag };
}

/**
 * 注册附属插件开放 API 导出（命名空间 "HuHoBotPenguin"），对齐 Java 版适配器公共 API。
 * 回调签名：onRecvMsg / onBotCommand → fn(msgPack, event)；event.replyText/replyMarkdown/setCancelled。
 */
function registerAdapterExports(adapter) {
    const ns = 'HuHoBotPenguin';
    ll.exports((fn) => adapter.onRecvMsg(fn), ns, 'onRecvMsg');
    ll.exports((id) => adapter.offRecvMsg(id), ns, 'offRecvMsg');
    ll.exports((fn) => adapter.onBotCommand(fn), ns, 'onBotCommand');
    ll.exports((id) => adapter.offBotCommand(id), ns, 'offBotCommand');
    ll.exports((key, command, permission, pushMenu) => adapter.registerBotCommand(key, command, permission, pushMenu), ns, 'registerBotCommand');
    ll.exports((key) => adapter.unregisterBotCommand(key), ns, 'unregisterBotCommand');
    ll.exports((groupOpenId, openId) => adapter.getAuthenticatedQq(groupOpenId, openId), ns, 'getAuthenticatedQq');
    ll.exports((groupOpenId, openId) => adapter.getBindingName(groupOpenId, openId), ns, 'getBindingName');
    ll.exports((groupOpenId, text, msgId) => adapter.sendGroupText(groupOpenId, text, msgId), ns, 'sendGroupText');
    ll.exports((groupOpenId, markdown, msgId) => adapter.sendGroupMarkdown(groupOpenId, markdown, msgId), ns, 'sendGroupMarkdown');
    ll.exports((text) => adapter.sendAllGroupsText(text), ns, 'sendAllGroupsText');
    ll.exports((markdown) => adapter.sendAllGroupsMarkdown(markdown), ns, 'sendAllGroupsMarkdown');
    ll.exports((fn) => adapter.onReady(fn), ns, 'onReady');
    ll.exports((id) => adapter.offReady(id), ns, 'offReady');
    ll.exports((fn) => adapter.onPrivateMsg(fn), ns, 'onPrivateMsg');
    ll.exports((id) => adapter.offPrivateMsg(id), ns, 'offPrivateMsg');
    ll.exports((fn) => adapter.onJoinRequest(fn), ns, 'onJoinRequest');
    ll.exports((id) => adapter.offJoinRequest(id), ns, 'offJoinRequest');
    ll.exports((pattern, flags, handler) => adapter.registerRegexCommand(pattern, flags, handler), ns, 'registerRegexCommand');
    ll.exports((id) => adapter.unregisterRegexCommand(id), ns, 'unregisterRegexCommand');
    ll.exports(() => adapter.getVersion(), ns, 'getVersion');
    ll.exports(() => adapter.getGroups(), ns, 'getGroups');
    ll.exports((groupOpenId, openId) => adapter.isAdmin(groupOpenId, openId), ns, 'isAdmin');
    ll.exports(() => adapter.getBotInfo(), ns, 'getBotInfo');
    ll.exports((userOpenId, text, msgId) => adapter.sendPrivateText(userOpenId, text, msgId), ns, 'sendPrivateText');
    ll.exports((g, m, d) => adapter.muteMember(g, m, d), ns, 'muteMember');
    ll.exports((g, m) => adapter.unmuteMember(g, m), ns, 'unmuteMember');
    ll.exports((g, c, l) => adapter.getJoinRequests(g, c, l), ns, 'getJoinRequests');
    ll.exports((g, m, o) => adapter.approveJoinRequest(g, m, o), ns, 'approveJoinRequest');
    ll.exports((n, v, d, a) => adapter.registerAddon(n, v, d, a), ns, 'registerAddon');
    ll.exports((n) => adapter.unregisterAddon(n), ns, 'unregisterAddon');
    ll.exports(() => adapter.getAddons(), ns, 'getAddons');
    log.info('[HuHoBotPenguin] 已导出附属插件 API（namespace="HuHoBotPenguin"）：' +
        'onRecvMsg/onBotCommand/onReady/onPrivateMsg/onJoinRequest/registerBotCommand/registerRegexCommand/' +
        'getAuthenticatedQq/isAdmin/getBotInfo/sendGroupText/sendPrivateText/muteMember/approveJoinRequest 等');
}
/** 停止当前运行实例：关网关、移除监听。幂等。返回是否实际停止了实例。 */
function stopRuntime() {
    if (!runtime) return false;
    // 先卸载 addons/ 目录附属插件（撤销其监听器/命令/元数据），再走标准停止流程
    if (runtime.addonMgr) {
        try { runtime.addonMgr.unloadAll(); } catch (e) { /* ignore */ }
    }
    // 先自禁用旧监听器（mc.removeListener 在部分引擎上无效，靠标志位兜底）
    if (runtime.aliveFlag) runtime.aliveFlag.alive = false;
    if (runtime.client) runtime.client.stop();
    if (runtime.onChatHandle) {
        try { mc.removeListener(runtime.onChatHandle); } catch (e) { /* ignore */ }
    }
    if (runtime.onPlayerJoinHandle) {
        try { mc.removeListener(runtime.onPlayerJoinHandle); } catch (e) { /* ignore */ }
    }
    if (runtime.onPlayerLeftHandle) {
        try { mc.removeListener(runtime.onPlayerLeftHandle); } catch (e) { /* ignore */ }
    }
    if (runtime.tickMonitor) runtime.tickMonitor.stop();
    runtime = null;
    bot = null;
    return true;
}

/** 启动新实例（重载时用）。 */
function startRuntime() {
    runtime = main();
}

/** 控制台命令处理：huhobot reload / huhobot info。 */
function handleConsoleCommand(args) {
    const sub = String((args && args[0]) || '').toLowerCase();
    if (sub === 'reload') {
        log.info('[HuHoBotPenguin] 正在重载配置…');
        stopRuntime();
        startRuntime();
        return '已重载配置文件。';
    }
    if (sub === 'info') {
        return '平台：LeviLamina（LLSE Node.js 后端）\n版本：v' + VERSION + '\n模式：直连 QQ 正式环境';
    }
    if (sub === 'addons') {
        if (!runtime || !runtime.addonMgr) return '附属插件加载器未运行';
        const names = runtime.addonMgr.getNames();
        return names.length
            ? '已加载附属插件（' + names.length + ' 个）：' + names.join('、')
            : '未加载任何附属插件（addons 目录为空或不存在）';
    }
    return '用法：huhobot reload | huhobot info | huhobot addons';
}

/**
 * 注册控制台命令。优先 mc.regConsoleCmd（标准 API，签名：regConsoleCmd(cmd, description, callback)，
 * 回调 function(args)，args 为参数数组）；若不存在（旧版引擎）回退 mc.listen("onConsoleCmd") 前缀匹配。
 * 注意：回调内绝不调用 mc.runcmd(Ex)，避免 LLSE 文档指出的 onConsoleCmd 内执行后台指令死循环。
 */
function registerConsoleCommands() {
    if (typeof mc !== 'undefined' && typeof mc.regConsoleCmd === 'function') {
        try {
            mc.regConsoleCmd('huhobot', 'HuHoBotPenguin 插件控制台命令（reload 重载配置 / info 查看信息）', (args) => {
                const argsArr = Array.isArray(args) ? args : [];
                const text = handleConsoleCommand(argsArr);
                log.info('[HuHoBotPenguin] ' + text);
                return true;
            });
            log.info('[HuHoBotPenguin] 已注册控制台命令：huhobot reload | huhobot info');
            return;
        } catch (e) {
            log.warn('[HuHoBotPenguin] 注册 huhobot 控制台命令失败，回退事件监听：' + e.message);
        }
    }
    if (typeof mc !== 'undefined' && typeof mc.listen === 'function') {
        try {
            mc.listen('onConsoleCmd', (cmd) => {
                const text = String(cmd || '').trim();
                if (!text.toLowerCase().startsWith('huhobot')) return;
                const args = text.split(/\s+/).slice(1);
                log.info('[HuHoBotPenguin] ' + handleConsoleCommand(args));
            });
        } catch (e) {
            log.warn('[HuHoBotPenguin] 注册 huhobot 控制台命令失败：' + e.message);
        }
    }
}

// 入口文件每被引擎加载一次即执行一次注册与启动。
// 热重载防护：LSE 热重载不保证触发旧实例的 onUnload，且新上下文的 globalThis 与
// 旧上下文隔离 —— 注册表挂在 process 上（同一 Node 进程内跨上下文可见）。
// 逐个停掉注册表里的全部旧实例（可能存在多个孤儿），避免双网关连接导致消息双发。
const globalScope = (typeof process !== 'undefined' && process) ||
    (typeof globalThis !== 'undefined' ? globalThis : global);
const STOPPERS_KEY = '__huohoBotPenguinStoppers';
const stopperRegistry = Array.isArray(globalScope[STOPPERS_KEY]) ? globalScope[STOPPERS_KEY] : (globalScope[STOPPERS_KEY] = []);
let stoppedOrphans = 0;
for (const stop of stopperRegistry.splice(0)) {
    try {
        if (stop()) stoppedOrphans++;
    } catch (e) {
        log.warn('[HuHoBotPenguin] 停止旧运行实例失败：' + (e && e.message || e));
    }
}
if (stoppedOrphans > 0) {
    log.warn('[HuHoBotPenguin] 已停止 ' + stoppedOrphans + ' 个未卸载的旧运行实例（防止双连接/消息双发）');
}

registerConsoleCommands();
startRuntime();

// 记录本实例的停止函数，供下一次热重载时清理
stopperRegistry.push(stopRuntime);

// 新 LSE（LeviLamina 时代）插件注册完全走 manifest.json，无需 ll.registerPlugin。
if (typeof ll !== 'undefined' && ll.onUnload) {
    ll.onUnload(() => {
        stopRuntime();
        const idx = stopperRegistry.indexOf(stopRuntime);
        if (idx !== -1) stopperRegistry.splice(idx, 1);
        log.info('[HuHoBotPenguin] 插件已卸载');
    });
}
