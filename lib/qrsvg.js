'use strict';

/**
 * 二维码 SVG + 终端字符画生成。
 * 编码使用内嵌的 qrcode 库（M 级纠错），SVG/终端渲染自行实现。
 */

let QRCode;
try {
    QRCode = require('./vendor/qrcode/lib/core/qrcode');
} catch (e) {
    const err1 = e && e.message || String(e);
    try {
        QRCode = require('qrcode');
    } catch (e2) {
        const err2 = e2 && e2.message || String(e2);
        throw new Error('QR 编码库加载失败：vendor=' + err1 + '；global=' + err2);
    }
}
if (!QRCode || typeof QRCode.create !== 'function') {
    throw new Error('QR 编码库加载失败：模块已加载但 create 不是函数（type=' + typeof QRCode + '）');
}

/**
 * 生成二维码矩阵（0/1）。
 * @param {string} text
 * @returns {{matrix: number[][], version: number}}
 */
function encode(text) {
    const qr = QRCode.create(String(text), { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const matrix = [];
    for (let r = 0; r < size; r++) {
        const row = [];
        for (let c = 0; c < size; c++) {
            row.push(qr.modules.get(r, c) ? 1 : 0);
        }
        matrix.push(row);
    }
    return { matrix, version: qr.version };
}

/**
 * 终端字符画：用半块字符 ▀▄█ 压缩高度（每行输出两个 QR 行）。
 */
function toTerminal(text, opts = {}) {
    const { matrix } = encode(text);
    const quiet = opts.quiet != null ? opts.quiet : 1;
    const n = matrix.length;
    const rows = [];
    for (let r = 0; r < n; r += 2) {
        let line = '';
        for (let p = 0; p < quiet; p++) line += ' ';
        for (let c = 0; c < n; c++) {
            const top = matrix[r][c];
            const bot = r + 1 < n ? matrix[r + 1][c] : 0;
            if (top && bot) line += '\u2588';       // 全黑
            else if (top && !bot) line += '\u2580'; // 上黑下白
            else if (!top && bot) line += '\u2584'; // 上白下黑
            else line += ' ';                       // 全白
        }
        for (let p = 0; p < quiet; p++) line += ' ';
        rows.push(line);
    }
    return rows.join('\n');
}

/**
 * SVG 字符串。
 */
function toSvg(text, opts = {}) {
    const { matrix } = encode(text);
    const n = matrix.length;
    const quiet = opts.quiet != null ? opts.quiet : 2;
    const total = n + quiet * 2;
    const px = opts.size || 240;
    const unit = px / total;
    const fill = opts.fill || '#000';
    const bg = opts.bg || '#fff';
    let path = '';
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (!matrix[r][c]) continue;
            const x = ((c + quiet) * unit).toFixed(2);
            const y = ((r + quiet) * unit).toFixed(2);
            path += 'M' + x + ' ' + y + 'h' + unit.toFixed(2) + 'v' + unit.toFixed(2) + 'h-' + unit.toFixed(2) + 'z';
        }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px +
        '" viewBox="0 0 ' + px + ' ' + px + '">' +
        '<rect width="100%" height="100%" fill="' + bg + '"/>' +
        '<path d="' + path + '" fill="' + fill + '"/></svg>';
}

module.exports = { encode, toSvg, toTerminal };
