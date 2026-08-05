// indicators.js
// Pure OHLC-based indicator math (no volume needed):
//   - Bollinger Bands (SMA ± k·stdev of close)
//   - Ichimoku Kinko Hyo (Tenkan / Kijun / Senkou A,B / Chikou + cloud)
// Each returns arrays of { time, value } aligned to candle times, plus the
// paired data used to fill the band / cloud.

(function (global) {
  'use strict';

  function bollinger(candles, period, mult) {
    period = period || 20;
    mult = (mult == null) ? 2 : mult;
    const mid = [], upper = [], lower = [], band = [];
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
      const m = sum / period;
      let v = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = candles[j].close - m; v += d * d;
      }
      const sd = Math.sqrt(v / period);
      const t = candles[i].time;
      mid.push({ time: t, value: m });
      upper.push({ time: t, value: m + mult * sd });
      lower.push({ time: t, value: m - mult * sd });
      band.push({ time: t, a: m + mult * sd, b: m - mult * sd });
    }
    return { mid, upper, lower, band };
  }

  function highest(candles, a, b) {
    let m = -Infinity;
    for (let j = a; j <= b; j++) if (candles[j].high > m) m = candles[j].high;
    return m;
  }
  function lowest(candles, a, b) {
    let m = Infinity;
    for (let j = a; j <= b; j++) if (candles[j].low < m) m = candles[j].low;
    return m;
  }

  // tp/kp/sbp: Tenkan/Kijun/SenkouB periods; disp: displacement (26).
  // intervalSec: candle length, used to project the cloud into the future.
  function ichimoku(candles, tp, kp, sbp, disp, intervalSec) {
    tp = tp || 9; kp = kp || 26; sbp = sbp || 52; disp = disp || 26;
    intervalSec = intervalSec || 3600;
    const n = candles.length;
    const lastT = candles[n - 1].time;
    const futureTime = (j) => (j < n ? candles[j].time : lastT + (j - (n - 1)) * intervalSec);

    // The chart only draws the two leading spans + the cloud, so only Tenkan/
    // Kijun midpoints (needed for Senkou A) are tracked — no Chikou/return lines.
    const spanA = [], spanB = [], cloud = [];
    const tAt = new Array(n).fill(null), kAt = new Array(n).fill(null);

    for (let i = 0; i < n; i++) {
      if (i >= tp - 1) tAt[i] = (highest(candles, i - tp + 1, i) + lowest(candles, i - tp + 1, i)) / 2;
      if (i >= kp - 1) kAt[i] = (highest(candles, i - kp + 1, i) + lowest(candles, i - kp + 1, i)) / 2;
    }
    for (let i = 0; i < n; i++) {
      if (tAt[i] != null && kAt[i] != null) {
        spanA.push({ time: futureTime(i + disp), value: (tAt[i] + kAt[i]) / 2 });
      }
      if (i >= sbp - 1) {
        const v = (highest(candles, i - sbp + 1, i) + lowest(candles, i - sbp + 1, i)) / 2;
        spanB.push({ time: futureTime(i + disp), value: v });
      }
    }
    for (let i = sbp - 1; i < n; i++) {
      if (tAt[i] != null && kAt[i] != null) {
        const a = (tAt[i] + kAt[i]) / 2;
        const b = (highest(candles, i - sbp + 1, i) + lowest(candles, i - sbp + 1, i)) / 2;
        cloud.push({ time: futureTime(i + disp), a, b });
      }
    }
    return { spanA, spanB, cloud };
  }

  global.Indicators = { bollinger, ichimoku };
})(window);
