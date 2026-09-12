'use strict';

/**
 * 实时 TPS / MSPT 监测（BDS 无 tps 命令，自行测量）。
 * mc.listen("onTick") 每个 tick 触发一次，同步回调的执行耗时即为该 tick 的实际处理时间。
 * 滚动窗口（最近 100 tick）内计算平均 MSPT、峰值 MSPT，并据此推算 TPS。
 * MSPT 基准：满速 20 TPS = 50ms/tick，平均超过 50ms 即服务器过载。
 */

const log = typeof logger !== 'undefined' ? logger : console;

const WINDOW_SIZE = 100;
const TPS_BASELINE_MS = 50;

class TickMonitor {
    constructor() {
        this.handle = null;
        this.window = []; // 最近 N 个 tick 处理耗时（ms）
    }

    /** 注册 onTick 监听；引擎不支持时返回 false（统计功能静默降级）。 */
    start() {
        if (this.handle) return true;
        if (typeof mc === 'undefined' || typeof mc.listen !== 'function') return false;
        try {
            this.handle = mc.listen('onTick', () => this._onTick());
            return true;
        } catch (e) {
            log.warn('[HuHoBotPenguin] onTick 监听注册失败，TPS/MSPT 统计不可用：' + (e && e.message || e));
            return false;
        }
    }

    stop() {
        if (!this.handle) return;
        try { mc.removeListener(this.handle); } catch (e) { /* ignore */ }
        this.handle = null;
    }

    _onTick() {
        let start;
        try {
            start = process.hrtime.bigint();
        } catch (e) {
            start = Date.now();
        }

        // ---- tick 回调体由引擎同步调度，返回即本 tick 处理结束 ----

        let end;
        try {
            end = process.hrtime.bigint();
        } catch (e) {
            end = Date.now();
        }

        let delta;
        if (typeof start === 'bigint') {
            delta = Number(end - start) / 1e6; // 纳秒 → 毫秒
        } else {
            delta = end - start; // Date.now() 已是毫秒
        }

        if (delta >= 0 && delta < 5000) {
            this.window.push(delta);
            if (this.window.length > WINDOW_SIZE) this.window.shift();
        }
    }

    /**
     * 最近窗口统计。
     * @returns {{tps: number, mspt: number, maxMspt: number, ticks: number} | null} 数据不足返回 null
     */
    getStats() {
        if (!this.window.length) return null;
        const sum = this.window.reduce((a, b) => a + b, 0);
        const avg = sum / this.window.length;
        const max = Math.max.apply(null, this.window);
        const tps = avg > 0 ? Math.min(20, 1000 / avg) : 20;
        return {
            tps: Math.round(tps * 10) / 10,
            mspt: Math.round(avg * 10) / 10,
            maxMspt: Math.round(max * 10) / 10,
            ticks: this.window.length
        };
    }
}

/** 状态图标：按实际 TPS 分级（🟢 接近满速 / 🟡 轻微掉速 / 🔴 明显卡顿）。 */
function tickIcon(stats) {
    if (!stats) return '';
    if (stats.tps >= 19.5) return '🟢';
    if (stats.tps >= 15) return '🟡';
    return '🔴';
}

/**
 * 取当前统计（features.online-tps=false 时返回 null）。
 * @param {object} bot Bot 门面（bot.tick 为 TickMonitor 实例）
 */
function getOnlineStats(bot) {
    if (!bot || !bot.tick) return null;
    if (!bot.config.getBool('features.online-tps', true)) return null;
    return bot.tick.getStats();
}

module.exports = { TickMonitor, tickIcon, getOnlineStats, TPS_BASELINE_MS };
