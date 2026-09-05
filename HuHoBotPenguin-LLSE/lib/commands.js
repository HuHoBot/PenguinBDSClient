'use strict';

/**
 * 命令分发 + 全部内置命令，对齐 Java 版 BaseCommand/CommandSupport/
 * PublicCommands/AdministrationCommands/AuthenticationCommands。
 *
 * handleGroupMessage 入口：
 *   1. 群白名单（bot.groups 为空 = 所有群）
 *   2. 剥 @ 前缀/前导 /，按命令名长度降序匹配（cleaned==name 或 startsWith(name+" "）)
 *   3. 命中 → 检查命令开关 → 执行
 *   4. 非命令 → 全量转发（full-forwarding 且 post-chat 时广播到游戏）
 */

const { MODE_QQ, MODE_MANUAL, MODE_BOTH } = require('./state');
const { renderCommand } = require('./customcommands');
const { requestJson } = require('./qqclient');
const { getOnlineStats, tickIcon } = require('./tickmonitor');

const log = typeof logger !== 'undefined' ? logger : console;

// ---- 通用小工具 ----

function normalizeContent(content) {
    let cleaned = String(content || '').trim();
    // 官方 GROUP_AT 事件已剥离 @ 前缀；若仍带 <@xxx> 则兜底去掉
    cleaned = cleaned.replace(/<@!?[^>]+>/g, '').trim();
    if (cleaned.startsWith('/')) cleaned = cleaned.slice(1).trim();
    return cleaned;
}

/**
 * 解析 BDS `list` 命令输出中的在线玩家名列表。
 * 兼容中英文输出：玩家名部分在最后一个冒号（半角/全角）之后，逗号/顿号分隔。
 * - 冒号后为空 = 0 人在线（合法，返回空数组，渲染"当前 0 人"卡片）；
 * - 无法可靠识别时返回 null（调用方回退纯文本输出）。
 * @returns {string[] | null}
 */
function parsePlayerList(output) {
    const text = String(output || '').trim();
    if (!text) return null;
    const m = text.match(/[:：][^:：]*$/);
    if (!m) return null;
    const namesPart = m[0].slice(1).trim();
    // 0 人在线：冒号后为空，返回空数组而非 null
    if (!namesPart) return [];
    // 名字列表不应包含句子类标点或状态词，否则视为非玩家列表格式
    if (/[。！？!?]/.test(namesPart) || /在线|online|players|玩家/i.test(namesPart)) return null;
    const names = namesPart
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter((s) => s && s !== '无' && !/no players|无玩家|0\s*位|0\s*个|0\s*人/i.test(s) && !/^[-=]+$/.test(s));
    return names;
}

/**
 * 渲染查在线的 Markdown 卡片（msg_type=2）。
 * 优先读取插件目录 Markdown/online.md 文件模板（用户可编辑，占位符 {{.server}}/{{.img_url}}/{{.player}}/{{.online_num}}，
 * 对齐 Java 版）；模板不存在时回退内置默认模板。无法渲染（无模板且内置异常）返回 null。
 */
function buildOnlineMarkdown(bot, players) {
    const timestamp = Math.floor(Date.now() / 1000);
    const stats = getOnlineStats(bot);
    let template = readMarkdownTemplate(bot, 'online.md');
    if (template !== null && template.indexOf('{{.tps}}') === -1 && template.indexOf('{{.mspt}}') === -1) {
        // 旧版模板缺少 TPS 占位符：追加 TPS 行并写回（升级兼容）
        template = template.replace(/\s*$/, '') + '\n\nTPS：{{.tps}}（MSPT {{.mspt}}）\n';
        try {
            const fsMod = require('fs');
            const pathMod = require('path');
            const tplDir = pathMod.join((typeof __dirname !== 'undefined') ? pathMod.dirname(__dirname) : process.cwd(), 'Markdown');
            fsMod.mkdirSync(tplDir, { recursive: true });
            fsMod.writeFileSync(pathMod.join(tplDir, 'online.md'), template, 'utf8');
        } catch (err) { /* 写失败不影响本次输出 */ }
    }
    if (template !== null) {
        // 用户自定义模板；统计不可用时整行移除 TPS 占位行（避免输出 N/A）
        let tpl = template;
        if (!stats) {
            tpl = tpl.replace(/^.*\{\{\.tps\}\}.*\r?\n?/gm, '').replace(/^.*\{\{\.mspt\}\}.*\r?\n?/gm, '');
        }
        return tpl
            .replace(/{{\.server}}/g, getServerName(bot))
            .replace(/{{\.img_url}}/g, buildMotdImgUrl(bot, timestamp))
            .replace(/{{\.player}}/g, players.length
                ? players.map((n, i) => (i + 1) + '. **' + n + '**').join('\n')
                : '无')
            .replace(/{{\.online_num}}/g, String(players.length))
            .replace(/{{\.tps}}/g, stats ? tickIcon(stats) + ' ' + stats.tps : '')
            .replace(/{{\.mspt}}/g, stats ? stats.mspt + 'ms / 峰值 ' + stats.maxMspt + 'ms' : '');
    }
    // 内置默认模板
    const lines = [];
    lines.push('# 在线玩家');
    lines.push('');
    const imgUrl = buildMotdImgUrl(bot, timestamp);
    if (imgUrl) {
        lines.push('![服务器状态 #480px #270px](' + imgUrl + ')');
        lines.push('');
    }
    lines.push('当前在线：**' + players.length + '** 人');
    if (stats) {
        lines.push('TPS：' + tickIcon(stats) + ' **' + stats.tps + '**（MSPT ' + stats.mspt + 'ms / 峰值 ' + stats.maxMspt + 'ms）');
    }
    if (players.length) {
        lines.push('');
        for (const p of players) lines.push('- ' + p);
    }
    return lines.join('\n');
}

/** 读取插件目录 Markdown/下模板文件；不存在或读取失败返回 null。 */
function readMarkdownTemplate(bot, fileName) {
    try {
        const fs = require('fs');
        const path = require('path');
        const root = (typeof __dirname !== 'undefined') ? path.dirname(__dirname) : process.cwd();
        const file = path.join(root, 'Markdown', fileName);
        if (!fs.existsSync(file)) return null;
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        return null;
    }
}

/** 计算当前服务器名（serverName > bot.name），供模板 {{.server}} 与进服通知共用。 */
function getServerName(bot) {
    return bot.config.getString('serverName', '') || bot.config.getString('bot.name', 'HuHoBot');
}

/** 生成 MOTD 状态图 URL（motd.api 模板，{ip}/{port} 替换；追加时间戳防 CDN 缓存）。motd.ip 为空返回 ''。 */
function buildMotdImgUrl(bot, timestamp) {
    const ip = String(bot.config.getString('motd.ip', '') || '').trim();
    if (!ip) return '';
    const port = bot.config.getInt('motd.port', 19132);
    let api = bot.config.getString('motd.api', 'https://motd.minebbs.com/api/status_img?ip={ip}&port={port}');
    api = api.replace(/\{ip\}/g, encodeURIComponent(ip)).replace(/\{port\}/g, String(port));
    const sep = api.includes('?') ? '&' : '?';
    return api + sep + 't=' + timestamp;
}

/**
 * 解析 BDS `allowlist list` 输出的白名单玩家名列表。
 * - 新版（1.21+）：JSON 输出，形如 `###* {"command":"allowlist","result":[{"name":"xx",...}]}`；
 * - 旧版：`whitelist list` 文本输出（冒号后玩家名列表）；
 * - 无法识别返回 null（调用方回退纯文本）。
 * @returns {string[] | null}
 */
function parseWhitelist(output) {
    const text = String(output || '').trim();
    if (!text) return null;
    // 1) 新版 JSON：提取首个 { 到最后一个 } 尝试解析
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            const data = JSON.parse(m[0]);
            if (data && Array.isArray(data.result)) {
                const names = data.result
                    .map((r) => String((r && r.name) || '').trim())
                    .filter(Boolean);
                return names;
            }
        } catch (e) { /* 非 JSON，继续走文本解析 */ }
    }
    // 2) 旧版文本：最后一个冒号后的玩家名列表
    const m2 = text.match(/[:：][^:：]*$/);
    if (m2) {
        const namesPart = m2[0].slice(1).trim();
        if (!namesPart) return [];
        return namesPart
            .split(/[,，、]/)
            .map((s) => s.trim())
            .filter((s) => s && s !== '无' && !/no players|无玩家|0\s*位|0\s*个|0\s*人/i.test(s));
    }
    return null;
}

/** 渲染查白名单的 Markdown 消息内容（msg_type=2）：标题 + 白名单人数 + 玩家列表。 */
function buildWhitelistMarkdown(bot, names) {
    const lines = [];
    lines.push('# 白名单');
    lines.push('');
    lines.push('当前白名单：**' + names.length + '** 人');
    if (names.length) {
        lines.push('');
        for (const n of names) lines.push('- ' + n);
    }
    return lines.join('\n');
}

/** 清理 MOTD 文本中的 Minecraft 颜色码（§x）。 */
function stripMotdColors(text) {
    return String(text || '').replace(/§./g, '').trim();
}

/** Markdown 消息总开关（motd.use-markdown，对齐 Java 版；false = 全部 Markdown 卡片回退纯文本）。 */
function markdownEnabled(config) {
    return config.getBool('motd.use-markdown', true);
}

/** 查在线格式化纯文本（Markdown 关闭/不可用时输出，用 motd.text 模板）。 */
function formatOnlineText(bot, players) {
    const template = bot.config.getString('motd.text', '当前在线：{online} 人\n{players}');
    const playerList = players.join('\n');
    let text = template
        .replace(/\{online\}/g, String(players.length))
        .replace(/\{players\}/g, playerList)
        .replace(/\{server\}/g, getServerName(bot));
    const stats = getOnlineStats(bot);
    if (stats) {
        text += '\nTPS：' + tickIcon(stats) + ' ' + stats.tps + '（MSPT ' + stats.mspt + 'ms）';
    }
    return text;
}

/** 查白名单格式化纯文本（Markdown 关闭/不可用时的输出）。 */
function formatWhitelistText(names) {
    if (!names.length) return '当前白名单为空';
    return '当前白名单：' + names.length + ' 人\n' + names.join('、');
}

/**
 * 渲染"查服务器"的 Markdown 卡片（msg_type=2）：标题 + MOTD 状态图 + 状态/玩家/版本/延迟/MOTD。
 * 仅在线时调用（离线走纯文本，避免空白占位图）。
 */
function buildServerQueryMarkdown(data, ip, port) {
    const lines = [];
    lines.push('# ' + (data.host || ip + ':' + port));
    lines.push('');
    lines.push('![服务器状态 #480px #270px](https://motd.minebbs.com/api/status_img?ip=' +
        encodeURIComponent(ip) + '&port=' + port + ')');
    lines.push('');
    lines.push('状态：**在线**' + (data.type ? '（' + data.type + '）' : ''));
    const p = data.players || {};
    lines.push('玩家：**' + p.online + ' / ' + p.max + '**');
    if (data.version) lines.push('版本：' + data.version);
    if (data.delay !== undefined && data.delay !== null) lines.push('延迟：' + data.delay + 'ms');
    const motd = stripMotdColors(data.pureMotd || data.motd);
    if (motd) {
        lines.push('');
        for (const ln of motd.split('\n').filter(Boolean)) lines.push('- ' + ln);
    }
    return lines.join('\n');
}

/** "查服务器"的纯文本回退格式（无 Markdown 能力时）。 */
function formatServerQuery(data, ip, port) {
    if (!data || data.status !== 'online') {
        return (data && data.host ? data.host : ip + ':' + port) +
            ' 离线' + (data && data.error ? '：' + data.error : '');
    }
    const p = data.players || {};
    const motd = stripMotdColors(data.pureMotd || data.motd);
    const lines = [
        data.host || ip + ':' + port,
        '状态：在线（' + (data.type || '未知类型') + '）',
        '玩家：' + p.online + ' / ' + p.max,
    ];
    if (data.version) lines.push('版本：' + data.version);
    if (data.delay !== undefined && data.delay !== null) lines.push('延迟：' + data.delay + 'ms');
    if (motd) lines.push('MOTD：' + motd.replace(/\n/g, ' '));
    return lines.join('\n');
}

function parseOnOff(text) {
    const t = String(text || '').trim().toLowerCase();
    if (['开', 'on', 'true', '1', 'yes'].includes(t)) return true;
    if (['关', 'off', 'false', '0', 'no'].includes(t)) return false;
    return null;
}

function parseMode(text) {
    const t = String(text || '').trim().toLowerCase();
    if (t === 'qq') return MODE_QQ;
    if (t === '手动' || t === 'manual' || t === 'config') return MODE_MANUAL;
    if (t === '双重' || t === 'both') return MODE_BOTH;
    return null;
}

const MODE_LABEL = { [MODE_QQ]: 'QQ 群主/管理员', [MODE_MANUAL]: '手动管理员', [MODE_BOTH]: '双重（两者任一即可）' };

function reply(ctx, content) {
    ctx.bot.qqclient.sendGroupMessage(ctx.groupId, content, ctx.msgId);
}

function requireAdmin(ctx) {
    return ctx.bot.state.isAdmin(ctx.groupId, ctx.userId, ctx.memberRole);
}

function gateAdmin(ctx, usage) {
    if (requireAdmin(ctx)) return true;
    reply(ctx, '此命令需要管理员权限');
    if (usage) log.debug('[HuHoBotPenguin] 用法：' + usage);
    return false;
}

function runGameCommand(bot, ctx, command) {
    const result = bot.sendCommand(command);
    const text = (result && result.output || '').trim();
    reply(ctx, text || '已发送执行请求');
}

function displayName(ctx) {
    return ctx.username || ctx.userId || '未知';
}

// ---- 命令定义 ----

const COMMANDS = [
    {
        name: '查信息',
        execute(ctx) {
            const target = String(ctx.params || '').trim();
            if (!target) {
                reply(ctx, '群：' + ctx.groupId +
                    '\n本人 OpenID：' + ctx.userId +
                    '\n角色：' + (ctx.memberRole || 'member') +
                    '\n认证状态：' + (ctx.bot.state.isAuthenticated(ctx.groupId, ctx.userId) ? '已认证' : '未认证'));
                return;
            }
            if (!gateAdmin(ctx)) return;
            const openid = target.split(/\s+/)[0];
            reply(ctx, '目标 OpenID：' + openid +
                '\n认证状态：' + (ctx.bot.state.isAuthenticated(ctx.groupId, openid) ? '已认证' : '未认证'));
        }
    },
    {
        name: '发消息',
        execute(ctx) {
            if (!String(ctx.params || '').trim()) {
                reply(ctx, '用法：发消息 <内容>');
                return;
            }
            ctx.bot.auditText(ctx.params).then((filtered) => {
                ctx.bot.broadcast(ctx.bot.formatGroupMessage(displayName(ctx), filtered));
            });
        }
    },
    {
        name: '发信息',
        execute(ctx) {
            if (!String(ctx.params || '').trim()) {
                reply(ctx, '用法：发信息 <内容>');
                return;
            }
            ctx.bot.auditText(ctx.params).then((filtered) => {
                ctx.bot.broadcast(ctx.bot.formatGroupMessage(displayName(ctx), filtered));
            });
        }
    },
    {
        name: '查在线',
        execute(ctx) {
            const result = ctx.bot.sendCommand('list');
            const output = (result && result.output || '').trim();
            if (!output) {
                reply(ctx, '无输出');
                return;
            }
            const players = parsePlayerList(output);
            if (players !== null &&
                markdownEnabled(ctx.bot.config) &&
                ctx.bot.config.getBool('features.markdown-query-online', true) &&
                typeof ctx.bot.qqclient.sendMarkdown === 'function') {
                // Markdown 卡片：用 Markdown/online.md 文件模板（用户可编辑，缺失时回退内置默认模板）
                const md = buildOnlineMarkdown(ctx.bot, players);
                if (md !== null) {
                    ctx.bot.qqclient.sendMarkdown(ctx.groupId, md, ctx.msgId);
                    return;
                }
                // 模板不存在：回退纯文本格式
                reply(ctx, formatOnlineText(players));
                return;
            }
            if (players !== null) {
                // 格式化纯文本（用 motd.text 模板，缺省回退内置格式）
                reply(ctx, formatOnlineText(ctx.bot, players));
                return;
            }
            log.info('[HuHoBotPenguin] 查在线解析失败，原样输出。list 原始输出：' + JSON.stringify(output));
            reply(ctx, output);
        }
    },
    {
        name: '在线服务器',
        execute(ctx) {
            reply(ctx, ctx.bot.config.getString('bot.name', 'HuHoBot') + ' 在线');
        }
    },
    {
        name: 'motd',
        execute(ctx) {
            // 查询任意 Minecraft 服务器状态（motd.minebbs.com，只读，所有成员可用）
            const target = String(ctx.params || '').trim();
            if (!target) {
                reply(ctx, '用法：motd <地址[:端口]>（如 motd play.example.com:19132，不带端口默认 19132）');
                return;
            }
            let ip = target;
            let port = 19132;
            const pm = target.match(/^(.*):(\d{1,5})$/);
            if (pm) {
                ip = pm[1].trim();
                port = parseInt(pm[2], 10);
            }
            requestJson({
                host: 'motd.minebbs.com',
                path: '/api/status?ip=' + encodeURIComponent(ip) + '&port=' + port,
                method: 'GET',
                headers: {},
                label: 'motd status'
            }).then((data) => {
                const online = !!(data && data.status === 'online');
                if (online && markdownEnabled(ctx.bot.config) && typeof ctx.bot.qqclient.sendMarkdown === 'function') {
                    ctx.bot.qqclient.sendMarkdown(ctx.groupId, buildServerQueryMarkdown(data, ip, port), ctx.msgId);
                } else {
                    ctx.bot.qqclient.sendGroupMessage(ctx.groupId, formatServerQuery(data, ip, port), ctx.msgId);
                }
            }).catch((e) => {
                ctx.bot.qqclient.sendGroupMessage(ctx.groupId, '查询失败：' + e.message, ctx.msgId);
            });
        }
    },
    {
        name: '执行',
        execute(ctx) {
            const item = ctx.bot.custom.resolveRun(ctx.params);
            if (!item) {
                reply(ctx, '未找到可执行的自定义命令：' + ctx.params + (requireAdmin(ctx) ? '（若需权限请使用 管理员执行）' : ''));
                return;
            }
            const command = renderCommand(item.command, ctx.params, ctx.groupId, ctx.userId, 'huhobot run');
            runGameCommand(ctx.bot, ctx, command);
        }
    },
    {
        name: '执行命令',
        adminOnly: true,
        execute(ctx) {
            // 对齐 Java 版：以管理员身份直接在服务器控制台执行任意命令（参数即命令全文）
            if (!gateAdmin(ctx)) return;
            const command = String(ctx.params || '').trim();
            if (!command) {
                reply(ctx, '用法：执行命令 <控制台命令>');
                return;
            }
            runGameCommand(ctx.bot, ctx, command);
        }
    },
    {
        name: '管理员执行',
        adminOnly: true,
        execute(ctx) {
            if (!gateAdmin(ctx)) return;
            const item = ctx.bot.custom.resolveAdminRun(ctx.params);
            if (!item) {
                reply(ctx, '未找到自定义命令：' + ctx.params);
                return;
            }
            const command = renderCommand(item.command, ctx.params, ctx.groupId, ctx.userId, 'huhobot adminrun');
            runGameCommand(ctx.bot, ctx, command);
        }
    },
    {
        name: '查管理',
        execute(ctx) {
            const admins = ctx.bot.state.listAdmins(ctx.groupId);
            const configured = ctx.bot.config.getList('admin.openids');
            const lines = ['手动管理员：' + (admins.length ? admins.join('、') : '无')];
            if (configured.length) lines.push('配置的管理员：' + configured.join('、'));
            reply(ctx, lines.join('\n'));
        }
    },
    {
        name: '加管理',
        adminOnly: true,
        execute(ctx) {
            if (!gateAdmin(ctx)) return;
            const target = String(ctx.params || '').trim();
            if (!target) {
                reply(ctx, '用法：加管理 <OpenID>');
                return;
            }
            const openid = target.split(/\s+/)[0];
            ctx.bot.state.addAdmin(ctx.groupId, openid);
            reply(ctx, '已添加管理员：' + openid);
        }
    },
    {
        name: '删管理',
        adminOnly: true,
        execute(ctx) {
            if (!gateAdmin(ctx)) return;
            const target = String(ctx.params || '').trim();
            if (!target) {
                reply(ctx, '用法：删管理 <OpenID>');
                return;
            }
            const openid = target.split(/\s+/)[0];
            ctx.bot.state.removeAdmin(ctx.groupId, openid);
            reply(ctx, '已删除管理员：' + openid);
        }
    },
    {
        name: '管理方式',
        adminOnly: true,
        execute(ctx) {
            if (!gateAdmin(ctx)) return;
            const mode = parseMode(ctx.params);
            if (!mode) {
                reply(ctx, '用法：管理方式 <QQ/手动/双重>');
                return;
            }
            ctx.bot.state.setMode(ctx.groupId, mode);
            reply(ctx, '已设置本群管理方式：' + MODE_LABEL[mode]);
        }
    },
    {
        name: '添加白名单',
        adminOnly: true,
        execute(ctx) {
            if (!gateAdmin(ctx)) return;
            const name = String(ctx.params || '').trim();
            if (!name) {
                reply(ctx, '用法：添加白名单 <玩家名>');
                return;
            }
            const command = ctx.bot.config.getString('whitelist.add-command', 'whitelist add {name}').replace(/{name}/g, name);
            runGameCommand(ctx.bot, ctx, command);
        }
    },
    {
        name: '删除白名单',
        adminOnly: true,
        execute(ctx) {
            if (!gateAdmin(ctx)) return;
            const name = String(ctx.params || '').trim();
            if (!name) {
                reply(ctx, '用法：删除白名单 <玩家名>');
                return;
            }
            const command = ctx.bot.config.getString('whitelist.del-command', 'whitelist remove {name}').replace(/{name}/g, name);
            runGameCommand(ctx.bot, ctx, command);
        }
    },
    {
        name: '查白名单',
        execute(ctx) {
            // BDS 1.21+ 用 allowlist list（JSON 输出）；旧版 BDS 需改回 whitelist list（文本输出，解析同样兼容）
            const result = ctx.bot.sendCommand('allowlist list');
            const output = (result && result.output || '').trim();
            if (!output) {
                reply(ctx, '无输出');
                return;
            }
            // 解析 allowlist list 的 JSON 输出（可带 ###* 前缀）→ Markdown 卡片；
            // Markdown 关闭/能力缺失时输出格式化纯文本；解析失败才原样输出
            const names = parseWhitelist(output);
            if (names !== null &&
                markdownEnabled(ctx.bot.config) &&
                ctx.bot.config.getBool('features.markdown-whitelist', true) &&
                typeof ctx.bot.qqclient.sendMarkdown === 'function') {
                ctx.bot.qqclient.sendMarkdown(ctx.groupId, buildWhitelistMarkdown(ctx.bot, names), ctx.msgId);
                return;
            }
            if (names !== null) {
                reply(ctx, formatWhitelistText(names));
                return;
            }
            log.info('[HuHoBotPenguin] 查白名单解析失败，原样输出。原始输出：' + JSON.stringify(output));
            reply(ctx, output);
        }
    },
    {
        name: '绑定白名单',
        execute(ctx) {
            const name = String(ctx.params || '').trim();
            if (!name) {
                reply(ctx, '用法：绑定白名单 <玩家名>');
                return;
            }
            const openid = ctx.userId;
            ctx.bot.state.bindName(ctx.groupId, openid, name);
            const command = ctx.bot.config.getString('whitelist.add-command', 'whitelist add {name}').replace(/{name}/g, name);
            ctx.bot.sendCommand(command);
            reply(ctx, '绑定成功：QQ ' + openid + ' ⇄ 游戏 ' + name + '\n已执行白名单加入：' + command);
        }
    },
    {
        name: '解绑白名单',
        adminOnly: true,
        execute(ctx) {
            if (!gateAdmin(ctx)) return;
            const name = String(ctx.params || '').trim();
            if (!name) {
                reply(ctx, '用法：解绑白名单 <玩家名>（撤销该游戏名对应的 QQ 绑定并移出白名单）');
                return;
            }
            const openid = ctx.bot.state.findOpenidByGameName(ctx.groupId, name);
            let removed = null;
            if (openid) {
                removed = ctx.bot.state.unbindOpenid(ctx.groupId, openid);
            }
            const command = ctx.bot.config.getString('whitelist.del-command', 'whitelist remove {name}').replace(/{name}/g, name);
            ctx.bot.sendCommand(command);
            if (openid) {
                reply(ctx, '已解绑：QQ ' + openid + ' ⇄ 游戏 ' + removed + '\n已执行白名单移除：' + command);
            } else {
                reply(ctx, '未找到该游戏名的绑定记录（已执行白名单移除：' + command + '）');
            }
        }
    },
    {
        name: '解除绑定',
        execute(ctx) {
            const openid = ctx.userId;
            const removed = ctx.bot.state.unbindOpenid(ctx.groupId, openid);
            if (!removed) {
                reply(ctx, '你当前没有绑定记录');
                return;
            }
            const command = ctx.bot.config.getString('whitelist.del-command', 'whitelist remove {name}').replace(/{name}/g, removed);
            ctx.bot.sendCommand(command);
            reply(ctx, '已解除绑定：QQ ' + openid + ' ⇄ 游戏 ' + removed + '\n已执行白名单移除：' + command);
        }
    },
    {
        name: '认证',
        execute(ctx) {
            const target = String(ctx.params || '').trim();
            if (!target) {
                const status = ctx.bot.state.isAuthenticated(ctx.groupId, ctx.userId) ? '已认证' : '未认证';
                reply(ctx, '本人认证状态：' + status + '\nOpenID：' + ctx.userId);
                return;
            }
            if (!gateAdmin(ctx)) return;
            const openid = target.split(/\s+/).pop();
            ctx.bot.state.authenticate(ctx.groupId, openid);
            reply(ctx, '已认证：' + openid);
        }
    },
    {
        name: '解除认证',
        execute(ctx) {
            const target = String(ctx.params || '').trim();
            if (!target) {
                ctx.bot.state.revoke(ctx.groupId, ctx.userId);
                reply(ctx, '已解除本人认证');
                return;
            }
            if (!gateAdmin(ctx)) return;
            const openid = target.split(/\s+/).pop();
            ctx.bot.state.revoke(ctx.groupId, openid);
            reply(ctx, '已解除认证：' + openid);
        }
    },
    {
        name: '全量',
        adminOnly: true,
        execute(ctx) {
            if (!gateAdmin(ctx)) return;
            const enabled = parseOnOff(ctx.params);
            if (enabled === null) {
                reply(ctx, '用法：全量 <开/关>');
                return;
            }
            ctx.bot.state.setFullForwarding(ctx.groupId, enabled);
            reply(ctx, '已设置本群全量转发：' + (enabled ? '开' : '关'));
        }
    },
    {
        name: '已加载插件',
        execute(ctx) {
            const addons = ctx.bot.adapter ? ctx.bot.adapter.getAddons() : [];
            if (!addons.length) {
                reply(ctx, '当前没有已加载的附属插件');
                return;
            }
            const lines = ['🔌 已加载附属插件（' + addons.length + ' 个）：'];
            for (const a of addons) {
                lines.push('- ' + a.name + (a.version ? ' v' + a.version : '') +
                    (a.description ? '：' + a.description : '') +
                    (a.author ? '（' + a.author + '）' : ''));
            }
            reply(ctx, lines.join('\n'));
        }
    }
];

const COMMAND_NAMES = COMMANDS.map((cmd) => cmd.name);

function dispatch(cleaned) {
    const ordered = COMMANDS.slice().sort((a, b) => b.name.length - a.name.length);
    for (const cmd of ordered) {
        if (cleaned === cmd.name || cleaned.startsWith(cmd.name + ' ')) {
            const params = cleaned === cmd.name ? '' : cleaned.slice(cmd.name.length).trim();
            return { cmd, params };
        }
    }
    return null;
}

/**
 * 群消息总入口。
 * @param {object} bot    Bot 门面
 * @param {object} message { id, groupId, content, userId, username, memberRole, timestamp }
 */
function handleGroupMessage(bot, message) {
    if (!message || !message.groupId || message.content === undefined) return;

    const logEvents = bot.config.getBool('debug.log-events', false);
    const groups = bot.config.getList('bot.groups');
    if (groups.length > 0 && !groups.includes(message.groupId)) {
        log.info('[HuHoBotPenguin] 群 ' + message.groupId + ' 不在 bot.groups 白名单，已忽略');
        return;
    }

    const ctx = {
        bot,
        msgId: message.id,
        groupId: message.groupId,
        userId: message.userId,
        username: message.username,
        memberRole: message.memberRole
    };

    // 附属插件 OnBotRecvMsg：在公共命令处理前触发；setCancelled 可拦截全部默认处理
    if (bot.adapter && bot.adapter._recvListeners.size > 0) {
        const recv = bot.adapter.fireRecvMsg(message);
        if (recv.cancelled) return true;
    }

    const cleaned = normalizeContent(message.content);
    if (cleaned) {
        const match = dispatch(cleaned);
        if (match) {
            const toggleKey = 'commands.' + match.cmd.name;
            if (!bot.config.getBool(toggleKey, true)) {
                if (logEvents) log.info('[HuHoBotPenguin] 命令 ' + match.cmd.name + ' 已被关闭，忽略');
                reply(ctx, '此命令已被管理员关闭');
                return true;
            }
            if (logEvents) log.info('[HuHoBotPenguin] 命中命令：' + match.cmd.name + ' 参数=' + JSON.stringify(match.params));
            ctx.params = match.params;
            try {
                match.cmd.execute(ctx);
            } catch (e) {
                log.error('[HuHoBotPenguin] 命令 ' + match.cmd.name + ' 执行出错：' + (e && e.stack || e));
            }
            return true;
        }
        // 附属插件运行时命令：命中后先触发 OnBotCommand（可取消），未取消才执行命令模板
        if (bot.adapter) {
            const rt = bot.adapter.matchRuntimeCommand(cleaned);
            if (rt) {
                const pack = bot.adapter.buildMsgPack(message, { commandKey: rt.key, commandArguments: rt.params });
                const fired = bot.adapter.fireBotCommand(pack);
                if (!fired.cancelled) bot.adapter.executeRuntimeCommand(rt, message);
                return true;
            }
        }
        // 附属插件正则命令：未命中内置/运行时命令后尝试正则匹配（setCancelled 可取消默认处理）
        if (bot.adapter && bot.adapter._regexCommands.size > 0) {
            const rx = bot.adapter.fireRegexCommands(cleaned, message);
            if (rx.cancelled) return true;
        }
        if (logEvents) log.info('[HuHoBotPenguin] 非命令消息（bot.groups=' + JSON.stringify(groups) +
            '，isFullForwarding=' + bot.state.isFullForwarding(message.groupId) + '）');
    }

    // 非命令消息：全量转发到游戏
    if (bot.config.getBool('chat-format.post-chat', true) && bot.state.isFullForwarding(message.groupId)) {
        const raw = String(message.content || '').trim();
        if (raw) {
            bot.auditText(raw).then((filtered) => {
                ctx.bot.broadcast(ctx.bot.formatGroupMessage(displayName(ctx), filtered));
            });
            return true;
        }
    }
    return false;
}

module.exports = { handleGroupMessage, dispatch, normalizeContent, COMMAND_NAMES, COMMANDS };