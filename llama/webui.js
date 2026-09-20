'use strict';

/**
 * WebUI：为插件提供本地网页管理界面（配置管理 + AI 会话测试），
 * 参考 SparkBridge3 的后台布局：深色侧边栏导航 + 多页面内容区。
 * 使用 Node 原生 http 模块（lse-nodejs 后端可用），绕开 LLSE HttpServer 的
 * EngineScope 限制（回调脱离脚本引擎作用域会报 "call engine APIs without a
 * ::script::EngineScope"）。
 *
 * 路由：
 *   GET  /                 登录页 + 主界面（单页 SPA：侧边栏 + 多页面）
 *   POST /api/login        {username,password} → 设置登录 Cookie
 *   POST /api/logout       清除登录 Cookie
 *   GET  /api/status       插件/AI 状态（需登录）
 *   GET  /api/config       读取 config.json（需登录）
 *   POST /api/config       保存 config.json 并触发重载（需登录）
 *   POST /api/chat         {messages:[...]} → 测试 AI 对话（需登录）
 *
 * 安全：仅绑定 127.0.0.1（本机/反代），账号密码登录（Session Cookie）。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const qrLogin = require('../lib/qrlogin');
const qrSvg = require('../lib/qrsvg');

const log = typeof logger !== 'undefined' ? logger : console;

/** 内联 SVG 图标（lucide 风格 stroke，零外部依赖）。 */
const I = {"dashboard":"<rect x=\"3\" y=\"3\" width=\"7\" height=\"9\" rx=\"1.5\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"5\" rx=\"1.5\"/><rect x=\"14\" y=\"12\" width=\"7\" height=\"9\" rx=\"1.5\"/><rect x=\"3\" y=\"16\" width=\"7\" height=\"5\" rx=\"1.5\"/>","wrench":"<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/>","blocks":"<rect x=\"3\" y=\"3\" width=\"8\" height=\"8\" rx=\"1.5\"/><rect x=\"13\" y=\"3\" width=\"8\" height=\"8\" rx=\"1.5\"/><rect x=\"3\" y=\"13\" width=\"8\" height=\"8\" rx=\"1.5\"/><rect x=\"13\" y=\"13\" width=\"8\" height=\"8\" rx=\"1.5\"/>","chat":"<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/>","plug":"<path d=\"M12 22v-5\"/><path d=\"M9 8V2\"/><path d=\"M15 8V2\"/><path d=\"M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z\"/>","download":"<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"7 10 12 15 17 10\"/><line x1=\"12\" y1=\"15\" x2=\"12\" y2=\"3\"/>","gear":"<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>","zap":"<polygon points=\"13 2 3 14 12 14 11 22 21 10 12 10 13 2\"/>","trash":"<path d=\"M3 6h18\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/><line x1=\"10\" y1=\"11\" x2=\"10\" y2=\"17\"/><line x1=\"14\" y1=\"11\" x2=\"14\" y2=\"17\"/>","refresh":"<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/>","plus":"<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>","send":"<path d=\"m22 2-7 20-4-9-9-4Z\"/><path d=\"M22 2 11 13\"/>","save":"<path d=\"M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z\"/><polyline points=\"17 21 17 13 7 13 7 21\"/><polyline points=\"7 3 7 8 15 8\"/>"};
const iJson = JSON.stringify(I).replace(/</g, '\\u003c');
const svg = (name) => '<svg class="ic" viewBox="0 0 24 24">' + I[name] + '</svg>';

/** 内置登录会话：内存 token -> 过期时间（简单会话，重启即失效）。 */
let sessions = {};  // token -> expireAt

class WebUI {
    /**
     * @param {object} config           Config 门面（读 webui.* 配置）
     * @param {object} agent            Agent 实例（测试 AI 用；可为 null）
     * @param {Function|null} reloadCb  保存配置后调用的重载回调（热重载插件）
     * @param {object|null} adapter     Adapter 单例（附属插件列表）
     */
    constructor(config, agent, reloadCb, adapter, extras) {
        this.config = config;
        this.agent = agent;
        this.adapter = adapter || null;
        this.reloadCb = reloadCb || null;
        this.extras = extras || {};
        this.addonMgr = this.extras.addonMgr || null;
        this.configLoader = this.extras.configLoader || null;
        this.addonCenter = this.extras.addonCenter || null;
        this.enabled = config.getBool('webui.enabled', false);
        this.host = config.getString('webui.host', '') || '127.0.0.1';
        this.port = config.getInt('webui.port', 8088);
        this.username = config.getString('webui.username', '') || 'admin';
        this.password = config.getString('webui.password', '') || '';
        this.svr = null;
        this.running = false;
    }

    /** 是否已配置密码（未配则仅本机可访问，无登录校验）。 */
    hasAuth() { return !!this.password; }

    /** 设置 Agent 实例（供 AI 会话测试）。 */
    setAgent(agent) {
        this.agent = agent;
    }

    /** 启动 HTTP 服务（Node 原生 http，lse-nodejs 可跑，绕开 LLSE HttpServer 作用域限制）。 */
    start() {
        if (!this.enabled) return;
        if (typeof http.createServer !== 'function') {
            log.warn('[HuHoBotPenguin-Llama] 当前环境无 node http，WebUI 不可用');
            return;
        }
        try {
            const server = http.createServer((req, res) => this._requestHandler(req, res, this));
            server.on('error', (e) => {
                this.running = false;
                if (e && e.code === 'EADDRINUSE') {
                    log.warn('[HuHoBotPenguin-Llama] WebUI 端口 ' + this.port + ' 被占用，500ms 后重试…');
                    setTimeout(() => { if (this.enabled && !this.running) this.start(); }, 500);
                } else {
                    log.error('[HuHoBotPenguin-Llama] WebUI 服务错误：' + (e && e.message || e));
                }
            });
            server.listen(this.port, this.host, () => {
                this.running = true;
                const displayHost = (this.host === '0.0.0.0' || this.host === '::') ? '本机所有网卡(外网可访问)' : this.host;
                log.info('[HuHoBotPenguin-Llama] WebUI 已启动：http://' + this.host + ':' + this.port +
                    '（监听 ' + displayHost + '）' + (this.hasAuth() ? '（需要登录）' : '（无密码，仅本机可安全对外）'));
            });
            this.svr = server;
        } catch (e) {
            this.running = false;
            log.error('[HuHoBotPenguin-Llama] WebUI 启动失败：' + (e && e.message || e));
        }
    }

    /** 停止 HTTP 服务。 */
    stop() {
        if (this.svr && typeof this.svr.close === 'function') {
            try { this.svr.close(); } catch (e) { /* ignore */ }
        }
        this.svr = null;
        this.running = false;
    }

    /** Node http 请求统一入口：解析 body → 路由分发。 */
    _requestHandler(req, res, self) {
        const method = req.method || 'GET';
        const fullUrl = req.url || '/';
        const url = fullUrl.split('?')[0];
        let rawBody = '';
        try {
            req.on('data', (c) => { rawBody += c; });
            req.on('end', () => {
                const ctx = self._adaptReq(req, rawBody, res);
                self._route(method, url, ctx, res, rawBody, fullUrl);
            });
        } catch (e) {
            self._json(res, 500, { error: '请求处理异常' });
        }
    }

    /** 把 Node req 适配为统一请求上下文（保留 LLSE 风格的 headers 访问）。 */
    _adaptReq(req, rawBody, res) {
        return {
            method: req.method || 'GET',
            path: (req.url || '').split('?')[0],
            body: rawBody,
            getHeader: (name) => { const v = req.headers[name.toLowerCase()]; return Array.isArray(v) ? v : (v !== undefined ? [v] : []); },
            headers: req.headers
        };
    }

    /** 简单路由分发（统一 req/res）。 */
    _route(method, url, ctx, res, body, fullUrl) {
        try {
            if (method === 'GET' && (url === '/' || url === '/index.html')) {
                this._handleIndex(ctx, res);
            } else if (method === 'POST' && url === '/api/login') {
                this._handleLogin(ctx, res);
            } else if (method === 'GET' && url === '/api/setup-status') {
                this._handleSetupStatus(ctx, res);
            } else if (method === 'POST' && url === '/api/logout') {
                this._handleLogout(ctx, res);
            } else if (method === 'GET' && url === '/api/status') {
                this._guard(() => this._handleStatus(ctx, res))(ctx, res);
            } else if (method === 'GET' && url === '/api/config') {
                this._guard(() => this._handleGetConfig(ctx, res))(ctx, res);
            } else if (method === 'POST' && url === '/api/config') {
                this._guard(() => this._handleSaveConfig(ctx, res))(ctx, res);
            } else if (method === 'GET' && url === '/api/addons') {
                this._guard(() => this._handleAddons(ctx, res))(ctx, res);
            } else if (method === 'GET' && url === '/api/tools') {
                this._guard(() => this._handleTools(ctx, res))(ctx, res);
            } else if (method === 'GET' && url === '/api/center/list') {
                ctx.url = fullUrl || (url + (url.indexOf('?') >= 0 ? '' : ''));
                this._guard(() => this._handleCenterList(ctx, res))(ctx, res);
            } else if (method === 'POST' && url === '/api/center/install') {
                this._guard(() => this._handleCenterInstall(ctx, res))(ctx, res);
            } else if (method === 'POST' && url === '/api/center/uninstall') {
                this._guard(() => this._handleCenterUninstall(ctx, res))(ctx, res);
            } else if (method === 'POST' && url === '/api/qr/start') {
                this._guard(() => this._handleQrStart(ctx, res))(ctx, res);
            } else if (method === 'GET' && url === '/api/qr/status') {
                this._guard(() => this._handleQrStatus(ctx, res))(ctx, res);
            } else if (method === 'POST' && url === '/api/qr/cancel') {
                this._guard(() => this._handleQrCancel(ctx, res))(ctx, res);
            } else if (method === 'POST' && url === '/api/chat') {
                this._guard(() => this._handleChat(ctx, res))(ctx, res);
            } else {
                this._json(res, 404, { error: 'Not Found' });
            }
        } catch (e) {
            log.error('[HuHoBotPenguin-Llama] WebUI 处理异常：' + url + ' ' + (e && e.message || e));
            try { this._json(res, 500, { error: '内部错误' }); } catch (e2) { /* ignore */ }
        }
    }

    // ---- 内部工具 ----

    /** 鉴权中间件：校验 Cookie，未通过返回 401。 */
    _guard(handler) {
        return (req, res) => {
            if (!this.hasAuth() || this._isAuthed(req)) {
                handler(req, res);
            } else {
                this._json(res, 401, { error: '未登录' });
            }
        };
    }

    _isAuthed(req) {
        try {
            let cookie = '';
            try {
                const h = req.getHeader && req.getHeader('Cookie');
                if (Array.isArray(h)) cookie = h[0] || '';
                else if (typeof h === 'string') cookie = h;
            } catch (e) { /* ignore */ }
            if (!cookie && req.headers) {
                const hv = req.headers['Cookie'] || req.headers['cookie'];
                if (Array.isArray(hv)) cookie = hv[0] || '';
                else if (typeof hv === 'string') cookie = hv;
            }
            const m = cookie.match(/huhobot_webui=([^;]+)/);
            if (!m) return false;
            const token = m[1];
            const exp = sessions[token];
            return !!exp && exp > Date.now();
        } catch (e) { return false; }
    }

    _handleLogin(req, res) {
        let body = '';
        try { body = this._readBody(req); } catch (e) { /* ignore */ }
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch (e) { /* ignore */ }
        if (data.username === this.username && data.password === this.password) {
            const token = crypto.randomBytes(16).toString('hex');
            sessions[token] = Date.now() + 12 * 3600 * 1000; // 12h
            res.setHeader('Set-Cookie', 'huhobot_webui=' + token + '; HttpOnly; Path=/');
            this._json(res, 200, { ok: true });
        } else {
            this._json(res, 401, { error: '账号或密码错误' });
        }
    }

    _handleSetupStatus(req, res) {
        const cfg = this._readConfig() || {};
        const bot = cfg.bot || {};
        this._json(res, 200, {
            ok: true,
            botConfigured: !!(bot['app-id'] && bot.secret)
        });
    }

    _handleLogout(req, res) {
        res.setHeader('Set-Cookie', 'huhobot_webui=; Max-Age=0; Path=/');
        this._json(res, 200, { ok: true });
    }

    _handleIndex(req, res) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(this._html());
    }

    _handleStatus(req, res) {
        const cfg = this._readConfig() || {};
        const bot = cfg.bot || {};
        const hasCredentials = !!(bot['app-id'] && bot.secret);
        this._json(res, 200, {
            ok: true,
            plugin: 'HuHoBotPenguin-LLSE-Llama',
            aiEnabled: !!(this.agent && this.agent.isEnabled()),
            webuiAuth: this.hasAuth(),
            configVersion: this.config.getInt('config-version', 0),
            botConfigured: hasCredentials
        });
    }

    _handleGetConfig(req, res) {
        const cfg = this._readConfig();
        if (cfg === null) { this._json(res, 500, { error: '无法读取 config.json' }); return; }
        this._json(res, 200, { ok: true, config: cfg });
    }

    _handleSaveConfig(req, res) {
        let body = '';
        try { body = this._readBody(req); } catch (e) { /* ignore */ }
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch (e) {
            this._json(res, 400, { error: 'JSON 解析失败' }); return;
        }
        const cfg = data.config;
        if (!cfg || typeof cfg !== 'object') { this._json(res, 400, { error: '缺少 config 对象' }); return; }
        try {
            log.info('[HuHoBotPenguin-Llama] WebUI 保存配置：ai.enabled=' + (cfg.ai && cfg.ai.enabled) +
                ' ai.base-url=' + (cfg.ai && cfg.ai['base-url'] || '') +
                ' ai.model=' + (cfg.ai && cfg.ai.model || '') +
                ' webui.enabled=' + (cfg.webui && cfg.webui.enabled));
        } catch (e) { /* ignore */ }
        if (!this._writeConfig(cfg)) { this._json(res, 500, { error: '写入 config.json 失败' }); return; }
        if (this.reloadCb) {
            try {
                this.reloadCb();
                this._json(res, 200, { ok: true, message: '配置已保存并热重载' });
            } catch (e) {
                this._json(res, 200, { ok: true, message: '配置已保存（热重载失败，请手动 huhobot reload）' });
            }
        } else {
            this._json(res, 200, { ok: true, message: '配置已保存（执行 huhobot reload 生效）' });
        }
    }

    // ---- 扫码绑定 ----

    /** 启动扫码会话；生成 SVG 二维码与链接。 */
    _handleQrStart(req, res) {
        try {
            const s = qrLogin.startSession({ source: 'HuHoBotPenguin', force: true });
            // 成功后写入 config 并热重载（控制台路径在 main.js 挂，WebUI 在这里挂）
            if (!s.__webuiBound) {
                s.__webuiBound = true;
                s.on('success', (creds) => {
                    try {
                        const cfgPath = this.configLoader
                            ? path.join(this.configLoader.root(), 'config.json')
                            : null;
                        if (cfgPath) qrLogin.saveCredentialsToConfig(cfgPath, creds);
                        if (this.reloadCb) {
                            try { this.reloadCb(); } catch (e) { /* ignore */ }
                        }
                    } catch (e) {
                        log.error('[HuHoBotPenguin-Llama] 扫码成功但写入配置失败：' + (e && e.message || e));
                    }
                });
            }
            // 等第一次 qr 事件（最多 8s），再返回 URL
            const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
            const got = new Promise((resolve) => {
                if (s.url && s.state === 'waiting') {
                    resolve({ url: s.url });
                    return;
                }
                s.once('qr', (e) => resolve(e));
            });
            Promise.race([got, timeout]).then((e) => {
                const url = (e && e.url) || s.url || '';
                if (!url) {
                    this._json(res, 502, { error: '创建扫码任务超时，请重试', state: s.snapshot() });
                    return;
                }
                let svg = '';
                try { svg = qrSvg.toSvg(url, { size: 220 }); } catch (err) { /* ignore */ }
                this._json(res, 200, {
                    ok: true,
                    url,
                    svg,
                    state: s.snapshot()
                });
            });
        } catch (e) {
            this._json(res, 500, { error: (e && e.message) || '启动扫码失败' });
        }
    }

    _handleQrStatus(req, res) {
        const s = qrLogin.getSession();
        if (!s) {
            this._json(res, 200, { ok: true, state: 'idle', url: '', credentials: null });
            return;
        }
        const snap = s.snapshot();
        this._json(res, 200, { ok: true, ...snap });
    }

    _handleQrCancel(req, res) {
        const ok = qrLogin.cancelSession();
        this._json(res, 200, { ok, message: ok ? '已取消' : '没有进行中的会话' });
    }

    _handleAddons(req, res) {
        const addons = this.adapter ? this.adapter.getAddons() : [];
        this._json(res, 200, { ok: true, addons });
    }

    _handleTools(req, res) {
        const builtin = [
            { key: 'query_online', desc: '查询在线玩家', permission: 0 },
            { key: 'query_whitelist', desc: '查询白名单', permission: 0 },
            { key: 'execute_command', desc: '执行控制台命令', permission: 1 }
        ];
        let skills = [];
        if (this.agent && Array.isArray(this.agent.skills)) {
            skills = this.agent.skills.map((s) => ({
                key: 'skill__' + s.key,
                skillKey: s.key,
                desc: s.desc || s.name || s.key,
                permission: s.permission || 0,
                command: s.command || '',
                params: s.params || []
            }));
        } else {
            // Agent 未注入时从配置读
            try {
                const list = this.config.getList('ai.skills') || [];
                skills = list.map((s) => ({
                    key: 'skill__' + (s.key || ''),
                    skillKey: s.key || '',
                    desc: s.desc || s.name || s.key || '',
                    permission: s.permission || 0,
                    command: s.command || '',
                    params: []
                }));
            } catch (e) { /* ignore */ }
        }
        this._json(res, 200, { ok: true, builtin, skills, total: builtin.length + skills.length });
    }

    _centerState() {
        const enabled = this.config.getBool('addon-center.enabled', true);
        const apiBase = this.config.getString('addon-center.api-base', '') || 'https://addon.txssb.cn/api.php';
        const filterLse = this.config.getBool('addon-center.filter-lse-only', true);
        const root = this.configLoader && this.configLoader.root
            ? this.configLoader.root()
            : process.cwd();
        return {
            enabled,
            apiBase,
            filterLse,
            installRoot: require('path').join(root, 'addons')
        };
    }

    _installedByAddonMgr() {
        if (this.addonMgr && typeof this.addonMgr.listInstalledMeta === 'function') {
            return this.addonMgr.listInstalledMeta();
        }
        return [];
    }

    /** 名称归一化：忽略大小写 / 空格 / 连字符 / 下划线，便于中心名与本地目录对齐 */
    _normName(s) {
        return String(s || '').toLowerCase().replace(/[\s_\-]+/g, '');
    }

    _markInstalled(plugins, installedMeta) {
        const byKey = new Map();
        for (const it of installedMeta) {
            const keys = [it.name, it.folder].filter(Boolean).map((x) => this._normName(x));
            for (const k of keys) {
                if (k && !byKey.has(k)) byKey.set(k, it);
            }
        }
        const ac = this.addonCenter;
        return (plugins || []).map((p) => {
            const hit = byKey.get(this._normName(p.name)) || byKey.get(this._normName(p.id));
            const remoteVer = String(p.version || '');
            const localVer = hit ? String(hit.version || '') : '';
            let updateAvailable = false;
            if (hit && ac && typeof ac.compareVersions === 'function') {
                updateAvailable = ac.compareVersions(remoteVer, localVer) > 0;
            }
            const isLse = !ac || typeof ac.isLsePlugin !== 'function' || ac.isLsePlugin(p);
            return Object.assign({}, p, {
                installed: !!hit,
                installedFolder: hit ? hit.folder : null,
                installedVersion: localVer,
                loaded: hit ? !!hit.loaded : false,
                updateAvailable,
                isLse,
                canInstall: isLse && (!hit || updateAvailable)
            });
        });
    }

    async _handleCenterList(req, res) {
        const c = this._centerState();
        if (!c.enabled) {
            this._json(res, 400, { error: '插件中心已关闭（addon-center.enabled=false）' });
            return;
        }
        if (!this.addonCenter) {
            this._json(res, 500, { error: 'addoncenter 模块未注入' });
            return;
        }
        let search = '';
        try {
            const u = new URL((req && req.url) || '/api/center/list', 'http://127.0.0.1');
            search = u.searchParams.get('search') || '';
        } catch (e) { /* ignore */ }
        try {
            const data = await this.addonCenter.listPlugins(c.apiBase, { search });
            let plugins = data.plugins || [];
            plugins = this._markInstalled(plugins, this._installedByAddonMgr());
            // filter-lse-only 仅隐藏非 LSE；无论开关与否，非 LSE 都不可安装（canInstall=false）
            if (c.filterLse) {
                plugins = plugins.filter((p) => p.isLse);
            }
            this._json(res, 200, {
                ok: true,
                plugins,
                total: plugins.length,
                filterLse: c.filterLse
            });
        } catch (e) {
            this._json(res, 502, { error: '查询插件中心失败：' + (e && e.message || e) });
        }
    }

    async _handleCenterInstall(req, res) {
        const c = this._centerState();
        if (!c.enabled) {
            this._json(res, 400, { error: '插件中心已关闭（addon-center.enabled=false）' });
            return;
        }
        if (!this.addonCenter) {
            this._json(res, 500, { error: 'addoncenter 模块未注入' });
            return;
        }
        let body = '';
        try { body = this._readBody(req); } catch (e) { /* ignore */ }
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch (e) { /* ignore */ }
        const id = String(data.id || '').trim();
        const force = !!data.force;
        if (!id) {
            this._json(res, 400, { error: '缺少插件 ID' });
            return;
        }

        // 预检：类型 / 已安装
        try {
            const detail = await this.addonCenter.pluginDetail(c.apiBase, id);
            const p = detail && detail.plugin ? detail.plugin : detail;
            const isLse = !this.addonCenter.isLsePlugin || this.addonCenter.isLsePlugin(p);
            if (!isLse) {
                this._json(res, 400, { error: '该插件不是 LLSE/LSE 类型（server_type=' + (p && p.server_type || '?') + '），无法安装到本插件 addons 目录' });
                return;
            }
            const installed = this._markInstalled([p], this._installedByAddonMgr())[0];
            if (installed && installed.installed && !installed.updateAvailable && !force) {
                this._json(res, 409, {
                    error: '已安装 ' + installed.name +
                        (installed.installedVersion ? ' v' + installed.installedVersion : '') +
                        '（与中心版本一致）。如需覆盖损坏安装请使用 force',
                    alreadyInstalled: true,
                    installedVersion: installed.installedVersion
                });
                return;
            }
            if (installed && installed.installed && installed.updateAvailable) {
                // 更新：先卸载旧版再装新版
                const folder = installed.installedFolder || installed.name;
                if (this.addonMgr && typeof this.addonMgr.uninstall === 'function') {
                    this.addonMgr.uninstall(folder);
                }
            }
        } catch (e) {
            // 详情失败不阻断下载
            log.warn('[HuHoBotPenguin] 安装前预检失败（继续下载）：' + e.message);
        }

        try {
            const r = await this.addonCenter.downloadAndInstall({
                apiBase: c.apiBase,
                id,
                installRoot: c.installRoot,
                force
            });
            let loaded = false;
            if (this.addonMgr && typeof this.addonMgr.load === 'function') {
                loaded = !!this.addonMgr.load(r.folder);
            }
            this._json(res, 200, {
                ok: true,
                name: r.name,
                version: r.version,
                folder: r.folder,
                loaded,
                message: '已安装到 addons/' + r.folder + (loaded ? '，并已热加载' : '（请检查加载日志）')
            });
        } catch (e) {
            if (e && e.code === 'EEXIST') {
                this._json(res, 409, {
                    error: '目录已存在：addons/' + e.folder + '。确认覆盖请使用 force',
                    folder: e.folder
                });
                return;
            }
            this._json(res, 500, { error: '安装失败：' + (e && e.message || e) });
        }
    }

    async _handleCenterUninstall(req, res) {
        if (!this.addonMgr || typeof this.addonMgr.uninstall !== 'function') {
            this._json(res, 500, { error: '附属插件管理器不可用' });
            return;
        }
        let body = '';
        try { body = this._readBody(req); } catch (e) { /* ignore */ }
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch (e) { /* ignore */ }
        const name = String(data.name || data.folder || '').trim();
        if (!name) {
            this._json(res, 400, { error: '缺少插件名称/目录名' });
            return;
        }
        const r = this.addonMgr.uninstall(name);
        if (!r.ok) {
            this._json(res, 404, { error: r.error || '卸载失败' });
            return;
        }
        this._json(res, 200, { ok: true, folder: r.folder, message: '已卸载并删除 addons/' + r.folder });
    }

    _handleChat(req, res) {
        let body = '';
        try { body = this._readBody(req); } catch (e) { /* ignore */ }
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch (e) { /* ignore */ }
        const messages = Array.isArray(data.messages) ? data.messages : [];
        if (!this.agent || !this.agent.isEnabled()) {
            this._json(res, 400, { error: 'AI 未启用（ai.enabled 需为 true 且配置 base-url）' }); return;
        }
        this.agent.chatTest(messages).then((reply) => {
            this._json(res, 200, { ok: true, reply });
        }).catch((e) => {
            this._json(res, 500, { error: 'AI 调用失败：' + (e && e.message || e) });
        });
    }

    // ---- 配置读写 ----

    _configPath() {
        // webui.js 在插件根目录：config.json 与 main.js 同级
        let root = null;
        if (this.configLoader && typeof this.configLoader.root === 'function') {
            try { root = this.configLoader.root(); } catch (e) { /* ignore */ }
        }
        if (!root) {
            root = (typeof __dirname !== 'undefined') ? __dirname : process.cwd();
        }
        return path.join(root, 'config.json');
    }

    _readConfig() {
        try {
            return JSON.parse(fs.readFileSync(this._configPath(), 'utf8'));
        } catch (e) { return null; }
    }

    _writeConfig(cfg) {
        try {
            fs.writeFileSync(this._configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
            return true;
        } catch (e) {
            log.error('[HuHoBotPenguin-Llama] 保存配置失败：' + (e && e.message || e));
            return false;
        }
    }

    // ---- Helper ----

    _readBody(req) {
        return (req && req.body) || '';
    }

    _json(res, code, obj) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = code;
        res.end(JSON.stringify(obj));
    }

    /** 内嵌单页 HTML：登录页 + 深色侧边栏多页面管理面板（参考 SparkBridge3 后台布局）。 */
    _html() {
        const fields = [
            { g: 'AI 设置', t: 'ai', fields: [
                { p: 'ai.enabled', l: '启用 AI', typ: 'bool' },
                { p: 'ai.base-url', l: '接口地址', ph: 'https://api.openai.com/v1' },
                { p: 'ai.api-key', l: 'API 密钥', typ: 'password' },
                { p: 'ai.model', l: '模型', ph: 'gpt-4o-mini' },
                { p: 'ai.system-prompt', l: '系统提示词', typ: 'textarea' },
                { p: 'ai.max-tokens', l: '最大 tokens', typ: 'number' },
                { p: 'ai.temperature', l: '温度', typ: 'step' },
                { p: 'ai.context-limit', l: '上下文条数', typ: 'number' },
                { p: 'ai.timeout', l: '超时(ms)', typ: 'number' }
            ]},
            { g: 'WebUI', t: 'webui', fields: [
                { p: 'webui.enabled', l: '启用 WebUI', typ: 'bool' },
                { p: 'webui.host', l: '监听地址', typ: 'select', opts: ['127.0.0.1', '0.0.0.0'], ph: '127.0.0.1(仅本机) / 0.0.0.0(外网)' },
                { p: 'webui.port', l: '端口', typ: 'number' },
                { p: 'webui.username', l: '用户名' },
                { p: 'webui.password', l: '密码', typ: 'password' }
            ]},
            { g: '管理员', t: 'admin', fields: [
                { p: 'admin.mode', l: '管理员判定方式', typ: 'select', opts: ['both', 'qq', 'manual'], ph: 'both' },
                { p: 'admin.openids', l: '群管理员 OpenID', typ: 'csv', ph: '逗号分隔，配置群命令管理员' },
                { p: 'ai.admin-openids', l: 'AI 执行命令 OpenID', typ: 'csv', ph: '逗号分隔，授权 AI 执行控制台命令' }
            ]},
            { g: '服务器', t: 'server', fields: [
                { p: 'serverName', l: '服务器名' },
                { p: 'bot.name', l: '机器人名' },
                { p: 'bot.app-id', l: 'AppID' },
                { p: 'bot.secret', l: 'Secret', typ: 'password' }
            ]},
            { g: '扫码绑定（免填 AppID/Secret）', t: 'qr', fields: [] },
            { g: '聊天格式', t: 'chat', fields: [
                { p: 'chat-format.from-game', l: '游戏→群' },
                { p: 'chat-format.from-group', l: '群→游戏' },
                { p: 'chat-format.start-with', l: '转发前缀(空=全部)' }
            ]},
            { g: 'Markdown / MOTD', t: 'md', fields: [
                { p: 'motd.use-markdown', l: 'Markdown 总开关', typ: 'bool' },
                { p: 'motd.ip', l: 'MOTD 状态图 IP' },
                { p: 'motd.port', l: 'MOTD 端口', typ: 'number' },
                { p: 'motd.api', l: '状态图 API 模板' },
                { p: 'motd.text', l: '查在线文本模板', typ: 'textarea' }
            ]},
            { g: '插件中心', t: 'center', fields: [
                { p: 'addon-center.enabled', l: '启用插件中心', typ: 'bool' },
                { p: 'addon-center.api-base', l: 'API 地址', ph: 'https://addon.txssb.cn/api.php' },
                { p: 'addon-center.filter-lse-only', l: '仅显示 LLSE 插件', typ: 'bool' }
            ]}
        ];
        const fieldsJson = JSON.stringify(fields).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HuHoBotPenguin-Llama</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b0e18;color:#e2e8f0;height:100vh;overflow:hidden}
a{color:#60a5fa;text-decoration:none}
.layout{display:flex;height:100vh}
/* 侧边栏 */
.side{width:220px;min-width:220px;background:#11152c;border-right:1px solid #1e2744;display:flex;flex-direction:column;padding:18px 12px;gap:4px;overflow-y:auto}
.side .logo{font-size:16px;font-weight:700;padding:6px 10px 16px;background:linear-gradient(135deg,#6366f1,#8b5cf6,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;border-bottom:1px solid #1e2744;margin-bottom:12px}
.nav{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:9px;color:#94a3b8;cursor:pointer;font-size:14px}
.nav:hover{background:#1a2040;color:#e2e8f0}
.nav.active{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-weight:600}
svg.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.nav .ico{width:20px;display:flex;align-items:center;justify-content:center}
.btn svg.ic{width:14px;height:14px;margin-right:5px;vertical-align:-3px}
h2 svg.ic{width:18px;height:18px;color:#a5b4fc}
.iconbtn{padding:5px 8px;border:1px solid #2a3358;border-radius:8px;background:#1a2040;color:#f87171;cursor:pointer;display:inline-flex;align-items:center}
.iconbtn:hover{background:#2a1a25}
.iconbtn svg.ic{width:14px;height:14px}
.side .foot{margin-top:auto;padding-top:14px;border-top:1px solid #1e2744}
.side .foot button{width:100%;padding:9px;border-radius:8px;border:1px solid #2a3358;background:#1a2040;color:#cbd5e1;cursor:pointer;font-size:13px}
.side .foot button:hover{background:#232b4a}
/* 主区 */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.top{display:flex;align-items:center;gap:12px;padding:14px 22px;background:#0f1326;border-bottom:1px solid #1e2744}
.top .ttl{font-size:16px;font-weight:600;color:#f1f5f9}
.hamb{display:none;cursor:pointer;font-size:20px;color:#94a3b8}
.content{flex:1;overflow-y:auto;padding:20px 22px}
.card{background:#151a30;border:1px solid #232b4a;border-radius:14px;padding:18px;margin-bottom:16px}
.card h2{font-size:15px;color:#a5b4fc;display:flex;align-items:center;gap:8px;margin-bottom:14px;font-weight:600}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat{background:#1a2040;border:1px solid #232b4a;border-radius:12px;padding:16px;text-align:center}
.stat .num{font-size:28px;font-weight:700;color:#f1f5f9}
.stat .lab{font-size:12px;color:#94a3b8;margin-top:4px}
.tools{display:flex;flex-direction:column;gap:8px}
.tool{display:flex;align-items:center;gap:10px;background:#1a2040;border:1px solid #232b4a;border-radius:10px;padding:11px 12px}
.tool .tk{font-family:monospace;color:#7dd3fc;font-size:13px}
.tool .td{font-size:12px;color:#94a3b8}
.tool .tag{margin-left:auto;font-size:10px;padding:2px 8px;border-radius:10px}
.tag.adm{background:#3b1d2c;color:#f9a8d4}
.tag.pub{background:#123a2d;color:#6ee7b7}
.grp{border:1px solid #232b4a;background:#1a2040;border-radius:12px;padding:14px;margin-bottom:12px}
.grp h3{font-size:13px;color:#a5b4fc;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.row{display:flex;align-items:center;gap:10px;margin:6px 0}
.row label{min-width:150px;font-size:13px;color:#cbd5e1}
.row input,.row select{flex:1;max-width:360px;padding:7px 10px;border-radius:8px;border:1px solid #2a3358;background:#0b0e18;color:#e2e8f0;font-size:13px;outline:none}
.row input:focus,.row select:focus{border-color:#6366f1}
.row textarea{flex:1;max-width:520px;min-height:50px;padding:7px;border-radius:8px;border:1px solid #2a3358;background:#0b0e18;color:#e2e8f0;font-size:13px;outline:none}
.btn{padding:7px 16px;border:1px solid #2a3358;border-radius:9px;background:#232b4a;color:#e2e8f0;cursor:pointer;font-size:13px}
.btn.primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;color:#fff;font-weight:600}
.btn:hover{filter:brightness(1.1)}
textarea#chat_in{width:100%;min-height:70px;border-radius:10px;border:1px solid #2a3358;background:#0b0e18;color:#e2e8f0;padding:10px;outline:none;resize:vertical}
pre.out{white-space:pre-wrap;background:#0b0e18;border:1px solid #1e2744;border-radius:10px;padding:12px;margin-top:12px;max-height:260px;overflow:auto;color:#a5f3fc;font-size:13px}
textarea#rawCfg{width:100%;min-height:220px;background:#0b0e18;border:1px solid #1e2744;color:#a5f3fc;border-radius:10px;padding:10px;font-family:monospace;font-size:12px}
.msg{margin-top:10px;font-size:13px}.msg.done{color:#6ee7b7}.msg.err{color:#f87171}
.raw-wrap{display:none;margin-top:12px}
.swp{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.sw{display:flex;align-items:center;gap:8px;background:#1a2040;border:1px solid #232b4a;padding:9px 16px;border-radius:20px;font-size:13px;cursor:pointer}
.sw.on{background:#123a2d;border-color:#10b981}.sw input{display:none}
.pg{display:none}.pg.show{display:block}
#login{position:fixed;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;align-items:center;justify-content:center;background:#0b0e18}
#login>div{max-width:340px;width:100%;padding:28px;background:#151a30;border:1px solid #232b4a;border-radius:16px;text-align:center}
#login h1{font-size:20px;margin-bottom:18px;background:linear-gradient(135deg,#6366f1,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
#login input{width:100%;padding:10px;border-radius:9px;border:1px solid #2a3358;background:#0b0e18;color:#e2e8f0;margin:6px 0;outline:none}
.hint{font-size:11px;color:#64748b;margin-top:10px}
.setup-tab{flex:1;padding:10px;border-radius:10px;border:1px solid #2a3358;background:#1a2040;color:#94a3b8;cursor:pointer;font-size:13px;text-align:center;transition:all .2s}
.setup-tab.active{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-color:#6366f1;font-weight:600}
#setup_qr .qr-svg svg{width:200px;height:200px}
.badge{font-size:11px;background:#1e2744;padding:4px 12px;border-radius:20px;color:#94a3b8}
.badge.on{background:linear-gradient(135deg,#10b981,#14b8a6);color:#052e25}
.badge.off{background:#1e2744;color:#64748b}
/* 移动端 */
@media(max-width:720px){
  .side{position:fixed;left:-240px;top:0;bottom:0;z-index:50;transition:left .25s;box-shadow:4px 0 20px rgba(0,0,0,.4)}
  .side.open{left:0}
  .hamb{display:block}
  .top{padding:14px 16px}
  .grid2{grid-template-columns:1fr}
  .row{flex-direction:column;align-items:stretch}
  .row label{min-width:0}
  .row input,.row select{max-width:100%}
}
</style></head><body>
<div id="login">
  <div>
    <h1>HuHoBotPenguin-Llama</h1>
    <input id="l_u" placeholder="用户名">
    <input id="l_p" type="password" placeholder="密码">
    <button class="btn primary" onclick="login()" style="width:100%;margin-top:8px">登 录</button>
    <div class="msg" id="l_msg"></div>
  </div>
</div>

<div id="setup" style="display:none">
  <div style="max-width:480px;margin:60px auto;padding:32px;background:#151a30;border:1px solid #232b4a;border-radius:16px;text-align:center">
    <div style="font-size:48px;margin-bottom:12px">🐧</div>
    <h1 style="font-size:22px;margin-bottom:6px;background:linear-gradient(135deg,#6366f1,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent">欢迎使用 HuHoBotPenguin</h1>
    <p style="font-size:13px;color:#94a3b8;margin-bottom:24px">首次使用，请先绑定 QQ 机器人</p>

    <div style="display:flex;gap:12px;margin-bottom:20px">
      <div id="setup_tab_qr" class="setup-tab active" onclick="setupTab('qr')">📱 扫码绑定</div>
      <div id="setup_tab_manual" class="setup-tab" onclick="setupTab('manual')">✏️ 手动填写</div>
    </div>

    <!-- 扫码绑定 -->
    <div id="setup_qr">
      <div style="background:#1a2040;border:1px solid #232b4a;border-radius:12px;padding:20px;margin-bottom:16px">
        <div id="setup_qr_box" style="min-height:220px;display:flex;align-items:center;justify-content:center">
          <button class="btn primary" id="setup_qr_btn" onclick="setupQrStart()" style="font-size:15px;padding:12px 28px">生成二维码</button>
        </div>
        <div class="msg" id="setup_qr_msg" style="margin-top:10px"></div>
      </div>
      <div style="font-size:12px;color:#64748b">手机 QQ 扫码后自动写入凭据并重载</div>
    </div>

    <!-- 手动填写 -->
    <div id="setup_manual" style="display:none">
      <div style="text-align:left;background:#1a2040;border:1px solid #232b4a;border-radius:12px;padding:20px">
        <div class="row" style="margin:8px 0"><label style="min-width:80px">AppID</label><input id="setup_appid" placeholder="QQ 开放平台 AppID"></div>
        <div class="row" style="margin:8px 0"><label style="min-width:80px">Secret</label><input id="setup_secret" type="password" placeholder="QQ 开放平台 AppSecret"></div>
      </div>
      <button class="btn primary" onclick="setupManualSave()" style="margin-top:16px;font-size:15px;padding:10px 28px">保存并连接</button>
      <div class="msg" id="setup_manual_msg" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:20px"><a href="https://q.qq.com" target="_blank" style="font-size:12px;color:#64748b">没有凭据？去 QQ 开放平台创建机器人 →</a></div>
  </div>
</div>

<div id="app" style="display:none" class="layout">
  <aside class="side" id="side">
    <div class="logo">🐧 HuHoBotPenguin<br>Llama</div>
    <div class="nav active" onclick="showPage('overview',this)"><span class="ico"><svg class="ic" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg></span>总览</div>
    <div class="nav" onclick="showPage('tools',this)"><span class="ico"><svg class="ic" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>AI 工具</div>
    <div class="nav" onclick="showPage('skills',this)"><span class="ico"><svg class="ic" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg></span>Skill 管理</div>
    <div class="nav" onclick="showPage('chat',this)"><span class="ico"><svg class="ic" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>AI 对话</div>
    <div class="nav" onclick="showPage('addons',this)"><span class="ico"><svg class="ic" viewBox="0 0 24 24"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/></svg></span>附属插件</div>
    <div class="nav" onclick="showPage('center',this)"><span class="ico"><svg class="ic" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>插件中心</div>
    <div class="nav" onclick="showPage('config',this)"><span class="ico"><svg class="ic" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></span>配置</div>
    <div class="foot"><button onclick="logout()">退出登录</button></div>
  </aside>
  <div class="main">
    <div class="top">
      <span class="hamb" onclick="toggleSide()">☰</span>
      <span class="ttl" id="page_ttl">总览</span>
      <span class="badge" id="st_ai" style="margin-left:auto">AI —</span>
    </div>
    <div class="content">
      <!-- 总览 -->
      <div class="pg show" id="pg_overview">
        <div class="grid2">
          <div class="stat"><div class="num" id="st_ver">—</div><div class="lab">配置版本</div></div>
          <div class="stat"><div class="num">3</div><div class="lab">可用工具</div></div>
        </div>
        <div class="card"><h2><svg class="ic" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>快捷开关</h2>
          <div class="swp">
            <label class="sw" id="sw_ai"><input type="checkbox" onchange="quickToggle(this,'ai.enabled')"><span class="cap">AI 开关</span></label>
            <label class="sw" id="sw_md"><input type="checkbox" onchange="quickToggle(this,'motd.use-markdown')"><span class="cap">Markdown</span></label>
          </div>
        </div>
      </div>
      <!-- 工具 -->
      <div class="pg" id="pg_tools">
        <div class="card"><h2><svg class="ic" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>AI 可用工具
          <button class="btn" onclick="loadTools()" style="margin-left:auto"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>刷新</button>
        </h2>
          <div id="toolList"></div>
          <div class="hint">AI 通过 function calling 自动调用；「执行命令」与 permission=1 的 Skill 仅 ai.admin-openids 中管理员可用。自定义 Skill 在「Skill 管理」保存后，点此处刷新或热重载后生效。</div>
        </div>
      </div>
      <!-- Skill 管理 -->
      <div class="pg" id="pg_skills">
        <div class="card">
          <h2><svg class="ic" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>内置工具（固定，不可删）</h2>
          <div class="tools">
            <div class="tool"><div class="tk">query_online</div><div class="td">查询在线玩家</div><span class="tag pub">公开</span></div>
            <div class="tool"><div class="tk">query_whitelist</div><div class="td">查询白名单</div><span class="tag pub">公开</span></div>
            <div class="tool"><div class="tk">execute_command</div><div class="td">执行任意控制台命令</div><span class="tag adm">管理员</span></div>
          </div>
          <div class="hint" style="margin-top:10px">内置工具始终可用；"execute_command" 仅 ai.admin-openids 中管理员可调。</div>
        </div>
        <div class="card">
          <h2><svg class="ic" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>自定义 Skill
            <button class="btn primary" onclick="addSkillRow()" style="margin-left:auto"><svg class="ic" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg>新增</button>
            <button class="btn" onclick="saveSkills()"><svg class="ic" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>保存</button>
          </h2>
          <div class="hint" style="margin-bottom:10px">自定义 AI 可调用的 Skill：AI 调用后会在控制台执行你配置的命令。命令模板用 {0}、{1}… 作为参数占位（由 AI 按顺序填写）；permission 填 1 表示仅 ai.admin-openids 管理员可调用。</div>
          <div style="margin-bottom:10px">
            <span class="hint">快速添加预设：</span>
            <button class="btn" onclick="addSkillPreset('money_query')">查金币</button>
            <button class="btn" onclick="addSkillPreset('money_add')">加金币</button>
            <button class="btn" onclick="addSkillPreset('money_reduce')">扣金币</button>
            <button class="btn" onclick="addSkillPreset('money_pay')">转金币</button>
            <button class="btn" onclick="addSkillPreset('kick')">踢出玩家</button>
            <button class="btn" onclick="addSkillPreset('ban')">封禁玩家</button>
          </div>
          <div id="skillRows"></div>
          <div class="msg" id="skill_msg"></div>
        </div>
      </div>
      <!-- AI 对话 -->
      <div class="pg" id="pg_chat">
        <div class="card"><h2><svg class="ic" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>AI 对话测试</h2>
          <textarea id="chat_in" placeholder="输入消息，例如：查一下现在谁在线、给我查下白名单…"></textarea>
          <button class="btn primary" onclick="sendChat()" style="margin-top:8px"><svg class="ic" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>发送</button>
          <pre class="out" id="chat_out"></pre>
        </div>
      </div>
      <!-- 附属插件 -->
      <div class="pg" id="pg_addons">
        <div class="card"><h2><svg class="ic" viewBox="0 0 24 24"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/></svg>已加载的附属插件
          <button class="btn" onclick="loadAddons()" style="margin-left:auto"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>刷新</button>
        </h2>
          <div id="addonList"></div>
          <div class="hint" style="margin-top:10px">附属插件在其加载时调用 <code>registerAddon(名称, 版本, 描述, 作者)</code> 注册元数据后才会显示在这里；群内指令「已加载插件」可查看同样内容。</div>
        </div>
      </div>
      <!-- 插件中心 -->
      <div class="pg" id="pg_center">
        <div class="card"><h2><svg class="ic" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>插件中心
          <button class="btn" onclick="loadCenter()" style="margin-left:auto"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>刷新</button>
        </h2>
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            <input id="center_q" placeholder="搜索插件名称 / 描述…" style="flex:1;min-width:160px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);" onkeydown="if(event.key==='Enter')loadCenter()">
            <button class="btn primary" onclick="loadCenter()">搜索</button>
          </div>
          <div id="centerList"></div>
          <div class="msg" id="center_msg"></div>
          <div class="hint" style="margin-top:10px">从 <a href="https://addon.txssb.cn" target="_blank" style="color:var(--cyan)">HuHoBot 附属插件中心</a> 下载并安装到 <code>addons/</code>。已存在同名目录需勾选强制覆盖。控制台也可用：<code>huhobot install &lt;插件ID&gt; [force]</code></div>
        </div>
      </div>
      <!-- 配置 -->
      <div class="pg" id="pg_config">
        <div class="card">
          <h2><svg class="ic" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>配置
            <button class="btn" onclick="loadCfg()" style="margin-left:auto"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>重新加载</button>
            <button class="btn primary" onclick="saveCfg()"><svg class="ic" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>保存并生效</button>
            <button class="btn" onclick="rawToggle()">高级(JSON)</button>
          </h2>
          <div id="formWrap"></div>
          <div class="raw-wrap" id="rawWrap"><textarea id="rawCfg"></textarea></div>
          <div class="msg" id="cfg_msg"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
const FIELDS = ${fieldsJson};
const I = ${iJson};
const PG_TITLES = {overview:'总览',tools:'AI 工具',skills:'Skill 管理',chat:'AI 对话',addons:'附属插件',center:'插件中心',config:'配置'};
let CFG = {};
async function j(url,opt){const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opt});return {ok:r.ok,data:await r.json().catch(()=>({}))};}
function g(p,o){return p.split('.').reduce((a,k)=>a&&a[k]!==undefined?a[k]:undefined,o);}
function s(p,v,o){const ks=p.split('.');let n=o;for(let i=0;i<ks.length-1;i++){if(!n[ks[i]]||typeof n[ks[i]]!=='object')n[ks[i]]={};n=n[ks[i]];}n[ks[ks.length-1]]=v;}
function showPage(name,el){document.querySelectorAll('.pg').forEach(x=>x.classList.remove('show'));document.getElementById('pg_'+name).classList.add('show');document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));if(el)el.classList.add('active');document.getElementById('page_ttl').textContent=PG_TITLES[name]||name;if(name==='addons')loadAddons();if(name==='center')loadCenter();if(name==='config')loadCfg();if(name==='tools')loadTools();if(window.innerWidth<=720)document.getElementById('side').classList.remove('open');}
function toggleSide(){document.getElementById('side').classList.toggle('open');}
async function login(){const r=await j('/api/login',{method:'POST',body:JSON.stringify({username:document.getElementById('l_u').value,password:document.getElementById('l_p').value})});if(r.ok){document.getElementById('login').style.display='none';document.getElementById('l_msg').textContent='';const sr=await j('/api/setup-status');if(sr.ok&&!sr.data.botConfigured){document.getElementById('setup').style.display='block';}else{document.getElementById('app').style.display='flex';await status();await loadCfg();await loadTools();}}else{document.getElementById('l_msg').className='msg err';document.getElementById('l_msg').textContent=r.data.error||'登录失败';}}
async function logout(){await j('/api/logout',{method:'POST'});location.reload();}
async function status(){const r=await j('/api/status');if(r.ok){const d=r.data;const el=document.getElementById('st_ai');el.textContent=d.aiEnabled?'AI ● 已启用':'AI ○ 未启用';el.className='badge '+(d.aiEnabled?'on':'off');document.getElementById('st_ver').textContent='v'+(d.configVersion||'?');}}
function buildForm(){const w=document.getElementById('formWrap');w.innerHTML='';const gi={ai:'zap',webui:'plug',admin:'gear',server:'wrench',chat:'chat',md:'dashboard',center:'download',qr:'blocks'};FIELDS.forEach(grp=>{const div=document.createElement('div');div.className='grp';let h='<h3>'+(gi[grp.t]?'<svg class="ic" viewBox="0 0 24 24">'+I[gi[grp.t]]+'</svg> ':'')+grp.g+'</h3>';if(grp.t==='qr'){h+='<div class="hint" style="margin-bottom:10px">手机 QQ 扫码绑定，成功后自动写入 bot.app-id / bot.secret 并热重载。也可控制台执行 <code>huhobot qr</code>。</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn primary" id="qr_start" onclick="qrStart()">生成二维码</button><button class="btn" id="qr_cancel" onclick="qrCancel()">取消</button></div><div class="msg" id="qr_msg"></div><div id="qr_box" style="display:none;margin-top:10px;text-align:center"><div id="qr_svg"></div><div style="margin-top:8px;font-size:12px;color:#94a3b8;word-break:break-all" id="qr_url"></div><a id="qr_open" target="_blank" class="btn" style="display:inline-block;margin-top:8px;text-decoration:none">打开链接</a></div>';}grp.fields.forEach(f=>{const id='f_'+f.p.replace(/[.\-]/g,'_');h+='<div class="row"><label>'+f.l+'</label>';if(f.typ==='bool'){h+='<select id="'+id+'"><option value="true">开</option><option value="false">关</option></select>';}else if(f.typ==='select'){h+='<select id="'+id+'">'+(f.opts||[]).map(o=>'<option value="'+o+'">'+o+'</option>').join('')+'</select>';}else if(f.typ==='textarea'){h+='<textarea id="'+id+'" placeholder="'+(f.ph||'')+'"></textarea>';}else{h+='<input id="'+id+'" type="'+(f.typ==='password'?'password':(f.typ==='number'?'number':'text'))+'" placeholder="'+(f.ph||'')+'">';}h+='</div>';});div.innerHTML=h;w.appendChild(div);});}
function fillForm(){FIELDS.forEach(grp=>grp.fields.forEach(f=>{const el=document.getElementById('f_'+f.p.replace(/[.\-]/g,'_'));if(!el)return;const v=g(f.p,CFG);if(f.typ==='bool'){el.value=String(!!v);}else if(f.typ==='csv'){el.value=Array.isArray(v)?v.join(', '):v||'';}else{el.value=v===undefined||v===null?'':v;}}));}
function collectForm(){FIELDS.forEach(grp=>grp.fields.forEach(f=>{const el=document.getElementById('f_'+f.p.replace(/[.\-]/g,'_'));if(!el)return;let v;if(f.typ==='bool'){v=el.value==='true';}else if(f.typ==='number'){v=isNaN(Number(el.value))||el.value===''?undefined:Number(el.value);}else if(f.typ==='csv'){v=el.value.split(/[,，\s]+/).map(x=>x.trim()).filter(Boolean);}else{v=el.value;}if(v!==undefined&&v!=='')s(f.p,v,CFG);}));return CFG;}
async function loadCfg(){const r=await j('/api/config');if(!r.ok){setMsg('err',r.data.error||'加载失败');return;}CFG=r.data.config;buildForm();fillForm();document.getElementById('rawCfg').value=JSON.stringify(CFG,null,2);updateSwitches();renderSkills();setMsg('done','已加载');}
async function saveCfg(){let cfg;const raw=document.getElementById('rawWrap').style.display==='block';if(raw){try{cfg=JSON.parse(document.getElementById('rawCfg').value);}catch(e){setMsg('err','JSON 格式错误');return;}}else{cfg=collectForm();}const r=await j('/api/config',{method:'POST',body:JSON.stringify({config:cfg})});setMsg(r.ok?'done':'err',r.data.message||r.data.error||'保存');if(r.ok){CFG=cfg;setTimeout(async()=>{await loadCfg();},800);}}
function updateSwitches(){const e1=document.querySelector('#sw_ai input');const e2=document.querySelector('#sw_md input');if(e1)e1.checked=!!g('ai.enabled',CFG);if(e2)e2.checked=!!g('motd.use-markdown',CFG);document.getElementById('sw_ai').className='sw '+((g('ai.enabled',CFG))?'on':'');document.getElementById('sw_md').className='sw '+((g('motd.use-markdown',CFG))?'on':'');}
async function quickToggle(el,path){CFG=CFG||{};s(path,el.checked,CFG);el.closest('.sw').className='sw '+(el.checked?'on':'');const r=await saveCfg();}
function setMsg(cls,text){const el=document.getElementById('cfg_msg');el.className='msg '+cls;el.textContent=text;}
// ---- 预设 Skill ----
const SKILL_PRESETS={
  money_query:{key:'money_query',name:'查金币',desc:'查询玩家金币余额（LLMoney）',command:'money query {0}',permission:0},
  money_add:{key:'money_add',name:'加金币',desc:'给玩家增加金币（LLMoney）',command:'money add {0} {1}',permission:1},
  money_reduce:{key:'money_reduce',name:'扣金币',desc:'扣除玩家金币（LLMoney）',command:'money reduce {0} {1}',permission:1},
  money_pay:{key:'money_pay',name:'转金币',desc:'给玩家转金币（LLMoney）',command:'money pay {0} {1}',permission:1},
  kick:{key:'kick_player',name:'踢出玩家',desc:'把玩家踢出服务器',command:'kick {0} 你被管理员移除',permission:1},
  ban:{key:'ban_player',name:'封禁玩家',desc:'封禁玩家',command:'ban {0} 你已被封禁',permission:1}
};
function addSkillPreset(name){const p=SKILL_PRESETS[name];if(!p)return;const w=document.getElementById('skillRows');w.appendChild(skillRowHtml(JSON.parse(JSON.stringify(p)),w.children.length));smsg('done','已添加预设：'+p.name+'（记得点保存）');}

// ---- Skill 管理 ----
function renderSkills(){const w=document.getElementById('skillRows');if(!w)return;const list=CFG.ai&&Array.isArray(CFG.ai.skills)?CFG.ai.skills:[];w.innerHTML='';list.forEach((s,i)=>{w.appendChild(skillRowHtml(s,i));});}
function skillRowHtml(s,i){const div=document.createElement('div');div.className='grp';div.innerHTML='<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+
  '<input data-sf="key" value="'+(s.key||'')+'" placeholder="key(唯一)" style="width:140px">'+
  '<input data-sf="name" value="'+(s.name||'')+'" placeholder="名称" style="width:120px">'+
  '<select data-sf="permission" style="width:90px"><option value="0"'+(s.permission===1?'':' selected')+'>公开</option><option value="1"'+(s.permission===1?' selected':'')+'>仅管理员</option></select>'+
   '<button class="iconbtn" title="删除" onclick="this.parentElement.parentElement.remove()"><svg class="ic" viewBox="0 0 24 24">'+I.trash+'</svg></button></div>'+
  '<div style="margin-top:6px"><input data-sf="desc" value="'+(s.desc||'')+'" placeholder="描述(给AI看)" style="width:100%"></div>'+
  '<div style="margin-top:6px"><input data-sf="command" value="'+(s.command||'')+'" placeholder="命令模板，如 kick {0} 你被移除了" style="width:100%"></div>';
  return div;}
function addSkillRow(){const w=document.getElementById('skillRows');w.appendChild(skillRowHtml({},w.children.length));}
function collectSkills(){const rows=document.querySelectorAll('#skillRows .grp');const out=[];rows.forEach(r=>{const gs='';const g=(n)=>r.querySelector('[data-sf="'+n+'"]')&&r.querySelector('[data-sf="'+n+'"]').value||'';const key=(g('key')||'').trim(),command=(g('command')||'').trim();if(key&&command){out.push({key,name:(g('name')||key).trim(),desc:(g('desc')||'').trim(),command,permission:parseInt(g('permission')||'0',10)});}});return out;}
function smsg(cls,t){const el=document.getElementById('skill_msg');if(!el)return;el.className='msg '+cls;el.textContent=t;}
async function saveSkills(){const skills=collectSkills();CFG.ai=CFG.ai||{};CFG.ai.skills=skills;const r=await j('/api/config',{method:'POST',body:JSON.stringify({config:CFG})});smsg(r.ok?'done':'err',r.data.message||r.data.error||'保存');if(r.ok){setTimeout(async()=>{await loadCfg();await loadTools();},800);}}
function rawToggle(){const w=document.getElementById('rawWrap');const show=w.style.display!=='block';w.style.display=show?'block':'none';if(show)document.getElementById('rawCfg').value=JSON.stringify(collectForm(),null,2);}
async function sendChat(){const msg=document.getElementById('chat_in').value.trim();if(!msg)return;document.getElementById('chat_out').textContent='…思考中';const r=await j('/api/chat',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:msg}]})});document.getElementById('chat_out').textContent=r.data.reply||r.data.error||'(空)';}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
// ---- 扫码绑定 ----
let QR_POLL=null;
function qrSet(cls,t){const el=document.getElementById('qr_msg');if(!el)return;el.className='msg '+cls;el.textContent=t;}
async function qrStart(){const b=document.getElementById('qr_start');if(b){b.disabled=true;b.textContent='创建中…';}qrSet('','正在创建扫码任务…');const r=await j('/api/qr/start',{method:'POST',body:'{}'});if(b){b.disabled=false;b.textContent='生成二维码';}if(!r.ok||!r.data.url){qrSet('err',r.data.error||'启动失败');return;}const box=document.getElementById('qr_box');const sv=document.getElementById('qr_svg');const u=document.getElementById('qr_url');const a=document.getElementById('qr_open');if(sv)sv.innerHTML=r.data.svg||'';if(u)u.textContent=r.data.url;if(a)a.href=r.data.url;if(box)box.style.display='block';qrSet('done','请用手机 QQ 扫码，等待确认…');if(QR_POLL)clearInterval(QR_POLL);QR_POLL=setInterval(qrPoll,2000);qrPoll();}
async function qrPoll(){const r=await j('/api/qr/status');if(!r.ok)return;const st=r.data.state;if(st==='success'){if(QR_POLL){clearInterval(QR_POLL);QR_POLL=null;}qrSet('done','绑定成功 appId='+(r.data.credentials&&r.data.credentials.appId||'')+'，已写入配置并重载');setTimeout(async()=>{await loadCfg();},1000);}else if(st==='error'||st==='expired'||st==='cancelled'){if(QR_POLL){clearInterval(QR_POLL);QR_POLL=null;}qrSet('err',r.data.error||('会话结束：'+st));}else if(st==='waiting'){if(r.data.url){const u=document.getElementById('qr_url');const a=document.getElementById('qr_open');const sv=document.getElementById('qr_svg');if(u&&u.textContent!==r.data.url){u.textContent=r.data.url;if(a)a.href=r.data.url;if(sv&&r.data.svg)sv.innerHTML=r.data.svg;}}}}
async function qrCancel(){if(QR_POLL){clearInterval(QR_POLL);QR_POLL=null;}const r=await j('/api/qr/cancel',{method:'POST',body:'{}'});qrSet(r.ok?'done':'err',(r.data&&r.data.message)||'已取消');}
async function loadAddons(){const w=document.getElementById('addonList');if(!w)return;const r=await j('/api/addons');const list=r.ok&&Array.isArray(r.data.addons)?r.data.addons:[];if(!list.length){w.innerHTML='<div class="hint">暂无附属插件——附属插件在加载时调用 <code>ll.imports("HuHoBotPenguin","registerAddon")(名称, 版本, 描述, 作者)</code> 注册元数据后才会显示在这里。</div>';return;}w.innerHTML=list.map(a=>'<div class="tool"><div class="tk">'+esc(a.name)+(a.version?' v'+esc(a.version):'')+(a.commandCount?' · '+esc(a.commandCount)+' 条命令':'')+'</div><div class="td">'+(esc(a.description)||'无描述')+(a.author?' · '+esc(a.author):'')+'</div></div>').join('');}
async function loadTools(){const w=document.getElementById('toolList');if(!w)return;const r=await j('/api/tools');if(!r.ok){w.innerHTML='<div class="hint">'+esc(r.data.error||'加载失败')+'</div>';return;}const b=r.data.builtin||[];const s=r.data.skills||[];let h='<div class="hint" style="margin-bottom:8px">内置工具（'+b.length+'）</div><div class="tools">';b.forEach(t=>{h+='<div class="tool"><div class="tk">'+esc(t.key)+'</div><div class="td">'+esc(t.desc)+'</div><span class="tag '+(t.permission?'adm':'pub')+'">'+(t.permission?'管理员':'公开')+'</span></div>';});h+='</div>';h+='<div class="hint" style="margin:12px 0 8px">自定义 Skill（'+s.length+'）</div>';if(!s.length){h+='<div class="hint">暂无——在「Skill 管理」添加并保存后，AI 热重载即可调用</div>';}else{h+='<div class="tools">';s.forEach(t=>{h+='<div class="tool"><div class="tk">'+esc(t.key)+'</div><div class="td">'+esc(t.desc)+(t.command?' · <code>'+esc(t.command)+'</code>':'')+'</div><span class="tag '+(t.permission?'adm':'pub')+'">'+(t.permission?'管理员':'公开')+'</span></div>';});h+='</div>';}w.innerHTML=h;}
async function loadCenter(){const w=document.getElementById('centerList');const m=document.getElementById('center_msg');if(!w)return;if(m){m.className='msg';m.textContent='加载中…';}const q=(document.getElementById('center_q')&&document.getElementById('center_q').value||'').trim();const r=await j('/api/center/list'+(q?'?search='+encodeURIComponent(q):''));if(!r.ok){if(m){m.className='msg err';m.textContent=r.data.error||'加载失败';}w.innerHTML='';return;}const list=Array.isArray(r.data.plugins)?r.data.plugins:[];if(m){m.className='msg done';m.textContent='共 '+list.length+' 个结果'+(r.data.filterLse?'（已隐藏非 LLSE）':'');}if(!list.length){w.innerHTML='<div class="hint">没有匹配的插件</div>';return;}w.innerHTML=list.map(p=>{
  const tags=[];
  if(p.installed) tags.push('<span class="badge on" style="font-size:10px;padding:2px 8px">已安装'+(p.installedVersion?' v'+esc(p.installedVersion):'')+'</span>');
  if(p.updateAvailable) tags.push('<span class="badge" style="font-size:10px;padding:2px 8px;background:#4a3a10;color:#fbbf24">有更新</span>');
  if(!p.isLse) tags.push('<span class="badge off" style="font-size:10px;padding:2px 8px">非 LLSE</span>');
  let actions='';
  if(p.isLse && p.installed){
    actions+='<button class="btn" data-uninstall="'+esc(p.installedFolder||p.name)+'" onclick="uninstallCenter(this.dataset.uninstall,this)">卸载</button>';
    if(p.updateAvailable) actions+='<button class="btn primary" data-install="'+esc(p.id)+'" onclick="installCenter(this.dataset.install,false,this)">更新</button>';
  } else if(p.canInstall){
    actions+='<button class="btn primary" data-install="'+esc(p.id)+'" onclick="installCenter(this.dataset.install,false,this)">安装</button>';
  }
  return '<div class="tool"><div class="tk">'+esc(p.name)+(p.version?' v'+esc(p.version):'')+' '+tags.join(' ')+'</div><div class="td">'+(esc(p.description)||'无描述')+(p.author?' · '+esc(p.author):'')+(p.downloads!=null?' · 下载 '+esc(p.downloads):'')+(p.server_type?' · '+esc(p.server_type):'')+'<div class="hint" style="margin-top:4px">ID: <code>'+esc(p.id)+'</code>'+(p.tags&&p.tags.length?' · 标签: '+p.tags.map(esc).join(', '):'')+'</div></div><div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">'+actions+'</div></div>';
}).join('');}
async function installCenter(id,force,btn){const m=document.getElementById('center_msg');const useForce=!!force;if(btn){btn.disabled=true;btn.textContent='安装中…';}if(m){m.className='msg';m.textContent='正在下载安装 '+id+'…';}const r=await j('/api/center/install',{method:'POST',body:JSON.stringify({id:id,force:useForce})});if(btn){btn.disabled=false;btn.textContent=btn.textContent==='更新中…'?'更新':'安装';}if(!r.ok){if(m){m.className='msg err';m.textContent=r.data.error||'安装失败';}loadCenter();return;}if(m){m.className='msg done';m.textContent=r.data.message||('已安装 '+r.data.name);}loadCenter();}
async function uninstallCenter(name,btn){const m=document.getElementById('center_msg');if(!confirm('确认卸载并删除 addons/'+name+' ？'))return;if(btn){btn.disabled=true;btn.textContent='卸载中…';}const r=await j('/api/center/uninstall',{method:'POST',body:JSON.stringify({name:name})});if(btn){btn.disabled=false;btn.textContent='卸载';}if(!r.ok){if(m){m.className='msg err';m.textContent=r.data.error||'卸载失败';}return;}if(m){m.className='msg done';m.textContent=r.data.message||('已卸载 '+name);}loadCenter();}
// ---- 快速开始 ----
let SETUP_QR_POLL=null;
function setupTab(t){
  document.getElementById('setup_tab_qr').className='setup-tab'+(t==='qr'?' active':'');
  document.getElementById('setup_tab_manual').className='setup-tab'+(t==='manual'?' active':'');
  document.getElementById('setup_qr').style.display=t==='qr'?'block':'none';
  document.getElementById('setup_manual').style.display=t==='manual'?'block':'none';
}
async function setupQrStart(){
  const b=document.getElementById('setup_qr_btn');
  if(b){b.disabled=true;b.textContent='创建中…';}
  const msg=document.getElementById('setup_qr_msg');
  const box=document.getElementById('setup_qr_box');
  if(msg){msg.className='msg';msg.textContent='正在创建扫码任务…';}
  const r=await j('/api/qr/start',{method:'POST',body:'{}'});
  if(b){b.disabled=false;b.textContent='重新生成';}
  if(!r.ok||!r.data.url){if(msg){msg.className='msg err';msg.textContent=r.data.error||'启动失败';}return;}
  if(box){box.innerHTML='<div class="qr-svg">'+(r.data.svg||'')+'</div><div style="margin-top:8px;font-size:11px;color:#94a3b8;word-break:break-all">'+r.data.url+'</div>';}
  if(msg){msg.className='msg done';msg.textContent='请用手机 QQ 扫码，等待确认…';}
  if(SETUP_QR_POLL)clearInterval(SETUP_QR_POLL);
  SETUP_QR_POLL=setInterval(setupQrPoll,2000);
  setupQrPoll();
}
async function setupQrPoll(){
  const r=await j('/api/qr/status');
  if(!r.ok)return;
  const st=r.data.state;
  const msg=document.getElementById('setup_qr_msg');
  if(st==='success'){
    if(SETUP_QR_POLL){clearInterval(SETUP_QR_POLL);SETUP_QR_POLL=null;}
    if(msg){msg.className='msg done';msg.textContent='绑定成功！正在加载…';}
    setTimeout(()=>{location.reload();},1200);
  }else if(st==='error'||st==='expired'||st==='cancelled'){
    if(SETUP_QR_POLL){clearInterval(SETUP_QR_POLL);SETUP_QR_POLL=null;}
    if(msg){msg.className='msg err';msg.textContent=r.data.error||('会话结束：'+st);}
  }else if(st==='waiting'&&r.data.url){
    const box=document.getElementById('setup_qr_box');
    if(box&&r.data.svg){box.innerHTML='<div class="qr-svg">'+r.data.svg+'</div><div style="margin-top:8px;font-size:11px;color:#94a3b8;word-break:break-all">'+r.data.url+'</div>';}
  }
}
async function setupManualSave(){
  const appid=(document.getElementById('setup_appid').value||'').trim();
  const secret=(document.getElementById('setup_secret').value||'').trim();
  const msg=document.getElementById('setup_manual_msg');
  if(!appid||!secret){if(msg){msg.className='msg err';msg.textContent='请填写 AppID 和 Secret';}return;}
  const r=await j('/api/config');
  if(!r.ok){if(msg){msg.className='msg err';msg.textContent=r.data.error||'读取配置失败';}return;}
  const cfg=r.data.config||{};
  cfg.bot=cfg.bot||{};
  cfg.bot['app-id']=appid;
  cfg.bot.secret=secret;
  const s=await j('/api/config',{method:'POST',body:JSON.stringify({config:cfg})});
  if(s.ok){if(msg){msg.className='msg done';msg.textContent='已保存，正在重载…';}setTimeout(()=>{location.reload();},1200);}
  else{if(msg){msg.className='msg err';msg.textContent=s.data.error||'保存失败';}}
}
async function bootstrap(){
  // 登录后才调用：检查是否需要快速开始
  const sr=await j('/api/setup-status');
  if(sr.ok&&!sr.data.botConfigured){
    document.getElementById('setup').style.display='block';
    return;
  }
  document.getElementById('app').style.display='flex';
  await status();await loadCfg();await loadTools();
}
</script></body></html>`;
    }
}

module.exports = { WebUI };
