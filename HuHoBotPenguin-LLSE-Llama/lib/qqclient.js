'use strict';

/**
 * QQ 开放平台 WebSocket 网关客户端。
 * - access_token：POST bots.qq.com/app/getAppAccessToken（7200s 内提前 60s 刷新，刷新串行化）
 * - 网关地址：GET api.bot.qq.com/gateway
 * - Identify(op2)：intents = 1<<25（GROUP_AND_C2C_EVENT），不多订任何位
 * - 群消息：GROUP_AT_MESSAGE_CREATE（@消息）+ GROUP_MESSAGE_CREATE（开"接收群内全部消息"后的全量消息，字段一致）
 * - 心跳(op1)/断线重连 走 wsc 重建；优先 Resume(op6)，失败/服务端要求再新 Identify
 * - 发消息：POST api.bot.qq.com/v2/groups/{group_openid}/messages，串行小队列防限频
 */

const https = require('https');
const { EventEmitter } = require('events');
const WSC = require('./wsc');

const log = typeof logger !== 'undefined' ? logger : console;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;
const OP_INVALID_SESSION = 9;

const INTENTS_GROUP_AND_C2C = 1 << 25;
const TOKEN_REFRESH_LEAD = 60 * 1000; // 提前 60s 刷新
const MAX_RECONNECT_DELAY = 30 * 1000;
const SEND_GAP_MS = 500; // 发消息串行队列的节流间隔

function requestJson({ host, path: requestPath, method = 'GET', headers = {}, body, label = requestPath }) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: host,
                port: 443,
                path: requestPath,
                method,
                headers,
                timeout: 15000
            },
            (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsed = JSON.parse(data);
                            // token 接口失败也可能以 HTTP 200 返回 {code:!, message}，此处兜底
                            if (parsed && parsed.code !== undefined && parsed.code !== 0) {
                                reject(new Error(label + ' 返回错误码 ' + parsed.code + '：' + (parsed.message || data.slice(0, 200))));
                                return;
                            }
                            resolve(parsed);
                        } catch (e) {
                            reject(new Error(label + ' 响应非 JSON：' + data.slice(0, 200)));
                        }
                    } else {
                        reject(new Error(label + ' HTTP ' + res.statusCode + '：' + data.slice(0, 300)));
                    }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error(label + ' 请求超时')));
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class QQClient extends EventEmitter {
    /**
     * @param {object} cfg Config 门面（config.js 的 Config）
     */
    constructor(cfg) {
        super();
        this.cfg = cfg;
        this.appId = cfg.getString('bot.app-id', '');
        this.secret = cfg.getString('bot.secret', '');
        this.botName = cfg.getString('bot.name', 'HuHoBot');
        // 发布版固定使用正式环境（机器人需提审上线后才收得到群事件）
        this.backendHost = 'api.bot.qq.com';

        this.accessToken = null;
        this.tokenExpireAt = 0;
        this.tokenPromise = null;

        this.ws = null;
        this.connected = false;
        this.ready = false;
        this.lastSeq = null;
        this.sessionId = null;
        this.firstConnect = true;

        this.heartbeatTimer = null;
        this.ackTimer = null;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;

        this.recentIds = [];       // 去重，保留最近 200 条
        this.sendQueue = Promise.resolve();
        this.stopped = false;
    }

    start() {
        this.stopped = false;
        this.firstConnect = true;
        this._connectFlow().catch((err) => {
            log.error('[HuHoBotPenguin] 首次连接失败：' + err.message);
            this._scheduleReconnect();
        });
    }

    stop() {
        this.stopped = true;
        this._clearTimers();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            log.info('[HuHoBotPenguin] 正在关闭 QQ 网关连接…');
            try {
                this.ws.close(1000, 'shutdown');
            } catch (e) { /* ignore */ }
            this.ws = null;
        }
        this.connected = false;
        this.ready = false;
    }

    // ---- 连接流程 ----

    async _connectFlow() {
        let token;
        try {
            token = await this.getAccessToken();
        } catch (err) {
            throw new Error('获取 access_token 失败（检查 bot.app-id / bot.secret）' + '：' + err.message);
        }
        log.info('[HuHoBotPenguin] 环境：正式，后端 ' + this.backendHost + '。机器人需提审上线后才能在正式环境收到群事件');
        let url;
        try {
            url = await requestJson({
                host: this.backendHost,
                path: '/gateway',
                headers: {
                    'Authorization': 'QQBot ' + token,
                    'X-Union-Appid': this.appId
                },
                label: 'gateway'
            }).then((r) => r.url);
        } catch (err) {
            throw new Error('获取网关地址失败：' + err.message);
        }
        if (this.stopped) return;
        if (!url) throw new Error('网关地址为空');
        log.info('[HuHoBotPenguin] 网关地址：' + url);
        this.reconnectAttempt = 0;
        this._openSocket(url, token);
    }

    _openSocket(url, token) {
        this._clearTimers();

        let ws;
        try {
            ws = new WSC(url, {
                connectTimeout: 15000,
                headers: {
                    'Authorization': 'QQBot ' + (token || ''),
                    'X-Union-Appid': this.appId
                }
            });
        } catch (e) {
            log.error('[HuHoBotPenguin] 网关地址非法：' + e.message);
            return this._scheduleReconnect();
        }
        this.ws = ws;

        ws.on('open', () => this._onOpen(ws));
        ws.on('message', (data) => this._onMessage(ws, data));
        ws.on('close', (code, reason) => this._onClose(ws, code, reason));
        ws.on('error', (err) => this._onError(err));
        ws.connect();
    }

    async _onOpen(ws) {
        if (ws !== this.ws) return;
        this.connected = true;
        this.ackTimer = null;

        const token = await this.getAccessToken().catch(() => null);
        if (!token) {
            log.error('[HuHoBotPenguin] 无法获取 access_token，用于 Identify/Resume');
            ws.close(1000, 'no-token');
            return;
        }

        // 已有会话且非被踢 → 尝试 Resume；否则全新 Identify
        if (this.sessionId && !this.firstConnect) {
            log.info('[HuHoBotPenguin] 尝试 Resume 已断开会话…');
            ws.send(JSON.stringify({
                op: OP_RESUME,
                d: { token: 'QQBot ' + token, session_id: this.sessionId, seq: this.lastSeq }
            }));
        } else {
            ws.send(JSON.stringify({
                op: OP_IDENTIFY,
                d: {
                    token: 'QQBot ' + token,
                    intents: INTENTS_GROUP_AND_C2C,
                    shard: [0, 1],
                    properties: {
                        $os: process.platform || 'linux',
                        $browser: this.botName + ' (LLSE)',
                        $device: this.botName + ' (LLSE)'
                    }
                }
            }));
        }
    }

    _onMessage(ws, data) {
        if (ws !== this.ws) return;
        let payload;
        try {
            payload = JSON.parse(data);
        } catch (e) {
            log.warn('[HuHoBotPenguin] 收到非法 JSON 帧：' + data.slice(0, 200));
            return;
        }

        const op = payload.op;
        if (op === OP_HELLO) {
            this._onHello(ws, payload.d);
        } else if (op === OP_HEARTBEAT_ACK) {
            this._onHeartbeatAck();
        } else if (op === OP_INVALID_SESSION) {
            this._onInvalidSession(ws, payload.d);
        } else if (op === OP_DISPATCH) {
            this._onDispatch(payload);
        } else if (op === OP_RECONNECT) {
            log.warn('[HuHoBotPenguin] 服务端要求重连（op7）');
            ws.close(4000, 'server-reconnect');
        } else {
            log.debug('[HuHoBotPenguin] 未处理 op=' + op);
        }
    }

    _onClose(ws, code, reason) {
        if (ws !== this.ws) return;
        const wasReady = this.ready;
        this._clearTimers();
        this.connected = false;
        this.ready = false;

        // 心跳超时/被服务端断开(code 非 1000)时保留 sessionId 以便 Resume
        const cleanShutdown = this.stopped || code === 1000;
        log.warn('[HuHoBotPenguin] 网关连接断开：code=' + code + ' reason=' + (reason || '-') + (wasReady ? '（将重连）' : ''));

        if (!cleanShutdown) {
            this._scheduleReconnect();
        }
    }

    _onError(err) {
        log.error('[HuHoBotPenguin] 网关错误：' + err.message);
    }

    _onHello(ws, hello) {
        const interval = (hello && hello.heartbeat_interval) || 41250;
        this.heartbeatInterval = interval;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this._sendHeartbeat(ws), interval);
        this._scheduleAckTimeout(interval);
    }

    _sendHeartbeat(ws) {
        if (ws !== this.ws || !this.connected) return;
        ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }));
        this._scheduleAckTimeout((this.heartbeatInterval || 41250) * 2);
    }

    _scheduleAckTimeout(ms) {
        if (this.ackTimer) clearTimeout(this.ackTimer);
        this.ackTimer = setTimeout(() => {
            log.warn('[HuHoBotPenguin] 心跳超时，主动断开重连');
            if (this.ws) this.ws.close(1000, 'heartbeat-timeout');
        }, Math.max(ms, 5000));
    }

    _onHeartbeatAck() {
        if (this.ackTimer) clearTimeout(this.ackTimer);
        this.ackTimer = setTimeout(() => {
            log.warn('[HuHoBotPenguin] 心跳 ACK 超时，主动断开重连');
            if (this.ws) this.ws.close(1000, 'heartbeat-ack-timeout');
        }, (this.heartbeatInterval || 41250) * 3);
    }

    _onInvalidSession(ws, d) {
        log.warn('[HuHoBotPenguin] 收到 Invalid Session（d=' + d + '），重建会话');
        this._clearTimers();
        if (d === true) {
            // 服务端作废旧会话，必须全新 Identify
            this.sessionId = null;
        }
        // d === false：重连后可再尝试 Resume
        if (ws) ws.close(1000, 'invalid-session');
        this._scheduleReconnect(0);
    }

    _onDispatch(payload) {
        this.lastSeq = payload.s;
        if (!payload.t) return;

        if (this.cfg.getBool('debug.log-events', false)) {
            log.info('[HuHoBotPenguin] 收到 Dispatch：t=' + payload.t +
                (payload.d && payload.d.type !== undefined ? ' type=' + payload.d.type : '') +
                ' 前200字符=' + JSON.stringify(payload).slice(0, 200));
        }

        if (payload.t === 'READY') {
            this.sessionId = payload.d && payload.d.session_id;
            this.ready = true;
            this.firstConnect = false;
            this.reconnectAttempt = 0;
            log.info('[HuHoBotPenguin] QQ 机器人已连接（session_id=' + this.sessionId + '）');
            this.emit('ready');
            return;
        }
        if (payload.t === 'RESUMED') {
            this.ready = true;
            this.firstConnect = false;
            log.info('[HuHoBotPenguin] Resume 成功，会话已恢复');
            this.emit('resumed');
            return;
        }
        // 群里 @ 消息；以及开了"接收群内全部消息"后的全量消息（含 @，字段与 GROUP_AT 完全一致）
        if (payload.t === 'GROUP_AT_MESSAGE_CREATE' || payload.t === 'GROUP_MESSAGE_CREATE') {
            this._onGroupMessage(payload.d);
        }
    }

    _onGroupMessage(d) {
        if (!d || !d.id || !d.group_openid) {
            log.warn('[HuHoBotPenguin] 群消息事件缺少 group_openid/id 字段：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }

        // 官方可能重复推送相同 msg_id
        if (this.recentIds.includes(d.id)) return;
        this.recentIds.push(d.id);
        if (this.recentIds.length > 200) this.recentIds.shift();

        if (this.cfg.getBool('debug.log-events', false)) {
            const author = d.author || {};
            log.info('[HuHoBotPenguin] 收到群 @ 消息：group=' + d.group_openid +
                ' user=' + author.id +
                ' role=' + (author.member_role || '-') +
                ' content=' + JSON.stringify(d.content || ''));
        }

        const message = {
            id: d.id,
            groupId: d.group_openid,
            content: d.content || '',
            userId: d.author && d.author.id,
            username: d.author && d.author.username,
            memberRole: d.author && d.author.member_role,
            timestamp: d.timestamp
        };
        this.emit('groupMessage', message);
    }

    // ---- access_token ----

    getAccessToken() {
        if (this.tokenPromise) return this.tokenPromise;
        if (this.accessToken && Date.now() < this.tokenExpireAt - TOKEN_REFRESH_LEAD) {
            return Promise.resolve(this.accessToken);
        }
        this.tokenPromise = this._refreshToken().finally(() => { this.tokenPromise = null; });
        return this.tokenPromise;
    }

    async _refreshToken() {
        log.info('[HuHoBotPenguin] 正在获取 access_token…');
        const result = await requestJson({
            host: 'bots.qq.com',
            path: '/app/getAppAccessToken',
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: { appId: this.appId, clientSecret: this.secret },
            label: 'getAppAccessToken'
        });
        if (!result.access_token) {
            throw new Error('token 接口未返回 access_token：' + JSON.stringify(result));
        }
        const expiresIn = (result.expires_in > 0 ? result.expires_in : 7200) * 1000;
        this.accessToken = result.access_token;
        this.tokenExpireAt = Date.now() + expiresIn;
        return this.accessToken;
    }

    // ---- 发消息 ----

    /**
     * 发送群消息（串行队列 + 节流）。
     * @param {string} groupId group_openid
     * @param {string} content 支持 \n
     * @param {string} [msgId] 被动回复用的消息 ID（5 分钟内有效）
     */
    sendGroupMessage(groupId, content, msgId) {
        const task = this._enqueue(() => this._sendGroupMessage(groupId, content, msgId));
        task.then(() => {
            if (this.cfg.getBool('debug.log-events', false)) {
                log.info('[HuHoBotPenguin] 群消息已发送 group=' + groupId +
                    ' content=' + JSON.stringify(content).slice(0, 150));
            }
        }).catch((err) => {
            log.error('[HuHoBotPenguin] 群消息发送失败 group=' + groupId + '：' + err.message);
        });
        return task;
    }

    /**
     * 发送群自定义 Markdown 消息（msg_type=2，官方已向所有机器人开放，无需申请模板）。
     * @param {string} groupId group_openid
     * @param {string} markdownContent Markdown 原文（# 标题 / **加粗** / - 列表 / *** 分割线等）
     * @param {string} [msgId] 被动回复用的消息 ID
     */
    sendMarkdown(groupId, markdownContent, msgId) {
        const task = this._enqueue(() => this._sendGroupMessage(groupId, markdownContent, msgId, 2));
        task.then(() => {
            if (this.cfg.getBool('debug.log-events', false)) {
                log.info('[HuHoBotPenguin] 群 Markdown 已发送 group=' + groupId +
                    ' content=' + JSON.stringify(markdownContent).slice(0, 150));
            }
        }).catch((err) => {
            log.error('[HuHoBotPenguin] 群 Markdown 发送失败 group=' + groupId + '：' + err.message);
        });
        return task;
    }

    _enqueue(fn) {
        const run = this.sendQueue.then(async () => {
            await fn();
            await sleep(SEND_GAP_MS);
        });
        this.sendQueue = run.catch(() => {});
        return run;
    }

    async _sendGroupMessage(groupId, content, msgId, msgType = 0) {
        const token = await this.getAccessToken();
        const id = encodeURIComponent(groupId);
        const body = { msg_type: msgType };
        if (msgType === 2) {
            // Markdown 消息：markdown.content 直接传原文
            body.markdown = { content };
        } else {
            body.content = content;
        }
        if (msgId) body.msg_id = msgId;
        return requestJson({
            host: this.backendHost,
            path: '/v2/groups/' + id + '/messages',
            method: 'POST',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body
        });
    }

    // ---- 重连 ----

    _scheduleReconnect(delay) {
        if (this.stopped || this.reconnectTimer) return;
        const backoff = Math.min(MAX_RECONNECT_DELAY, 1000 * Math.pow(2, this.reconnectAttempt++));
        const wait = delay !== undefined ? delay : backoff + Math.floor(Math.random() * 500);
        log.info('[HuHoBotPenguin] ' + wait + 'ms 后重连网关…');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._connectFlow().catch((err) => {
                log.error('[HuHoBotPenguin] 重连失败：' + err.message);
                this._scheduleReconnect();
            });
        }, wait);
    }

    _clearTimers() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.ackTimer) {
            clearTimeout(this.ackTimer);
            this.ackTimer = null;
        }
    }
}

module.exports = { QQClient, requestJson, sleep };