'use strict';

/**
 * LLM Agent：内置 OpenAI 兼容客户端，为未命中命令的群消息提供 AI 对话能力。
 * - 多轮会话缓存：按群维护最近 N 条上下文（user/assistant 交替），文件持久化
 * - 工具调用：AI 可请求调用白名单工具（查在线/查白名单/查服务器/执行命令[需 ai.admin-openids]）
 * - 依赖：内置 http/https，零 npm 依赖（对齐本项目风格）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const log = typeof logger !== 'undefined' ? logger : console;

const { renderCommand } = require('./customcommands');

/** 渲染 skill 命令：tokens 按顺序替换 {0}/{1}/... 占位符（复用 renderCommand 语义）。 */
function renderSkillCommand(command, tokens, groupId, userId) {
    const params = tokens.join(' ');
    return renderCommand(command, params, groupId, userId);
}

/** 构建 function calling 工具清单（OpenAI schema，供 AI 认知可用工具）。 */
function buildToolSchemas() {
    return [
        {
            type: 'function',
            function: {
                name: 'query_online',
                description: '查询服务器当前在线玩家列表（执行 list 命令）。',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_whitelist',
                description: '查询服务器白名单玩家列表（执行 allowlist list）。',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'execute_command',
                description: '在服务器控制台执行一条命令，例如 "list"、"kick <玩家名>"、"whitelist add <玩家名>"。' +
                    '当用户请求执行命令、查看信息、管理服务器操作时，请直接调用本工具；' +
                    '权限由系统自动校验，你无需自行判断用户是否有权限，工具会返回执行结果或权限提示。',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: '要在服务器控制台执行的完整命令' }
                    },
                    required: ['command']
                }
            }
        }
    ];
}

/** 解析 BDS `allowlist list` 输出（新版 JSON 或旧文本）为玩家名数组；无法识别返回 null。 */
function parseWhitelistText(output) {
    const text = String(output || '').trim();
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            const data = JSON.parse(m[0]);
            if (data && Array.isArray(data.result)) {
                const names = data.result.map((r) => String((r && r.name) || '').trim()).filter(Boolean);
                return names;
            }
        } catch (e) { /* 非 JSON */ }
    }
    const m2 = text.match(/[:：][^:：]*$/);
    if (m2) {
        return m2[0].slice(1).trim()
            .split(/[,，、]/).map((s) => s.trim()).filter((s) => s && s !== '无');
    }
    return null;
}

/** 解析 BDS `list` 输出（冒号后玩家名列表）为玩家名数组；无法识别返回 null。 */
function parsePlayerListText(output) {
    const text = String(output || '').trim();
    if (!text) return null;
    const m = text.match(/[:：][^:：]*$/);
    if (!m) return null;
    const namesPart = m[0].slice(1).trim();
    if (!namesPart) return [];
    if (/[。！？!?]/.test(namesPart) || /在线|online|players|玩家/i.test(namesPart)) return null;
    return namesPart.split(/[,，、]/).map((s) => s.trim())
        .filter((s) => s && s !== '无' && !/no players|无玩家|0\s*位|0\s*个|0\s*人/i.test(s) && !/^[-=]+$/.test(s));
}

class Agent {
    /**
     * @param {object} config Config 门面
     */
    constructor(config) {
        this.config = config;
        this.enabled = config.getBool('ai.enabled', false);
        this.baseUrl = (config.getString('ai.base-url', '') || '').trim();
        this.apiKey = config.getString('ai.api-key', '') || '';
        this.model = config.getString('ai.model', 'gpt-4o-mini') || 'gpt-4o-mini';
        this.systemPrompt = config.getString('ai.system-prompt', '') || '';
        this.maxTokens = config.getInt('ai.max-tokens', 1000);
        this.temperature = Number(config.getString('ai.temperature', '0.7')) || 0.7;
        this.contextLimit = config.getInt('ai.context-limit', 10);
        this.timeoutMs = config.getInt('ai.timeout', 15000);
        this.adminOpenIds = String((config.getList('ai.admin-openids') || []).join(',')).split(/[,，]/).map(s => s.trim()).filter(Boolean);

        this.stateFile = null;
        try {
            const root = (typeof __dirname !== 'undefined') ? path.dirname(__dirname) : process.cwd();
            this.stateFile = path.join(root, 'ai-context.json');
        } catch (e) { /* ignore */ }

        this.contexts = {};   // groupId -> [{role, content}]
        this.skills = [];
        this._loadSkills();
        this._load();
    }

    /** 是否启用 AI。 */
    isEnabled() { return this.enabled && !!this.baseUrl; }

    /** 加载用户自定义 skills（ai.skills）。 */
    _loadSkills() {
        this.skills = [];
        const list = this.config.getList('ai.skills') || [];
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const key = String(item.key || '').trim();
            const command = String(item.command || '').trim();
            if (!key || !command) continue;
            const skill = {
                key,
                name: String(item.name || key),
                desc: String(item.desc || '执行自定义命令 ' + command),
                command,
                permission: Number.isInteger(item.permission) ? item.permission : (parseInt(item.permission, 10) || 0)
            };
            // 提取命令中的参数占位符 {0}/{1}/{2}...，生成参数 schema
            skill.params = [];
            const re = /\{(\d+)\}/g; let m;
            const seen = {};
            while ((m = re.exec(command))) { if (!seen[m[1]]) { seen[m[1]] = true; skill.params.push(m[1]); } }
            skill.params.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
            this.skills.push(skill);
        }
    }

    /** 生成完整工具清单：内置 3 个 + 用户自定义 skills，供 function calling。 */
    _toolSchemas() {
        const tools = buildToolSchemas();
        for (const s of this.skills) {
            const props = { params: { type: 'string', description: '命令参数，用空格分隔，对应 ' + (s.params.length ? s.params.map(p => '{' + p + '}').join('、') : '（无参数）') + '。无参数可不填。' } };
            tools.push({
                type: 'function',
                function: {
                    name: 'skill__' + s.key,
                    description: s.desc + (s.params.length ? '（需要按 0,1,2… 顺序提供 ' + s.params.length + ' 个参数）' : '（无参数）'),
                    parameters: { type: 'object', properties: props }
                }
            });
        }
        return tools;
    }

    /**
     * WebUI 用：测试一条 AI 对话（不落会话，支持工具调用，返回纯文本回复）。
     * @param {Array<{role,content}>} messages 输入的上下文消息
     * @returns {Promise<string>} AI 回复文本
     */
    async chatTest(messages) {
        if (!this.isEnabled()) throw new Error('AI 未启用');
        const msgs = [];
        msgs.push({ role: 'system', content: this._systemPrompt() });
        msgs.push(...(Array.isArray(messages) ? messages : []));
        // 工具循环（最多 6 轮）
        for (let round = 0; round < 6; round++) {
            const resp = await this._chat(msgs);
            const result = this._extractReply(resp);
            if (!result) return '(空回复)';
            if (result.toolCalls && result.toolCalls.length) {
                msgs.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls });
                for (const tc of result.toolCalls) {
                    const fn = tc && tc.function || {};
                    const name = fn.name || '';
                    const args = this._safeParse(fn.arguments);
                    const ctx = { groupId: 'webui', userId: (this.adminOpenIds && this.adminOpenIds[0]) || '' };
                    const out = this._runTool(this.bot, ctx, name, args);
                    msgs.push({ role: 'tool', tool_call_id: (tc && tc.id) || (name + round), name, content: out });
                }
                continue;
            }
            return result.text || '(空回复)';
        }
        return '调用次数过多';
    }

    /** 设置 bot 引用（供工具执行；WebUI 测试 AI 用）。 */
    setBot(bot) { this.bot = bot; }

    /**
     * 处理一条群消息：走 LLM 对话 -> 工具调用循环 -> 返回回复文本。
     * @param {object} bot Bot 门面
     * @param {object} ctx { groupId, userId, username, msgId, content }
     * @returns {Promise<string|null>} 回复文本；null 表示不处理
     */
    async handleMessage(bot, ctx) {
        if (!this.isEnabled()) return null;
        const groupId = ctx.groupId;
        const userId = ctx.userId || '';
        log.info('[HuHoBotPenguin-Llama] AI 收到群消息：group=' + groupId + ' content=' + String(ctx.content||'').slice(0,60));
        this._pushContext(groupId, { role: 'user', content: ctx.content });

        try {
            // 多轮工具调用循环（上限 6 轮）
            let messages = this._buildMessages(groupId);
            for (let round = 0; round < 6; round++) {
                const resp = await this._chat(messages);
                const result = this._extractReply(resp);
                if (!result) return null;

                // 有工具调用：执行 -> 回填 -> 继续让模型总结
                if (result.toolCalls && result.toolCalls.length) {
                    log.info('[HuHoBotPenguin-Llama] AI 调用工具：round=' + round + ' tools=' + result.toolCalls.map(t=>t.function&&t.function.name).join(','));
                    // 把 assistant 的工具调用意图推入历史（OpenAI 协议）
                    messages.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls });
                    for (const tc of result.toolCalls) {
                        const fn = tc && tc.function || {};
                        const name = fn.name || '';
                        const args = this._safeParse(fn.arguments);
                        const out = this._runTool(bot, ctx, name, args);
                        log.info('[HuHoBotPenguin-Llama] 工具结果 ' + name + '=' + String(out).slice(0,80));
                        messages.push({ role: 'tool', tool_call_id: (tc && tc.id) || (name + round), name, content: out });
                    }
                    continue;
                }

                // 正常回复
                const replyText = result.text || result.content || '';
                log.info('[HuHoBotPenguin-Llama] AI 直接回复（未调工具）：' + String(replyText).slice(0,60));
                this._pushContext(groupId, { role: 'assistant', content: replyText });
                this._save();
                return replyText;
            }
            return '抱歉，调用次数过多，请重试。';
        } catch (e) {
            log.error('[HuHoBotPenguin-Llama] AI 对话出错：' + (e && e.message || e));
            return null;
        }
    }

    /** 调用 LLM（OpenAI 兼容 /chat/completions，携带 tools function calling）。 */
    async _chat(messages, withTools = true) {
        const { hostname, port, pathname } = this._parseBaseUrl();
        const bodyObj = {
            model: this.model,
            messages,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            tools: this._toolSchemas()
        };
        if (!withTools) delete bodyObj.tools;
        const body = JSON.stringify(bodyObj);
        const reqUrl = pathname + (pathname.endsWith('/') ? '' : '/') + 'chat/completions';
        const isHttps = this.baseUrl.startsWith('https://');
        const transport = isHttps ? https : http;

        return new Promise((resolve, reject) => {
            const headers = { 'Content-Type': 'application/json' };
            if (this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;
            const req = transport.request(
                {
                    hostname,
                    port: port || (isHttps ? 443 : 80),
                    path: reqUrl,
                    method: 'POST',
                    headers,
                    timeout: this.timeoutMs
                },
                (res) => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve(json);
                        } catch (e) {
                            reject(new Error('AI 响应非 JSON：' + data.slice(0, 300)));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('AI 请求超时')); });
            req.write(body);
            req.end();
        });
    }

    /** 解析 base-url 为 { hostname, port, pathname }。 */
    _parseBaseUrl() {
        const u = new URL(this.baseUrl);
        return { hostname: u.hostname, port: u.port, pathname: u.pathname };
    }

    /** 提取模型回应的回复文本 + 可选工具调用。 */
    _extractReply(resp) {
        if (!resp || !resp.choices || !resp.choices[0]) {
            throw new Error('AI 返回异常：' + JSON.stringify(resp).slice(0, 300));
        }
        const msg = resp.choices[0].message || {};
        const content = typeof msg.content === 'string' ? msg.content : '';
        // 工具调用（OpenAI function calling 协议）
        if (msg.tool_calls && msg.tool_calls.length) {
            return { toolCalls: msg.tool_calls, content, text: content.trim() };
        }
        return { toolCalls: null, content, text: content.trim() };
    }

    _safeParse(s) {
        try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
    }

    /** 工具名 -> 执行（黑名单之外的白名单）。 */
    _runTool(bot, ctx, name, args) {
        const groupId = ctx.groupId;
        const userId = ctx.userId || '';
        if (!bot || typeof bot.sendCommand !== 'function') {
            return '服务器工具不可用（TTT 插件未完全初始化）';
        }
        switch (name) {
            case 'query_online': {
                const res = bot.sendCommand('list');
                const out = (res && res.output || '').trim();
                if (!out) return '当前无人在线';
                const players = parsePlayerListText(out);
                if (players === null) return out; // 无法解析回原始输出
                if (!players.length) return '当前无人在线';
                return '当前在线名单：' + players.join('、');
            }
            case 'query_whitelist': {
                const res = bot.sendCommand('allowlist list');
                const out = (res && res.output || '').trim();
                if (!out) return '空名单';
                const names = parseWhitelistText(out);
                if (names === null) return out; // 无法解析回原始输出
                if (!names.length) return '白名单为空';
                return '白名单玩家：' + names.join('、');
            }
            case 'execute_command': {
                // 高危：仅 ai.admin-openids 白名单可执行
                if (!this.adminOpenIds.length) {
                    log.warn('[HuHoBotPenguin-Llama] 执行命令被拒：未配置 ai.admin-openids（发送者 ' + userId + '）');
                    return '执行命令未授权：未配置 ai.admin-openids';
                }
                if (!this.adminOpenIds.includes(userId)) {
                    log.warn('[HuHoBotPenguin-Llama] 执行命令被拒：发送者 ' + userId + ' 不在 ai.admin-openids 白名单 [' + this.adminOpenIds.join(',') + '] 内');
                    return '执行命令权限不足：仅配置中的管理员 OpenID 可执行';
                }
                const command = String((args && args.command) || '').trim();
                if (!command) return '缺少命令参数';
                const res = bot.sendCommand(command);
                return (res.success ? '执行成功：' : '执行失败：') + (res.output || '');
            }
            default: {
                // 自定义 skill：skill__<key>
                if (name && name.indexOf('skill__') === 0) {
                    const skillKey = name.slice('skill__'.length);
                    const skill = this.skills.find((s) => s.key === skillKey);
                    if (!skill) return '未知 skill：' + skillKey;
                    // 权限：permission>0 需管理员
                    if (skill.permission > 0) {
                        if (!this.adminOpenIds.length) return '该 skill 需要管理员，未配置 ai.admin-openids';
                        if (!this.adminOpenIds.includes(userId)) return '该 skill 仅管理员可调用（你的 OpenID 不在 ai.admin-openids）';
                    }
                    // 渲染参数：args.params 空格分隔 → 按顺序替换 {0}/{1}...
                    const tokens = String(args && args.params || '').trim().split(/\s+/).filter(Boolean);
                    const rendered = renderSkillCommand(skill.command, tokens, groupId, userId);
                    const res = bot.sendCommand(rendered);
                    return (res.success ? '执行成功：' : '执行失败：') + (res.output || '');
                }
                return '未知工具：' + name;
            }
        }
    }

    /** 组装某群的上下文消息（始终注入带工具引导的 system prompt）。 */
    _buildMessages(groupId) {
        const hist = (this.contexts[groupId] || []).slice(-this.contextLimit);
        const messages = [];
        messages.push({ role: 'system', content: this._systemPrompt() });
        messages.push(...hist);
        return messages;
    }

    /** 生成 system prompt：用户自定义 + 工具使用引导（确保 AI 知道可调工具）。 */
    _systemPrompt() {
        const base = this.systemPrompt || '你是 Minecraft 服务器管理助理，回答使用中文，简洁准确。';
        return base + '\n\n你可以调用以下工具管理或查询服务器：\n' +
            '- query_online：查询当前在线玩家（当用户问谁在线/查看在线时调用）\n' +
            '- query_whitelist：查询白名单玩家（当用户问白名单时调用）\n' +
            '- execute_command：在服务器控制台执行命令（当用户要求执行命令/操作服务器时，直接调用本工具；权限由系统校验并返回结果，不要自行判断用户是否有权限或拒绝）\n' +
            '遇到上述请求时应直接调用对应工具，而不是凭空猜测或回复权限拒绝。';
    }

    /** 往群上下文追加一条消息，裁剪超限。 */
    _pushContext(groupId, msg) {
        if (!this.contexts[groupId]) this.contexts[groupId] = [];
        this.contexts[groupId].push(msg);
        if (this.contexts[groupId].length > this.contextLimit) {
            this.contexts[groupId].shift();
        }
    }

    _load() {
        if (!this.stateFile) return;
        try {
            if (fs.existsSync(this.stateFile)) {
                const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
                if (data && typeof data === 'object') this.contexts = data;
            }
        } catch (e) { /* ignore */ }
    }

    _save() {
        if (!this.stateFile) return;
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify(this.contexts, null, 2), 'utf8');
        } catch (e) { log.warn('[HuHoBotPenguin-Llama] 写 ai-context 失败:' + e.message); }
    }
}

module.exports = { Agent };
