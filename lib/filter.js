'use strict';

/**
 * 过滤：正则（filter-regex）+ 敏感词（内置默认 + sensitive-words/*.txt 首检），
 * AI 二审走 OpenAI 兼容 /chat/completions（配齐 audit.base-url + audit.api-key 时），失败回退本地结果。
 * 对应 Java 版 Utilities.filterTextByRegex + SensitiveFilter。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { root } = require('./config');

const DEFAULT_WORDS = ['傻逼', '操你', '色情', '反动', '赌博'];

/** 转义正则元字符，保证敏感词按字面匹配。 */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadSensitiveWords(folder) {
    const words = [];
    let entries = [];
    try {
        entries = fs.readdirSync(folder);
    } catch (e) {
        return words;
    }
    for (const name of entries) {
        if (!name.endsWith('.txt')) continue;
        let content = '';
        try {
            content = fs.readFileSync(path.join(folder, name), 'utf8');
        } catch (e) {
            continue;
        }
        for (const line of content.split(/\r?\n/)) {
            const word = line.trim();
            if (word && !word.startsWith('#')) words.push(word);
        }
    }
    return words;
}

function filterTextByRegex(text, patterns) {
    let out = text;
    for (const pattern of patterns || []) {
        try {
            out = out.replace(new RegExp(pattern, 'gi'), '*');
        } catch (e) {
            // 忽略配置中的非法正则
        }
    }
    return out;
}

function replaceWords(text, words) {
    let out = text;
    for (const word of words) {
        if (!word) continue;
        out = out.replace(new RegExp(escapeRegExp(word), 'gi'), '*'.repeat(word.length));
    }
    return out;
}

function aiReview(value, baseUrl, apiKey, model) {
    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(baseUrl.trim().replace(/\/+$/, '') + '/chat/completions');
        } catch (e) {
            return reject(e);
        }
        const body = JSON.stringify({
            model: model || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: '你是敏感词二审工具，只输出替换敏感内容后的完整原文。' },
                { role: 'user', content: value }
            ],
            temperature: 0.1
        });

        const req = https.request(
            {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + apiKey
                },
                timeout: 15000
            },
            (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) return reject(new Error('AI 二审 HTTP ' + res.statusCode));
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices &&
                            parsed.choices[0] &&
                            parsed.choices[0].message &&
                            parsed.choices[0].message.content;
                        resolve(content ? String(content).trim() : value);
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('AI 二审请求超时')));
        req.write(body);
        req.end();
    });
}

/** 整体过滤入口（对齐 Java auditText：正则 → 敏感词首检 → 命中且配齐时 AI 二审全量重写）。 */
function audit(value, cfg) {
    const regexPatterns = cfg.getList('filter-regex');
    const words = DEFAULT_WORDS.concat(loadSensitiveWords(path.join(root(), 'sensitive-words')));
    const distinctWords = Array.from(new Set(words));

    const local = replaceWords(filterTextByRegex(value, regexPatterns), distinctWords);
    const baseUrl = cfg.getString('audit.base-url', '');
    const apiKey = cfg.getString('audit.api-key', '');
    if (local === value || !baseUrl || !apiKey) return Promise.resolve(local);

    return aiReview(value, baseUrl, apiKey, cfg.getString('audit.model', 'gpt-4o-mini'))
        .then((result) => (result && result.trim() ? result.trim() : local))
        .catch(() => local);
}

module.exports = { audit, filterTextByRegex, replaceWords, loadSensitiveWords, DEFAULT_WORDS };