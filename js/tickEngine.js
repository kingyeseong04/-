// tickEngine.js
// Synthesize a realistic intra-candle tick path from a single OHLC candle.
//
// A candle only stores Open/High/Low/Close, not the actual sequence of trades
// that happened inside it. To "replay" the candle tick-by-tick like a live
// exchange, we generate a plausible price path that:
//   - starts at Open
//   - ends at Close
//   - touches both High and Low at some point
//   - never leaves the [Low, High] band
//   - wiggles like a random walk in between (Brownian-bridge based)

(function (global) {
  'use strict';

  // Standard normal random via Box-Muller.
  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  // Append `steps` points to `arr` walking from the current last value to
  // `target`, as a noisy Brownian bridge clamped into [low, high].
  // The final appended point equals `target` exactly so anchors are hit.
  function bridgeTo(arr, target, steps, low, high, vol) {
    const start = arr[arr.length - 1];
    const band = (high - low) || (Math.abs(target) * 1e-6) || 1e-6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (i === steps) {
        arr.push(target); // land exactly on the anchor
        break;
      }
      const mean = start + (target - start) * t;
      // Brownian-bridge variance shape: peaks in the middle, zero at the ends.
      const scale = vol * band * Math.sqrt(t * (1 - t));
      const val = clamp(mean + randn() * scale, low, high);
      arr.push(val);
    }
  }

  // Generate an array of tick prices for one candle.
  //   o,h,l,c : candle OHLC
  //   n       : approximate number of ticks (>= 4)
  //   vol     : noise factor (fraction of the candle range), default 0.18
  // Returns a price array of length ~n, first ≈ open, last === close,
  // touching both high and low.
  function generateTicks(o, h, l, c, n, vol) {
    n = Math.max(4, n | 0);
    vol = (vol == null) ? 0.18 : vol;

    // Degenerate candle (flat / no range): just repeat.
    if (h === l) {
      const out = new Array(n).fill(o);
      out[n - 1] = c;
      return out;
    }

    // Decide the order in which the extremes are visited.
    // Bullish candles tend to dip first then rally (and vice-versa),
    // but keep it stochastic so replays vary.
    const bullish = c >= o;
    let lowFirst;
    if (bullish) lowFirst = Math.random() < 0.7;   // dip -> rally
    else lowFirst = Math.random() < 0.3;           // pop -> drop
    const e1 = lowFirst ? l : h;
    const e2 = lowFirst ? h : l;

    // Split the available intervals across 3 legs: open->e1->e2->close.
    const intervals = n - 1;
    const k1 = Math.max(1, Math.round(intervals / 3));
    const k2 = Math.max(1, Math.round(intervals / 3));
    const k3 = Math.max(1, intervals - k1 - k2);

    const arr = [o];
    bridgeTo(arr, e1, k1, l, h, vol);
    bridgeTo(arr, e2, k2, l, h, vol);
    bridgeTo(arr, c, k3, l, h, vol);
    return arr;
  }

  global.TickEngine = { generateTicks, randn, clamp };
})(window);
