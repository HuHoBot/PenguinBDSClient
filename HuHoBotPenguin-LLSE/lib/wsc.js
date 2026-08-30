'use strict';

/**
 * 零依赖 RFC6455 WebSocket 客户端，基于 Node 内置 tls/net/crypto 实现。
 * 专为 QQ 开放平台 wss 网关设计，不依赖任何 npm 包。
 *
 * 事件：open / message(data, isBinary) / close(code, reason) / error(err) / pong
 * 方法：connect() / send(data) / close(code, reason)
 * 说明：断线后不会自动重连，由上层（qqclient）决定 Resume 还是重新 Identify。
 */

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xA;

class WSC extends EventEmitter {
    /**
     * @param {string} url wss:// 或 ws:// 地址
     * @param {object} [options]
     * @param {object} [options.headers] 附加请求头
     * @param {number} [options.connectTimeout] 握手超时 ms，默认 30000
     * @param {number} [options.maxPayload] 单帧负载上限，默认 16MB
     */
    constructor(url, options = {}) {
        super();
        this.url = url;
        this.parsed = new URL(url);
        if (this.parsed.protocol !== 'wss:' && this.parsed.protocol !== 'ws:') {
            throw new Error(`不支持的协议: ${this.parsed.protocol}`);
        }
        this.isSecure = this.parsed.protocol === 'wss:';
        this.headers = options.headers || {};
        this.connectTimeoutMs = options.connectTimeout || 30000;
        this.maxPayload = options.maxPayload || 16 * 1024 * 1024;

        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.connected = false;
        this._closeEmitted = true;
        this._pendingClose = null;
        this._fragments = [];
        this._fragmentOpcode = 0;
    }

    get ready() {
        return this.connected && !!this.socket && !this.socket.destroyed;
    }

    connect() {
        this._closeEmitted = false;
        this._pendingClose = null;
        this._fragments = [];
        this._fragmentOpcode = 0;

        const port = this.parsed.port || (this.isSecure ? 443 : 80);
        const host = this.parsed.hostname;
        const path = this.parsed.pathname + this.parsed.search || '/';
        const key = crypto.randomBytes(16).toString('base64');

        const transport = this.isSecure ? tls : net;
        this.socket = transport.connect({
            host,
            port,
            servername: this.isSecure ? host : undefined
        });
        this.socket.setNoDelay(true);

        let handshakeBytes = 0;

        this.socket.on('connect', () => {
            const lines = [
                `GET ${path} HTTP/1.1`,
                `Host: ${host}${port === (this.isSecure ? 443 : 80) ? '' : ':' + port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13'
            ];
            for (const [name, value] of Object.entries(this.headers)) {
                lines.push(`${name}: ${value}`);
            }
            this.socket.write(lines.join('\r\n') + '\r\n\r\n');
        });

        this.socket.on('data', (chunk) => {
            if (!this.connected) {
                handshakeBytes += chunk.length;
                if (handshakeBytes > 64 * 1024) return this._fail('HTTP 升级响应头过大');
                const result = this._handleHandshake(chunk, key);
                if (result === true) {
                    this.connected = true;
                    this.emit('open');
                } else if (typeof result === 'string') {
                    this._fail(result);
                }
                return;
            }
            this._feed(chunk);
        });

        this.socket.on('error', (err) => {
            this.emit('error', err);
        });

        this.socket.on('close', (hadError) => {
            const wasConnected = this.connected;
            this.socket = null;
            this.connected = false;
            this.buffer = Buffer.alloc(0);
            this._fragments = [];
            this._fragmentOpcode = 0;
            if (this._closeEmitted) return;
            this._closeEmitted = true;
            const info = this._pendingClose || {
                code: hadError ? 1006 : 1005,
                reason: wasConnected ? '连接中断' : '握手失败/连接中断'
            };
            this.emit('close', info.code, info.reason);
        });

        if (this.connectTimeoutMs > 0) {
            this._connectTimer = setTimeout(() => {
                if (!this.connected && this.socket) {
                    this._fail(`连接超时（${this.connectTimeoutMs}ms）`);
                }
            }, this.connectTimeoutMs);
        }
    }

    send(data) {
        const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
        return this._writeFrame(OP_TEXT, payload);
    }

    sendBinary(data) {
        return this._writeFrame(OP_BINARY, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }

    ping(data) {
        return this._writeFrame(OP_PING, data ? Buffer.from(data) : Buffer.alloc(0));
    }

    close(code = 1000, reason = '') {
        if (!this.socket) return;
        const reasonBuf = Buffer.from(reason, 'utf8');
        const payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
        this._pendingClose = { code, reason };
        this._writeFrame(OP_CLOSE, payload);
        this.socket.end();
        setTimeout(() => { if (this.socket) this.socket.destroy(); }, 1500);
    }

    /** 立即销毁底层 socket（不做关闭握手），用于强制断开（如插件停止）。 */
    destroy() {
        if (this._connectTimer) {
            clearTimeout(this._connectTimer);
            this._connectTimer = null;
        }
        if (this.socket) this.socket.destroy();
    }

    // ---- 内部：握手 ----

    _handleHandshake(chunk, key) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return false; // 等待更多数据

        const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
        const remainder = this.buffer.slice(headerEnd + 4);
        this.buffer = Buffer.alloc(0);

        const lines = headerText.split('\r\n');
        if (!/^HTTP\/1\.[01] 101/.test(lines[0])) {
            return `网关未返回 101 升级：${lines[0] || '(空响应)'}`;
        }

        const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
        const matched = /^sec-websocket-accept\s*:\s*(.+)$/im.exec(headerText);
        if (!matched || matched[1].trim() !== expect) {
            return 'Sec-WebSocket-Accept 校验失败';
        }

        if (remainder.length > 0) this._feed(remainder);
        return true;
    }

    _fail(message) {
        this._pendingClose = { code: 1002, reason: message };
        if (this._connectTimer) clearTimeout(this._connectTimer);
        if (this.socket) {
            this.emit('error', new Error(message));
            this.socket.destroy();
        }
    }

    // ---- 内部：帧解析 ----

    _feed(chunk) {
        if (!this.buffer.length && chunk) {
            this.buffer = chunk;
        } else {
            this.buffer = Buffer.concat([this.buffer, chunk]);
        }
        for (;;) {
            const frame = this._parseFrame();
            if (frame === null) break;
            this._handleFrame(frame);
        }
    }

    _parseFrame() {
        const buf = this.buffer;
        if (buf.length < 2) return null;

        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let offset = 2;

        if (len === 126) {
            if (buf.length < 4) return null;
            len = buf.readUInt16BE(2);
            offset = 4;
        } else if (len === 127) {
            if (buf.length < 10) return null;
            const high = buf.readUInt32BE(2);
            const low = buf.readUInt32BE(6);
            if (high !== 0) {
                this._fail('帧长度超出 JS 可处理范围');
                return { fail: true };
            }
            len = low;
            offset = 10;
        }

        if (len > this.maxPayload) {
            this._fail(`单帧负载超出上限 ${this.maxPayload} 字节`);
            return { fail: true };
        }

        const masked = (buf[1] & 0x80) !== 0;
        let payload;
        if (masked) {
            if (buf.length < offset + 4) return null;
            const maskKey = buf.subarray(offset, offset + 4);
            offset += 4;
            if (buf.length < offset + len) return null;
            payload = Buffer.allocUnsafe(len);
            for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ maskKey[i & 3];
        } else {
            if (buf.length < offset + len) return null;
            payload = buf.subarray(offset, offset + len);
        }

        this.buffer = buf.subarray(offset + len);
        return { fin, opcode, payload };
    }

    _handleFrame({ fin, opcode, payload, fail }) {
        if (fail) return;

        if (opcode === OP_PING) {
            this._writeFrame(OP_PONG, payload);
            return;
        }
        if (opcode === OP_PONG) {
            this.emit('pong');
            return;
        }
        if (opcode === OP_CLOSE) {
            let code = 1005;
            let reason = '';
            if (payload.length >= 2) {
                code = payload.readUInt16BE(0);
                reason = payload.subarray(2).toString('utf8');
            }
            this._pendingClose = { code, reason };
            this._writeFrame(OP_CLOSE, payload);
            if (this.socket) this.socket.end();
            setTimeout(() => { if (this.socket) this.socket.destroy(); }, 1500);
            return;
        }
        if (opcode === OP_TEXT || opcode === OP_BINARY) {
            if (!fin) {
                if (this._fragmentOpcode !== 0) this._fail('重叠分片');
                this._fragments = [payload];
                this._fragmentOpcode = opcode;
                return;
            }
            this._emitData(payload, opcode);
            return;
        }
        if (opcode === OP_CONTINUATION) {
            if (this._fragmentOpcode === 0) return; // 孤立续帧，忽略
            this._fragments.push(payload);
            if (fin) {
                const full = Buffer.concat(this._fragments);
                const op = this._fragmentOpcode;
                this._fragments = [];
                this._fragmentOpcode = 0;
                this._emitData(full, op);
            }
            return;
        }
        // 未知 opcode：协议错误
        this._fail(`未知 opcode: ${opcode}`);
    }

    _emitData(payload, opcode) {
        if (opcode === OP_TEXT) {
            this.emit('message', payload.toString('utf8'), false);
        } else {
            this.emit('message', payload, true);
        }
    }

    // ---- 内部：发送（客户端帧一律掩码） ----

    _writeFrame(opcode, payload) {
        if (!this.socket || this.socket.destroyed) return false;
        const len = payload.length;
        let header;
        if (len < 126) {
            header = Buffer.alloc(2);
            header[1] = 0x80 | len; // MASK=1
        } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[1] = 0x80 | 127;
            header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
            header.writeUInt32BE(len >>> 0, 6);
        }
        header[0] = 0x80 | opcode; // FIN=1

        const maskKey = crypto.randomBytes(4);
        const masked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i & 3];

        this.socket.write(Buffer.concat([header, maskKey, masked]));
        return true;
    }
}

module.exports = WSC;