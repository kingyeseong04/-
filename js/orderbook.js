// orderbook.js
// Synthetic order book + trade tape so the UI looks like a live Bybit market.
// A candle has no real depth data, so we fabricate a plausible bid/ask ladder
// around the current price. It's cosmetic (for staged/replay use).

(function (global) {
  'use strict';

  // Reasonable price tick for the ladder based on magnitude.
  function tickSize(p) {
    p = Math.abs(p);
    if (p >= 10000) return 0.5;
    if (p >= 1000) return 0.1;
    if (p >= 100) return 0.01;
    if (p >= 1) return 0.001;
    if (p >= 0.1) return 0.0001;
    return 0.00001;
  }

  // Deterministic-ish pseudo random from a seed so sizes don't flicker wildly
  // between refreshes (they drift instead).
  function rng(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
  }

  // Build a book of `levels` bids and asks around `mid`.
  // `seed` (e.g. an incrementing counter) drives the sizes so they evolve.
  function build(mid, levels, seed) {
    levels = levels || 11;
    const tick = tickSize(mid);
    const rand = rng(Math.floor(seed || 1));
    const asks = [], bids = [];
    let at = 0, bt = 0;
    const base = mid < 1 ? 5000 : mid < 100 ? 200 : mid < 5000 ? 3 : 0.6;
    for (let i = 0; i < levels; i++) {
      const sizeA = +(base * (0.2 + rand() * 1.8)).toFixed(3);
      const sizeB = +(base * (0.2 + rand() * 1.8)).toFixed(3);
      at += sizeA; bt += sizeB;
      asks.push({ price: mid + tick * (i + 1), size: sizeA, total: at });
      bids.push({ price: mid - tick * (i + 1), size: sizeB, total: bt });
    }
    const maxTotal = Math.max(at, bt);
    return { asks, bids, maxTotal, tick };
  }

  global.OrderBook = { build, tickSize };
})(window);
