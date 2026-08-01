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
  //   n       : approximate number of ticks (>= 8)
  //   vol     : noise factor (fraction of the candle range), default 0.12
  // Returns a price array of length ~n, first === open, last === close,
  // touching both high and low. The path swings up and down several times
  // across the candle (choppy, like real intra-candle action) so that a
  // position's P&L oscillates through the bar rather than moving one way.
  function generateTicks(o, h, l, c, n, vol) {
    n = Math.max(8, n | 0);
    vol = (vol == null) ? 0.12 : vol;

    // Degenerate candle (flat / no range): just repeat.
    if (h === l) {
      const out = new Array(n).fill(o);
      out[n - 1] = c;
      return out;
    }

    // Build a sequence of waypoints inside [low, high] so the price reverses
    // several times: open -> (random swings, incl. a forced high and low) ->
    // close. More waypoints = more up/down oscillation within the candle.
    let swings = 4 + Math.floor(Math.random() * 4);     // 4..7 interior turns
    swings = Math.max(2, Math.min(swings, Math.floor(n / 4)));

    const pts = [o];
    for (let i = 0; i < swings; i++) pts.push(l + Math.random() * (h - l));
    // Force one interior waypoint to the high and a different one to the low
    // so the candle's real extremes are always touched.
    const iHigh = 1 + Math.floor(Math.random() * swings);
    let iLow = 1 + Math.floor(Math.random() * swings);
    if (iLow === iHigh) iLow = 1 + (iHigh % swings);
    pts[iHigh] = h;
    pts[iLow] = l;
    pts.push(c);

    // Distribute the ticks across the segments and bridge between waypoints.
    const segs = pts.length - 1;
    const intervals = n - 1;
    const per = Math.max(1, Math.floor(intervals / segs));
    const arr = [o];
    for (let s = 0; s < segs; s++) {
      const steps = (s === segs - 1)
        ? Math.max(1, intervals - per * (segs - 1)) // remainder into last leg
        : per;
      bridgeTo(arr, pts[s + 1], steps, l, h, vol);
    }
    return arr;
  }

  global.TickEngine = { generateTicks, randn, clamp };
})(window);
