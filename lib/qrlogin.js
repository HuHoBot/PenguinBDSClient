'use strict';

/**
 * QQ 机器人扫码绑定登录（零 npm 依赖）。
 *
 * 协议来源：@tencent-connect/qqbot-connector（见 QR_LOGIN_FLOW.md）
 *   1. key = randomBytes(32).base64
 *   2. POST https://q.qq.com/lite/create_bind_task  {key} → task_id
 *   3. 二维码 URL = https://q.qq.com/qqbot/openclaw/connect.html?task_id=..&source=..&_wv=2
 *   4. 每 2s POST /lite/poll_bind_result {task_id}
 *      status: 0/1 继续；2 成功；3 过期（自动换新码）
 *   5. AES-256-GCM 解密 bot_encrypt_secret → AppSecret
 *
 * 解密 key 只在本地生成，服务端不保存——task_id 必须与 key 成对使用。
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const log = typeof logger !== 'undefined' ? logger : console;

const CREATE_URL = 'https://q.qq.com/lite/create_bind_task';
const POLL_URL = 'https://q.qq.com/lite/poll_bind_result';
const CONNECT_BASE = 'https://q.qq.com/qqbot/openclaw/connect.html';
const POLL_INTERVAL_MS = 2000;
const HTTP_TIMEOUT_MS = 10000;
const DEFAULT_SOURCE = 'HuHoBotPenguin';

const STATUS = { NONE: 0, PENDING: 1, COMPLETED: 2, EXPIRED: 3 };

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function postJson(urlPath, body, host = 'q.qq.com') {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request(
            {
                hostname: host,
                port: 443,
                path: urlPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(payload),
                    'User-Agent': 'HuHoBotPenguin/QRLogin',
                    'Accept': 'application/json'
                },
                timeout: HTTP_TIMEOUT_MS
            },
            (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error('HTTP ' + res.statusCode + '：' + data.slice(0, 200)));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('响应非 JSON：' + data.slice(0, 200)));
                    }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.write(payload);
        req.end();
    });
}

/** AES-256-GCM 解密 AppSecret（与 qqbot-connector 一致）。 */
function decryptSecret(encryptedBase64, keyBase64) {
    const key = Buffer.from(keyBase64, 'base64');
    const blob = Buffer.from(String(encryptedBase64 || ''), 'base64');
    if (key.length !== 32 || blob.length < 12 + 16) {
        throw new Error('密文或密钥长度非法');
    }
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(blob.length - 16);
    const data = blob.subarray(12, blob.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

function buildConnectUrl(taskId, source) {
    return CONNECT_BASE +
        '?task_id=' + encodeURIComponent(taskId) +
        '&source=' + encodeURIComponent(source || DEFAULT_SOURCE) +
        '&_wv=2';
}

/**
 * 创建绑定任务。
 * @returns {Promise<{taskId: string, key: string}>}
 */
async function createBindTask() {
    const key = crypto.randomBytes(32).toString('base64');
    const url = new URL(CREATE_URL);
    const body = await postJson(url.pathname, { key }, url.hostname);
    if (!body || body.retcode !== 0) {
        throw new Error((body && body.msg) || 'create_bind_task failed');
    }
    const taskId = body.data && body.data.task_id;
    if (!taskId) throw new Error('create_bind_task 未返回 task_id');
    return { taskId: String(taskId), key };
}

/**
 * 轮询一次扫码结果。
 * @returns {Promise<{status:number, appId?:string, encryptSecret?:string, userOpenId?:string}>}
 */
async function pollBindResult(taskId) {
    const url = new URL(POLL_URL);
    const body = await postJson(url.pathname, { task_id: taskId }, url.hostname);
    if (!body || body.retcode !== 0) {
        throw new Error((body && body.msg) || 'poll_bind_result failed');
    }
    const d = body.data || {};
    return {
        status: Number(d.status) || 0,
        appId: d.bot_appid || '',
        encryptSecret: d.bot_encrypt_secret || '',
        userOpenId: d.user_openid || ''
    };
}

/**
 * 单次扫码会话：创建任务 → 展示 URL → 轮询（过期自动换码）→ 解密。
 * 事件：status / qr / expired / success / error / done
 */
class QrSession extends EventEmitter {
    /**
     * @param {object} [opts]
     * @param {string} [opts.source] 扫码页展示的平台名
     * @param {boolean} [opts.autoRenew=true] 过期自动刷新二维码
     * @param {number} [opts.maxRenew] 最多换码次数（默认不限）
     */
    constructor(opts = {}) {
        super();
        this.source = opts.source || DEFAULT_SOURCE;
        this.autoRenew = opts.autoRenew !== false;
        this.maxRenew = opts.maxRenew != null ? opts.maxRenew : 0;
        this.stopped = false;
        this.state = 'idle'; // idle | starting | waiting | success | expired | error | cancelled
        this.taskId = '';
        this.key = '';
        this.url = '';
        this.renewCount = 0;
        this.error = '';
        this.credentials = null; // { appId, appSecret, userOpenId }
        this._loop = null;
    }

    start() {
        if (this.state === 'starting' || this.state === 'waiting') {
            return Promise.resolve(this);
        }
        this.stopped = false;
        this.state = 'starting';
        this._loop = this._run().catch((err) => {
            if (this.stopped) return;
            this.state = 'error';
            this.error = err && err.message || String(err);
            log.error('[HuHoBotPenguin] 扫码登录失败：' + this.error);
            this.emit('error', err);
            this.emit('done', { ok: false, error: this.error });
        });
        return Promise.resolve(this);
    }

    cancel() {
        if (this.stopped) return;
        this.stopped = true;
        this.state = 'cancelled';
        this.emit('done', { ok: false, error: '已取消' });
    }

    async _run() {
        for (;;) {
            if (this.stopped) return;
            this.state = 'starting';
            const { taskId, key } = await createBindTask();
            if (this.stopped) return;
            this.taskId = taskId;
            this.key = key; // 解密密钥，勿丢
            this.url = buildConnectUrl(taskId, this.source);
            this.state = 'waiting';
            log.info('[HuHoBotPenguin] 扫码登录二维码已生成（第 ' + (this.renewCount + 1) + ' 次）');
            log.info('[HuHoBotPenguin] 请用手机 QQ 打开或扫描：');
            log.info('[HuHoBotPenguin] ' + this.url);
            this.emit('qr', { url: this.url, taskId, renew: this.renewCount });

            for (;;) {
                if (this.stopped) return;
                let r;
                try {
                    r = await pollBindResult(this.taskId);
                } catch (e) {
                    // 单次轮询失败静默重试
                    await sleep(POLL_INTERVAL_MS);
                    continue;
                }
                if (this.stopped) return;
                this.emit('status', r);

                if (r.status === STATUS.COMPLETED) {
                    if (!r.appId || !r.encryptSecret) {
                        throw new Error('扫码成功但未返回 bot_appid/secret');
                    }
                    const appSecret = decryptSecret(r.encryptSecret, this.key);
                    this.credentials = {
                        appId: String(r.appId),
                        appSecret,
                        userOpenId: r.userOpenId || ''
                    };
                    this.state = 'success';
                    log.info('[HuHoBotPenguin] 扫码绑定成功：appId=' + this.credentials.appId +
                        (this.credentials.userOpenId ? ' user=' + this.credentials.userOpenId : ''));
                    this.emit('success', this.credentials);
                    this.emit('done', { ok: true, credentials: this.credentials });
                    return;
                }

                if (r.status === STATUS.EXPIRED) {
                    this.emit('expired');
                    if (!this.autoRenew) {
                        this.state = 'expired';
                        this.emit('done', { ok: false, error: '二维码已过期' });
                        return;
                    }
                    if (this.maxRenew > 0 && this.renewCount + 1 >= this.maxRenew) {
                        this.state = 'expired';
                        this.emit('done', { ok: false, error: '二维码已过期（达到刷新上限）' });
                        return;
                    }
                    this.renewCount++;
                    log.info('[HuHoBotPenguin] 二维码已过期，正在刷新…');
                    break; // 外层循环重新 create
                }

                await sleep(POLL_INTERVAL_MS);
            }
        }
    }

    /** 状态快照（给控制台 / WebUI）。 */
    snapshot() {
        return {
            state: this.state,
            url: this.url,
            taskId: this.taskId,
            renewCount: this.renewCount,
            error: this.error,
            credentials: this.credentials
                ? { appId: this.credentials.appId, userOpenId: this.credentials.userOpenId }
                : null
        };
    }
}

/** 跨实例共享的当前扫码会话（huhobot qr 可被 WebUI 复用）。 */
function sharedSessions() {
    const scope = (typeof process !== 'undefined' && process) || globalThis;
    if (!scope.__huohoBotPenguinQrSessions) scope.__huohoBotPenguinQrSessions = {};
    return scope.__huohoBotPenguinQrSessions;
}

/**
 * 开始（或复用）默认扫码会话。
 * @param {object} [opts] { source, force }
 * @returns {QrSession}
 */
function startSession(opts = {}) {
    const map = sharedSessions();
    const key = opts.key || 'default';
    if (map[key] && !map[key].stopped &&
        (map[key].state === 'waiting' || map[key].state === 'starting') && !opts.force) {
        return map[key];
    }
    if (map[key]) {
        try { map[key].cancel(); } catch (e) { /* ignore */ }
    }
    const s = new QrSession({ source: opts.source });
    map[key] = s;
    s.on('done', () => {
        // 成功/失败后保留 snapshot 一小段，由调用方读取；不自动删，cancel/start 覆盖
    });
    s.start().catch(() => {});
    return s;
}

function getSession(key = 'default') {
    return sharedSessions()[key] || null;
}

function cancelSession(key = 'default') {
    const s = sharedSessions()[key];
    if (!s) return false;
    s.cancel();
    delete sharedSessions()[key];
    return true;
}

/**
 * 把凭据写入 config.json 的 bot.app-id / bot.secret。
 * @param {string} configPath config.json 绝对路径
 * @param {{appId:string, appSecret:string}} creds
 */
function saveCredentialsToConfig(configPath, creds) {
    if (!creds || !creds.appId || !creds.appSecret) {
        throw new Error('凭据不完整');
    }
    let nested = {};
    try {
        nested = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        // 首次或损坏：以空对象为底
        nested = {};
    }
    if (!nested.bot || typeof nested.bot !== 'object') nested.bot = {};
    nested.bot['app-id'] = creds.appId;
    nested.bot.secret = creds.appSecret;
    fs.writeFileSync(configPath, JSON.stringify(nested, null, 2) + '\n', 'utf8');
    log.info('[HuHoBotPenguin] 已写入凭据到 ' + configPath + '（appId=' + creds.appId + '）');
}

/** 便捷：开始扫码并等待完成（不写盘）。 */
function qrConnect(opts = {}) {
    const s = startSession(opts);
    return new Promise((resolve, reject) => {
        if (s.state === 'success' && s.credentials) {
            resolve(s.credentials);
            return;
        }
        const onDone = (r) => {
            s.off('success', onSuccess);
            s.off('error', onError);
            if (r && r.ok && s.credentials) resolve(s.credentials);
            else reject(new Error((r && r.error) || '扫码失败'));
        };
        const onSuccess = (c) => { s.off('done', onDone); resolve(c); };
        const onError = (e) => { s.off('done', onDone); reject(e); };
        s.once('done', onDone);
        s.once('success', onSuccess);
        s.once('error', onError);
    });
}

module.exports = {
    STATUS,
    POLL_INTERVAL_MS,
    QrSession,
    createBindTask,
    pollBindResult,
    decryptSecret,
    buildConnectUrl,
    startSession,
    getSession,
    cancelSession,
    saveCredentialsToConfig,
    qrConnect
};
