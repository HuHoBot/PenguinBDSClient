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

const INTENTS_GROUP_AND_C2C = 1 << 25; // 群/单聊消息 + 机器人进出群 + 通知开关
const INTENTS_GROUP_MEMBER = 1 << 24; // GROUP_JOIN_REQUEST（入群申请事件，机器人需为群管理员）
const INTENTS_INTERACTION = 1 << 26;  // INTERACTION_CREATE（键盘按钮/快捷菜单回调）
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

/** 跨实例共享的已处理事件 id 列表（热重载期间多实例并存时防双发）。 */
function sharedSeenIds() {
    const scope = (typeof process !== 'undefined' && process) || globalThis;
    if (!scope.__huohoBotPenguinSeenIds) scope.__huohoBotPenguinSeenIds = [];
    return scope.__huohoBotPenguinSeenIds;
}

/** 记录一次事件 id；已处理过返回 false。 */
function seenOnce(id) {
    const seen = sharedSeenIds();
    if (seen.includes(id)) return false;
    seen.push(id);
    if (seen.length > 500) seen.shift();
    return true;
}

/** 被动回复序号：同一 msg_id 多次回复时递增 msg_seq，避免被官方去重拦截（每条消息最多回 5 次）。 */
function nextMsgSeq(msgId) {
    const scope = (typeof process !== 'undefined' && process) || globalThis;
    if (!scope.__huohoBotPenguinMsgSeq) scope.__huohoBotPenguinMsgSeq = {};
    const map = scope.__huohoBotPenguinMsgSeq;
    map[msgId] = (map[msgId] || 0) + 1;
    return map[msgId];
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
        // 发布版固定使用正式环境
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
            // 立即销毁底层 socket，不等服务端回关：reload 场景下必须确保旧连接断开
            try {
                this.ws.destroy();
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
        log.info('[HuHoBotPenguin] 环境：正式，后端 ' + this.backendHost);
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
                        intents: INTENTS_GROUP_AND_C2C | INTENTS_GROUP_MEMBER | INTENTS_INTERACTION,
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
        if (ws !== this.ws) {
            // reload/停止时 this.ws 已置空：这是旧连接的关闭回调，仅记录，不触发重连
            log.info('[HuHoBotPenguin] 旧网关连接已断开：code=' + code + ' reason=' + (reason || '-'));
            return;
        }
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
        } else if (payload.t === 'C2C_MESSAGE_CREATE') {
            // 用户单聊消息（intents 已含 GROUP_AND_C2C_EVENT）
            this._onPrivateMessage(payload.d);
        } else if (payload.t === 'GROUP_JOIN_REQUEST') {
            // 用户申请加群（需机器人有群管理员身份才会推送）
            this._onJoinRequest(payload.d);
        } else if (payload.t === 'GROUP_MEMBER_ADD') {
            // 群成员加入（Intent GROUP_MEMBER_EVENT 1<<24，已订阅）
            this._onMemberAdd(payload.d);
        } else if (payload.t === 'GROUP_MEMBER_REMOVE') {
            // 群成员退出/被移出（同 Intent）
            this._onMemberRemove(payload.d);
        } else if (payload.t === 'GROUP_ADD_ROBOT') {
            // 机器人被拉进群（Intent 1<<25，已订阅）
            this._onBotJoinGroup(payload.d, payload.id || (payload.d && payload.d.id) || '');
        } else if (payload.t === 'GROUP_DEL_ROBOT') {
            // 机器人被移出群（同 Intent）
            this._onBotLeaveGroup(payload.d, payload.id || (payload.d && payload.d.id) || '');
        } else if (payload.t === 'GROUP_MSG_RECEIVE') {
            // 群资料页开启「接收群消息」（同 Intent）
            this._onGroupNotifySwitch(payload.d, true, payload.id || (payload.d && payload.d.id) || '');
        } else if (payload.t === 'GROUP_MSG_REJECT') {
            // 群资料页关闭「接收群消息」（同 Intent）
            this._onGroupNotifySwitch(payload.d, false, payload.id || (payload.d && payload.d.id) || '');
        } else if (payload.t === 'INTERACTION_CREATE') {
            // 键盘按钮/快捷菜单回调（Intent INTERACTION 1<<26）
            // 事件 id 原样保留（消息 event_id 用完整 id；PUT /interactions 再剥前缀）
            this._onInteraction(payload.d, payload.id || '');
        }
    }

    _onGroupMessage(d) {
        if (!d || !d.id || !d.group_openid) {
            log.warn('[HuHoBotPenguin] 群消息事件缺少 group_openid/id 字段：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }

        // 官方可能重复推送相同 msg_id；且热重载期间可能多实例并存，
        // 去重表挂在共享作用域（process）上，跨实例去重，杜绝消息双发
        if (!seenOnce(d.id)) return;

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

    /** 用户单聊消息（C2C_MESSAGE_CREATE）。 */
    _onPrivateMessage(d) {
        if (!d || !d.id || !d.user_openid) {
            log.warn('[HuHoBotPenguin] 单聊消息事件缺少 user_openid/id 字段：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }
        if (!seenOnce(d.id)) return;
        if (this.cfg.getBool('debug.log-events', false)) {
            log.info('[HuHoBotPenguin] 收到单聊消息：user=' + d.user_openid + ' content=' + JSON.stringify(d.content || ''));
        }
        this.emit('privateMessage', {
            id: d.id,
            userOpenId: d.user_openid,
            content: d.content || '',
            timestamp: d.timestamp
        });
    }

    /** 用户申请加群（GROUP_JOIN_REQUEST，机器人需为群管理员）。 */
    _onJoinRequest(d) {
        if (!d || !d.group_openid || !d.member_openid) {
            log.warn('[HuHoBotPenguin] 入群申请事件缺少 group_openid/member_openid 字段：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }
        if (!seenOnce('jr:' + (d.join_request_id || (d.member_openid + ':' + (d.apply_at || ''))))) return;
        if (this.cfg.getBool('debug.log-events', false)) {
            log.info('[HuHoBotPenguin] 收到入群申请：group=' + d.group_openid + ' member=' + d.member_openid +
                ' username=' + (d.username || '-'));
        }
        this.emit('joinRequest', {
            groupOpenId: d.group_openid,
            memberOpenid: d.member_openid,
            username: d.username || '',
            joinRequestId: d.join_request_id || '',
            applyAt: d.apply_at || '',
            verifyMessage: (d.verify_info && d.verify_info.verify_message) || ''
        });
    }

    /** 群成员加入（GROUP_MEMBER_ADD）。 */
    _onMemberAdd(d) {
        if (!d || !d.group_openid || !d.member_openid) {
            log.warn('[HuHoBotPenguin] 群成员加入事件缺少字段：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }
        const key = 'ma:' + d.group_openid + ':' + d.member_openid + ':' + (d.timestamp || '');
        if (!seenOnce(key)) return;
        if (this.cfg.getBool('debug.log-events', false)) {
            log.info('[HuHoBotPenguin] 群成员加入：group=' + d.group_openid + ' member=' + d.member_openid);
        }
        this.emit('memberJoin', {
            groupOpenId: d.group_openid,
            memberOpenid: d.member_openid,
            userOpenid: d.user_openid || '',
            timestamp: d.timestamp || null
        });
    }

    /** 群成员退出/被移出（GROUP_MEMBER_REMOVE）。 */
    _onMemberRemove(d) {
        if (!d || !d.group_openid || !d.member_openid) {
            log.warn('[HuHoBotPenguin] 群成员退出事件缺少字段：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }
        const key = 'mr:' + d.group_openid + ':' + d.member_openid + ':' + (d.timestamp || '');
        if (!seenOnce(key)) return;
        if (this.cfg.getBool('debug.log-events', false)) {
            log.info('[HuHoBotPenguin] 群成员退出：group=' + d.group_openid + ' member=' + d.member_openid);
        }
        this.emit('memberLeave', {
            groupOpenId: d.group_openid,
            memberOpenid: d.member_openid,
            userOpenid: d.user_openid || '',
            timestamp: d.timestamp || null
        });
    }

    /** 机器人加入群聊（GROUP_ADD_ROBOT）。envelopeId 为 dispatch 最外层 id（可作 event_id）。 */
    _onBotJoinGroup(d, envelopeId) {
        if (!d || !d.group_openid) {
            log.warn('[HuHoBotPenguin] 机器人入群事件缺少 group_openid：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }
        const key = 'br:' + d.group_openid + ':' + (d.timestamp || '');
        if (!seenOnce(key)) return;
        // 事件体无 id；event_id 取最外层/事件体兜底
        const eventId = envelopeId || d.id || d.event_id || '';
        // 状态类事件不依赖 debug 也记一条，便于排查「开关没反应」
        log.info('[HuHoBotPenguin] 机器人加入群：group=' + d.group_openid +
            ' op=' + (d.op_member_openid || '-') + (eventId ? ' event_id=' + eventId : ''));
        this.emit('botJoinGroup', {
            groupOpenId: d.group_openid,
            opMemberOpenid: d.op_member_openid || '',
            timestamp: d.timestamp || null,
            eventId
        });
    }

    /** 机器人退出群聊（GROUP_DEL_ROBOT）。 */
    _onBotLeaveGroup(d, envelopeId) {
        if (!d || !d.group_openid) {
            log.warn('[HuHoBotPenguin] 机器人退群事件缺少 group_openid：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }
        const key = 'bl:' + d.group_openid + ':' + (d.timestamp || '');
        if (!seenOnce(key)) return;
        const eventId = envelopeId || d.id || d.event_id || '';
        log.info('[HuHoBotPenguin] 机器人退出群：group=' + d.group_openid +
            ' op=' + (d.op_member_openid || '-') + (eventId ? ' event_id=' + eventId : ''));
        this.emit('botLeaveGroup', {
            groupOpenId: d.group_openid,
            opMemberOpenid: d.op_member_openid || '',
            timestamp: d.timestamp || null,
            eventId
        });
    }

    /**
     * 群资料页「通知」开关（GROUP_MSG_RECEIVE 开 / GROUP_MSG_REJECT 关）。
     * 官方文档有、Intent 已订，但实测常收不到 Dispatch（官方可能未下发）。
     */
    _onGroupNotifySwitch(d, enabled, envelopeId) {
        if (!d || !d.group_openid) {
            log.warn('[HuHoBotPenguin] 群通知开关事件缺少 group_openid：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }
        const key = (enabled ? 'nr:' : 'nj:') + d.group_openid + ':' + (d.timestamp || '');
        if (!seenOnce(key)) return;
        const eventId = envelopeId || d.id || d.event_id || '';
        // 必打日志：否则开了「接收消息」若附属没回、又没开 debug，会像「没反应」
        log.info('[HuHoBotPenguin] 群消息接收' + (enabled ? '开启' : '关闭') +
            '：group=' + d.group_openid + ' op=' + (d.op_member_openid || '-') +
            (eventId ? ' event_id=' + eventId : '（事件体无 id，回复走主动消息）'));
        this.emit(enabled ? 'groupMsgReceive' : 'groupMsgReject', {
            groupOpenId: d.group_openid,
            opMemberOpenid: d.op_member_openid || '',
            timestamp: d.timestamp != null ? Number(d.timestamp) : null,
            eventId
        });
    }

    /**
     * 按钮/菜单互动回调（INTERACTION_CREATE）。
     * type=11 按钮 / 12 快捷菜单 需在有效期内 PUT /interactions/{id} 应答。
     * @param {object} d 事件体
     * @param {string} [envelopeId] dispatch 最外层 id（消息 event_id 用，可带 INTERACTION_CREATE: 前缀）
     */
    _onInteraction(d, envelopeId) {
        if (!d || !d.id) {
            log.warn('[HuHoBotPenguin] 互动事件缺少 id：' + JSON.stringify(d || {}).slice(0, 300));
            return;
        }
        const rawId = String(d.id);
        // PUT /interactions 不要前缀；消息 event_id 用「最外层 id」，缺前缀时补上 INTERACTION_CREATE:
        const interactionId = rawId.replace(/^INTERACTION_CREATE:/, '');
        let eventId = String(envelopeId || rawId || '');
        if (eventId && !/^INTERACTION_CREATE:/.test(eventId)) {
            eventId = 'INTERACTION_CREATE:' + eventId.replace(/^INTERACTION_CREATE:/, '');
        }
        if (!seenOnce('ix:' + interactionId)) return;
        const resolved = (d.data && d.resolved) || (d.data && d.data.resolved) || {};
        if (this.cfg.getBool('debug.log-events', false)) {
            log.info('[HuHoBotPenguin] 收到互动：id=' + interactionId +
                ' event_id=' + eventId +
                ' type=' + d.type + ' scene=' + (d.scene || '-') +
                ' data=' + JSON.stringify(resolved.button_data || resolved.button_id || ''));
        }
        this.emit('interaction', {
            id: interactionId,
            eventId,
            type: d.type != null ? Number(d.type) : 0,
            scene: d.scene || '',
            chatType: d.chat_type != null ? Number(d.chat_type) : null,
            groupOpenId: d.group_openid || '',
            groupMemberOpenid: d.group_member_openid || '',
            userOpenId: d.user_openid || '',
            buttonId: resolved.button_id || '',
            buttonData: resolved.button_data || '',
            featureId: resolved.feature_id || '',
            messageOpenId: resolved.message_id || '',
            // type=18/19/20 授权：{ opt_scene, scope: c2c_push | group_push }
            authorize: resolved.authorize_data || null,
            timestamp: d.timestamp || null,
            raw: d
        });
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
     * @param {object} [opts] { msgType?: 0|2, keyboard?: object, eventId?: string }
     * @returns {Promise<{id?: string, timestamp?: string}>} 发送响应（含消息 id，可用于撤回）
     */
    sendGroupMessage(groupId, content, msgId, opts) {
        const o = opts || {};
        const msgType = o.msgType != null ? o.msgType : 0;
        const task = this._enqueue(() => this._sendGroupMessage(groupId, content, msgId, msgType, o));
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
     * @param {object} [opts] { keyboard?: object, eventId?: string }
     * @returns {Promise<{id?: string, timestamp?: string}>}
     */
    sendMarkdown(groupId, markdownContent, msgId, opts) {
        const o = opts || {};
        const task = this._enqueue(() => this._sendGroupMessage(groupId, markdownContent, msgId, 2, o));
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

    /**
     * 发送带内嵌键盘（按钮）的群消息。
     * @param {string} groupId group_openid
     * @param {string} content 文本或 Markdown
     * @param {object} keyboard { id } 或 { content: { rows: [...] } }
     * @param {string} [msgId] 被动回复消息 ID
     * @param {object} [opts] { msgType?: 0|2, eventId?: string }
     * @returns {Promise<{id?: string}>}
     */
    sendGroupKeyboard(groupId, content, keyboard, msgId, opts) {
        const o = Object.assign({}, opts || {}, {
            keyboard,
            msgType: (opts && opts.msgType != null) ? opts.msgType : 2
        });
        return this.sendMarkdown(groupId, content, msgId, o);
    }

    _enqueue(fn) {
        const run = this.sendQueue.then(async () => {
            await fn();
            await sleep(SEND_GAP_MS);
        });
        this.sendQueue = run.catch(() => {});
        return run;
    }

    async _sendGroupMessage(groupId, content, msgId, msgType = 0, opts = {}) {
        const token = await this.getAccessToken();
        const id = encodeURIComponent(groupId);
        const body = { msg_type: msgType };
        if (msgType === 2) {
            // Markdown 消息：markdown.content 直接传原文
            body.markdown = { content };
        } else if (content != null && content !== '') {
            body.content = content;
        }
        if (opts.keyboard) body.keyboard = opts.keyboard;
        if (opts.eventId) {
            // 事件被动回复：event_id 与 msg_id 二选一；id 原样发送（可含 INTERACTION_CREATE: 前缀）
            body.event_id = opts.eventId;
        } else if (msgId) {
            // 被动消息每条 msg_id 最多回复 5 次，必须递增 msg_seq 否则会被官方去重拦截
            body.msg_id = msgId;
            body.msg_seq = nextMsgSeq(msgId);
        }
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

    /**
     * 发送单聊消息（POST /v2/users/{user_openid}/messages）。
     * 主动消息有频控与每日上限；带 msgId 为被动回复（60 分钟内有效，每条最多回 4 次）。
     * @param {string} userOpenId 用户 OpenID
     * @param {string} content 文本内容
     * @param {string} [msgId] 被动回复的消息 ID（C2C_MESSAGE_CREATE 的 d.id）
     * @param {number} [msgType] 0=文本 2=Markdown
     */
    sendPrivateMessage(userOpenId, content, msgId, msgType = 0, opts = {}) {
        const task = this._enqueue(() => this._sendPrivateMessage(userOpenId, content, msgId, msgType, opts));
        task.catch((err) => {
            log.error('[HuHoBotPenguin] 单聊消息发送失败 user=' + userOpenId + '：' + err.message);
        });
        return task;
    }

    async _sendPrivateMessage(userOpenId, content, msgId, msgType = 0, opts = {}) {
        const token = await this.getAccessToken();
        const body = { msg_type: msgType };
        if (msgType === 2) {
            body.markdown = { content };
        } else if (content != null && content !== '') {
            body.content = content;
        }
        if (opts.keyboard) body.keyboard = opts.keyboard;
        if (opts.eventId) {
            body.event_id = opts.eventId;
        } else if (msgId) {
            body.msg_id = msgId;
            body.msg_seq = nextMsgSeq(msgId);
        }
        return requestJson({
            host: this.backendHost,
            path: '/v2/users/' + encodeURIComponent(userOpenId) + '/messages',
            method: 'POST',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body
        });
    }

    /**
     * 撤回群消息（DELETE /v2/groups/{group_openid}/messages/{message_id}）。
     * 发送超过 2 分钟不可撤回；机器人须为群管理员才能撤他人消息。
     * @returns {Promise<object>}
     */
    recallGroupMessage(groupOpenId, messageId) {
        if (!groupOpenId || !messageId) {
            return Promise.reject(new Error('撤回群消息需要 groupOpenId 与 messageId'));
        }
        return this.getAccessToken().then((token) => requestJson({
            host: this.backendHost,
            path: '/v2/groups/' + encodeURIComponent(groupOpenId) + '/messages/' + encodeURIComponent(messageId),
            method: 'DELETE',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId
            },
            label: 'recall_group_message'
        }));
    }

    /**
     * 撤回单聊消息（DELETE /v2/users/{user_openid}/messages/{message_id}）。
     * 仅可撤回机器人自己发送的消息，超过 2 分钟不可撤。
     * @returns {Promise<object>}
     */
    recallPrivateMessage(userOpenId, messageId) {
        if (!userOpenId || !messageId) {
            return Promise.reject(new Error('撤回单聊消息需要 userOpenId 与 messageId'));
        }
        return this.getAccessToken().then((token) => requestJson({
            host: this.backendHost,
            path: '/v2/users/' + encodeURIComponent(userOpenId) + '/messages/' + encodeURIComponent(messageId),
            method: 'DELETE',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId
            },
            label: 'recall_private_message'
        }));
    }

    /**
     * 应答互动事件（PUT /interactions/{interaction_id}）。
     * type=11/12 必须在有效期内应答一次，否则客户端一直 loading。
     * @param {string} interactionId 事件 id（自动去掉 INTERACTION_CREATE: 前缀）
     * @param {number} [code] 0=成功 1=失败 2=频繁 3=重复 4=无权限 5=仅管理员
     * @returns {Promise<object>}
     */
    ackInteraction(interactionId, code = 0) {
        const id = String(interactionId || '').replace(/^INTERACTION_CREATE:/, '');
        if (!id) return Promise.reject(new Error('interactionId 为空'));
        return this.getAccessToken().then((token) => requestJson({
            host: this.backendHost,
            path: '/interactions/' + encodeURIComponent(id),
            method: 'PUT',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: { code: Number(code) || 0 },
            label: 'put_interaction'
        }));
    }

    /** 设置群成员禁言（POST /v2/groups/{group_openid}/restrict_chat_setting）。机器人需群管理员，最长 30 天。 */
    muteMember(groupOpenId, memberOpenid, durationSeconds) {
        const seconds = Math.max(1, Number(durationSeconds) || 0);
        const expire = new Date(Date.now() + seconds * 1000).toISOString();
        return this._restrictChatSetting(groupOpenId, [
            { op: 'add', member_openid: memberOpenid, mute_expire_at: expire }
        ]);
    }

    /** 解除群成员禁言。 */
    unmuteMember(groupOpenId, memberOpenid) {
        return this._restrictChatSetting(groupOpenId, [
            { op: 'del', member_openid: memberOpenid, mute_expire_at: '' }
        ]);
    }

    _restrictChatSetting(groupOpenId, members) {
        return this.getAccessToken().then((token) => requestJson({
            host: this.backendHost,
            path: '/v2/groups/' + encodeURIComponent(groupOpenId) + '/restrict_chat_setting',
            method: 'POST',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: { members },
            label: 'restrict_chat_setting'
        }));
    }

    /** 拉取入群申请列表（GET /v2/groups/{group_openid}/join_request_list），返回 Promise<{list, next_cursor}>。 */
    getJoinRequests(groupOpenId, cursor, limit) {
        const q = [];
        if (cursor) q.push('cursor=' + encodeURIComponent(cursor));
        if (limit) q.push('limit=' + Number(limit));
        return this.getAccessToken().then((token) => requestJson({
            host: this.backendHost,
            path: '/v2/groups/' + encodeURIComponent(groupOpenId) + '/join_request_list' + (q.length ? '?' + q.join('&') : ''),
            method: 'GET',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId
            },
            label: 'join_request_list'
        }));
    }

    /** 审批入群申请（POST /v2/groups/{group_openid}/approval_join_request/{member_openid}）。 */
    approveJoinRequest(groupOpenId, memberOpenid, options) {
        const o = options || {};
        const body = { op: o.approve === false ? 'decline' : 'approve' };
        if (o.joinRequestId) body.join_request_id = o.joinRequestId;
        if (o.rejectReason) body.reject_reason = o.rejectReason;
        if (o.addToBlacklist) body.add_to_member_blacklist = true;
        return this.getAccessToken().then((token) => requestJson({
            host: this.backendHost,
            path: '/v2/groups/' + encodeURIComponent(groupOpenId) + '/approval_join_request/' + encodeURIComponent(memberOpenid),
            method: 'POST',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body,
            label: 'approval_join_request'
        }));
    }

    /** 获取机器人信息（GET /users/@me），返回 Promise<{id, username, avatar}>。 */
    getBotInfo() {
        return this.getAccessToken().then((token) => requestJson({
            host: this.backendHost,
            path: '/users/@me',
            method: 'GET',
            headers: {
                'Authorization': 'QQBot ' + token,
                'X-Union-Appid': this.appId
            },
            label: 'users/@me'
        }));
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