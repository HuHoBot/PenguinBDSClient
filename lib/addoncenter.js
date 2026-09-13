'use strict';

/**
 * HuHoBot 附属插件中心客户端（https://addon.txssb.cn）。
 * 零 npm 依赖：HTTPS 拉 JSON / 二进制，自实现最小 zip 解压（store + deflate）。
 * 站点有 slowAES Cookie 防爬，本模块会自动解挑战并带 Cookie 重试。
 *
 * API：https://addon.txssb.cn/api.php?action=list|detail|fetch&id=
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const { URL } = require('url');

const log = typeof logger !== 'undefined' ? logger : console;

const DEFAULT_API = 'https://addon.txssb.cn/api.php';
const LIST_CACHE_MS = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let listCache = { at: 0, key: '', data: null };
/** 站点 __test Cookie（跨请求复用） */
let siteCookie = '';
let aesSandbox = null;

function apiUrl(apiBase, params) {
    const u = new URL(String(apiBase || DEFAULT_API));
    for (const k of Object.keys(params || {})) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
            u.searchParams.set(k, String(params[k]));
        }
    }
    return u.toString();
}

function parseSetCookie(headers, host) {
    const raw = headers && headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (const c of list) {
        const m = String(c).match(/(?:^|;\s*)__test=([^;]+)/i);
        if (m) {
            siteCookie = m[1];
            log.info('[HuHoBotPenguin] 插件中心防爬 Cookie 已获取（' + siteCookie.slice(0, 16) + '…）');
        }
    }
}

function isChallengeHtml(buf) {
    const s = buf.toString('utf8');
    return s.indexOf('slowAES') >= 0 && s.indexOf('toNumbers') >= 0;
}

function ensureAesSandbox(origin) {
    if (aesSandbox) return aesSandbox;
    // 同步拉取站点 aes.js 并在 vm 中求值
    return new Promise((resolve, reject) => {
        const u = new URL('/aes.js', origin);
        const lib = https;
        const req = lib.get({
            hostname: u.hostname,
            port: 443,
            path: u.pathname,
            method: 'GET',
            headers: { 'User-Agent': UA, Cookie: siteCookie ? '__test=' + siteCookie : '' },
            timeout: 15000
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    const code = Buffer.concat(chunks).toString('utf8');
                    const ctx = { console, Math, parseInt, String, Array, Object, JSON };
                    vm.createContext(ctx);
                    vm.runInContext(code, ctx);
                    if (!ctx.slowAES) throw new Error('aes.js 未导出 slowAES');
                    aesSandbox = ctx;
                    resolve(ctx);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('拉取 aes.js 超时')));
    });
}

function toNumbersHex(d) {
    const e = [];
    String(d).replace(/(..)/g, (hex) => { e.push(parseInt(hex, 16)); return ''; });
    return e;
}

function toHexFromArr(arr) {
    let e = '';
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i] & 0xff;
        e += (v < 16 ? '0' : '') + v.toString(16);
    }
    return e.toLowerCase();
}

/** 解析 challenge HTML 并更新 siteCookie；返回下一次跳转 URL（含 ?i=） */
async function solveChallenge(html, currentUrl) {
    const ctx = await ensureAesSandbox(new URL(currentUrl).origin);
    const hexes = [];
    const re = /toNumbers\("([0-9a-f]+)"\)/g;
    let m;
    while ((m = re.exec(html))) hexes.push(m[1]);
    if (hexes.length < 3) throw new Error('无法解析防爬挑战参数');
    const a = toNumbersHex(hexes[0]);
    const b = toNumbersHex(hexes[1]);
    const c = toNumbersHex(hexes[2]);
    const dec = ctx.slowAES.decrypt(c, 2, a, b);
    siteCookie = toHexFromArr(Array.prototype.slice.call(dec));
    const loc = html.match(/location\.href="([^"]+)"/);
    return loc ? loc[1] : currentUrl;
}

function requestRaw(url, { method = 'GET', timeout = 30000, cookie } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(url);
        } catch (e) {
            reject(new Error('非法 URL：' + url));
            return;
        }
        const cookieVal = cookie !== undefined ? cookie : (siteCookie ? '__test=' + siteCookie : '');
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request(
            {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname + u.search,
                method,
                headers: {
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Referer': u.origin + '/',
                    ...(cookieVal ? { Cookie: cookieVal } : {})
                },
                timeout
            },
            (res) => {
                const status = res.statusCode || 0;
                if (res.headers['set-cookie']) parseSetCookie(res.headers, u.hostname);
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, url).toString();
                    resolve(requestRaw(next, { method: 'GET', timeout, cookie: cookieVal }));
                    return;
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    resolve({ status, headers: res.headers, buffer: buf, url });
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('请求超时：' + url)));
        req.end();
    });
}

/** 带防爬处理的请求：JSON 或二进制。 */
async function requestSmart(url, { timeout = 30000, maxChallenge = 8 } = {}) {
    let cur = url;
    for (let i = 0; i <= maxChallenge; i++) {
        const r = await requestRaw(cur, { timeout });
        const textHead = r.buffer.length > 0 && r.buffer.length < 8000 && r.buffer[0] !== 0x50;
        if (textHead && isChallengeHtml(r.buffer)) {
            cur = await solveChallenge(r.buffer.toString('utf8'), cur);
            continue;
        }
        if (r.status < 200 || r.status >= 300) {
            throw new Error('HTTP ' + r.status + '：' + r.buffer.toString('utf8').slice(0, 200));
        }
        return r;
    }
    throw new Error('防爬挑战次数过多，请稍后重试');
}

async function requestJson(url) {
    const r = await requestSmart(url);
    const text = r.buffer.toString('utf8');
    if (isChallengeHtml(r.buffer)) {
        throw new Error('防爬挑战未通过，请稍后重试');
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('响应不是 JSON：' + text.slice(0, 200));
    }
}

/**
 * 获取插件列表。
 * @returns {Promise<{plugins:Array,total:number}>}
 */
async function listPlugins(apiBase, { search, tag } = {}) {
    const key = String(search || '') + '|' + String(tag || '');
    if (listCache.data && listCache.key === key && Date.now() - listCache.at < LIST_CACHE_MS) {
        return listCache.data;
    }
    const url = apiUrl(apiBase, { action: 'list', search, tag });
    const data = await requestJson(url);
    const plugins = Array.isArray(data.plugins) ? data.plugins : [];
    const result = { plugins, total: typeof data.total === 'number' ? data.total : plugins.length };
    listCache = { at: Date.now(), key, data: result };
    return result;
}

async function pluginDetail(apiBase, id) {
    return requestJson(apiUrl(apiBase, { action: 'detail', id }));
}

// ---- 最小 ZIP 解压（store=0 / deflate=8） ----

function readZipEntries(buf) {
    // 找 EOCD
    let eocd = -1;
    const min = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('不是有效的 zip（缺少 EOCD）');

    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let n = 0; n < count; n++) {
        if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
            throw new Error('zip 目录项损坏');
        }
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const uncompSize = buf.readUInt32LE(off + 24);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
        entries.push({ name, method, compSize, uncompSize, localOff });
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function extractZipEntry(buf, entry) {
    const lo = entry.localOff;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) {
        throw new Error('zip 本地头损坏：' + entry.name);
    }
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const dataStart = lo + 30 + nameLen + extraLen;
    const raw = buf.slice(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw);
    throw new Error('不支持的压缩方式 ' + entry.method + '：' + entry.name);
}

/** 安全路径：禁止 .. 与绝对路径 */
function safeJoin(baseDir, rel) {
    const norm = path.normalize(rel).replace(/^([/\\])+/, '');
    if (norm.startsWith('..') || path.isAbsolute(norm) || /(^|[/\\])\.\.([/\\]|$)/.test(norm)) {
        throw new Error('非法 zip 路径：' + rel);
    }
    return path.join(baseDir, norm);
}

/**
 * 从 zip 缓冲安装到目标目录。
 * zip 内可有或没有一层顶层目录；有则剥掉一层。
 * @returns {string[]} 写入的相对文件列表
 */
function installZipBuffer(buf, destRoot, { force = false } = {}) {
    const entries = readZipEntries(buf).filter((e) => !e.name.endsWith('/'));
    if (!entries.length) throw new Error('zip 为空');

    // 是否有统一顶层目录
    let prefix = '';
    const tops = new Set(entries.map((e) => e.name.split(/[/\\]/)[0]));
    if (tops.size === 1) {
        const only = tops.values().next().value;
        const allUnder = entries.every((e) => e.name.startsWith(only + '/'));
        if (allUnder) prefix = only + '/';
    }

    // 目标插件目录名
    let folderName = prefix ? prefix.replace(/\/$/, '') : null;
    if (!folderName) {
        // 从 addon.json / index.js 推断
        for (const e of entries) {
            if (/(^|\/)addon\.json$/i.test(e.name)) {
                try {
                    const j = JSON.parse(extractZipEntry(buf, e).toString('utf8'));
                    if (j && j.name) folderName = String(j.name).trim();
                } catch (e2) { /* ignore */ }
            }
        }
        if (!folderName) folderName = 'imported-addon';
    }
    // 清洗目录名
    folderName = String(folderName).replace(/[^\w.-]/g, '_').slice(0, 64) || 'imported-addon';

    const destDir = path.join(destRoot, folderName);
    if (fs.existsSync(destDir)) {
        if (!force) {
            const err = new Error('目录已存在：' + folderName);
            err.code = 'EEXIST';
            err.folder = folderName;
            throw err;
        }
        fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.mkdirSync(destDir, { recursive: true });

    const written = [];
    for (const e of entries) {
        let rel = prefix && e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
        if (!rel || rel.endsWith('/')) continue;
        const out = safeJoin(destDir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, extractZipEntry(buf, e));
        written.push(folderName + '/' + rel.replace(/\\/g, '/'));
    }

    // 校验入口
    const hasIndex = fs.existsSync(path.join(destDir, 'index.js'));
    if (!hasIndex) {
        // 有的包只有单层 js？至少要有 addon.json 或 index.js
        const hasAddonJson = fs.existsSync(path.join(destDir, 'addon.json'));
        if (!hasAddonJson) {
            fs.rmSync(destDir, { recursive: true, force: true });
            throw new Error('安装包缺少 index.js / addon.json，已回滚：' + folderName);
        }
    }
    return { folder: folderName, dir: destDir, files: written };
}

/**
 * 下载并安装插件。
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.id 插件 ID
 * @param {string} opts.installRoot addons 根目录
 * @param {boolean} [opts.force]
 * @returns {Promise<{id,name,version,folder,dir,files}>}
 */
async function downloadAndInstall({ apiBase, id, installRoot, force = false }) {
    if (!id) throw new Error('缺少插件 ID');
    if (!installRoot) throw new Error('缺少安装目录');

    // 详情（取名称用于回执）
    let meta = null;
    try {
        const d = await pluginDetail(apiBase, id);
        meta = d && d.plugin ? d.plugin : d;
    } catch (e) {
        log.warn('[HuHoBotPenguin] 获取插件详情失败（继续下载）：' + e.message);
    }

    const url = apiUrl(apiBase, { action: 'fetch', id });
    const r = await requestSmart(url, { timeout: 60000 });
    const ct = String((r.headers && r.headers['content-type']) || '');
    if (r.buffer.length < 100) throw new Error('下载内容过小，可能不是插件包');
    // zip 魔数 PK
    if (r.buffer[0] !== 0x50 || r.buffer[1] !== 0x4b) {
        throw new Error('下载内容不是 zip（Content-Type: ' + ct + '）');
    }

    fs.mkdirSync(installRoot, { recursive: true });
    const result = installZipBuffer(r.buffer, installRoot, { force });
    return {
        id: String(id),
        name: (meta && (meta.name || meta.title)) || result.folder,
        version: (meta && meta.version) || '',
        folder: result.folder,
        dir: result.dir,
        files: result.files
    };
}

function clearListCache() {
    listCache = { at: 0, key: '', data: null };
}

/** 是否 LLSE/LSE 插件（server_type 含 LSE/LLSE/NODE 即可；空视为兼容）。 */
function isLsePlugin(plugin) {
    if (!plugin) return false;
    const t = String(plugin.server_type || plugin.serverType || '').trim().toUpperCase();
    if (!t) return true;
    return t === 'LSE' || t === 'LLSE' || t.indexOf('LSE') >= 0 || t.indexOf('NODE') >= 0;
}

/** 简单版本比较：a>b 返回 1，a<b 返回 -1，相等或无法解析返回 0。 */
function compareVersions(a, b) {
    const pa = String(a || '').trim().split(/[.\-+]/).filter(Boolean);
    const pb = String(b || '').trim().split(/[.\-+]/).filter(Boolean);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const x = parseInt(pa[i], 10);
        const y = parseInt(pb[i], 10);
        const nx = Number.isNaN(x) ? 0 : x;
        const ny = Number.isNaN(y) ? 0 : y;
        if (nx > ny) return 1;
        if (nx < ny) return -1;
    }
    return 0;
}

module.exports = {
    DEFAULT_API,
    listPlugins,
    pluginDetail,
    downloadAndInstall,
    installZipBuffer,
    clearListCache,
    apiUrl,
    isLsePlugin,
    compareVersions
};
