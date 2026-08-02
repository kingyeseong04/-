// dataSource.js
// Load historical candles from: Binance public API, a CSV file, or a built-in
// offline demo generator (so the app always works even without network).
//
// Candle shape used everywhere in the app:
//   { time: <seconds>, open, high, low, close, volume }

(function (global) {
  'use strict';

  // --- Binance ------------------------------------------------------------
  // GET /api/v3/klines -> array of:
  //   [openTime(ms), open, high, low, close, volume, closeTime, ...]
  // Exchanges cap each request at ~1000 candles, so we paginate to fetch more.
  // Kept high so real sub-candle (tick) data can always be fetched.
  const MAX_CANDLES = 60000;

  // Duration of one candle in ms, per interval (used to build time windows).
  const INTERVAL_MS = {
    '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
    '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3,
    '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3,
  };
  function intervalToMs(interval) { return INTERVAL_MS[interval] || 3600e3; }

  // Finer timeframe used to drive real intra-candle ticks for each interval.
  const SUB_INTERVAL = {
    '5m': '1m', '15m': '1m', '30m': '1m', '1h': '1m',
    '2h': '5m', '4h': '5m', '6h': '5m', '12h': '15m', '1d': '15m', '1w': '1h',
  };
  function subInterval(interval) { return SUB_INTERVAL[interval] || null; }

  // spot=false -> USDT-M perpetual futures (fapi, matches "BTCUSDT.P").
  // spot=true  -> spot (api.binance.com/api/v3), which reliably allows browser
  //               CORS and is used as a last-resort fallback.
  async function klinesBatch(symbol, interval, n, startTime, endTime, spot) {
    const params = new URLSearchParams({
      symbol, interval, limit: String(Math.min(1000, n)),
    });
    if (startTime) params.set('startTime', String(startTime));
    if (endTime) params.set('endTime', String(endTime));
    const url = spot
      ? 'https://api.binance.com/api/v3/klines?' + params.toString()
      : 'https://fapi.binance.com/fapi/v1/klines?' + params.toString();
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Binance HTTP ' + res.status + ': ' + txt.slice(0, 120));
    }
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error('Unexpected Binance response.');
    return raw.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  async function fromBinance(symbol, interval, limit, startTime, endTime, spot) {
    symbol = (symbol || 'BTCUSDT').toUpperCase().trim();
    interval = interval || '1h';
    limit = Math.min(MAX_CANDLES, Math.max(1, limit || 500));

    let out = [];
    if (startTime) {
      // Forward pagination from the chosen start date (Binance is oldest-first).
      let cursor = startTime;
      while (out.length < limit) {
        const batch = await klinesBatch(symbol, interval, limit - out.length, cursor, endTime, spot);
        if (batch.length === 0) break;
        out = out.concat(batch);
        if (batch.length < 1000) break; // reached the present / no more data
        cursor = batch[batch.length - 1].time * 1000 + 1;
        if (endTime && cursor > endTime) break;
      }
    } else {
      // Backward pagination to collect the most recent `limit` candles.
      let end = endTime;
      while (out.length < limit) {
        const batch = await klinesBatch(symbol, interval, limit - out.length, undefined, end, spot);
        if (batch.length === 0) break;
        out = batch.concat(out);
        if (batch.length < 1000) break; // no older data available
        end = batch[0].time * 1000 - 1;
      }
    }

    if (out.length === 0) {
      throw new Error('No candles returned (check symbol / interval / date).');
    }
    // Sort ascending and drop any duplicate timestamps from overlap.
    out.sort((a, b) => a.time - b.time);
    const dedup = [];
    for (const c of out) {
      if (!dedup.length || c.time > dedup[dedup.length - 1].time) dedup.push(c);
    }
    return dedup;
  }

  // --- Bybit (v5) ---------------------------------------------------------
  // GET /v5/market/kline -> result.list of (newest-first):
  //   [startTime(ms), open, high, low, close, volume, turnover]
  // Bybit uses numeric-minute / letter interval codes.
  const BYBIT_INTERVAL = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
    '1d': 'D', '1w': 'W',
  };

  function dedupAsc(out) {
    out.sort((a, b) => a.time - b.time);
    const dedup = [];
    for (const c of out) {
      if (!dedup.length || c.time > dedup[dedup.length - 1].time) dedup.push(c);
    }
    return dedup;
  }

  async function bybitBatch(symbol, interval, n, startTime, endTime) {
    const params = new URLSearchParams({
      category: 'linear',
      symbol,
      interval: BYBIT_INTERVAL[interval] || '60',
      limit: String(Math.min(1000, n)),
    });
    if (startTime) params.set('start', String(Math.floor(startTime)));
    if (endTime) params.set('end', String(Math.floor(endTime)));
    const url = 'https://api.bybit.com/v5/market/kline?' + params.toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error('Bybit HTTP ' + res.status);
    const j = await res.json();
    if (j.retCode !== 0) throw new Error('Bybit ' + j.retCode + ': ' + j.retMsg);
    const list = (j.result && j.result.list) || [];
    return list.map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  async function fromBybit(symbol, interval, limit, startTime, endTime) {
    symbol = (symbol || 'BTCUSDT').toUpperCase().trim();
    interval = interval || '1h';
    limit = Math.min(MAX_CANDLES, Math.max(1, limit || 500));

    // Bybit returns newest-first, so always page BACKWARD from endTime down to
    // startTime (works for both a bounded window and a latest-N request).
    let out = [];
    let end = endTime;
    while (out.length < limit) {
      const batch = await bybitBatch(symbol, interval, limit - out.length, startTime, end);
      if (batch.length === 0) break;
      out = out.concat(batch);
      if (batch.length < 1000) break;
      batch.sort((a, b) => a.time - b.time);
      end = batch[0].time * 1000 - 1;
      if (startTime && end < startTime) break;
    }
    if (out.length === 0) {
      throw new Error('No candles returned (check symbol / interval / date).');
    }
    return dedupAsc(out);
  }

  // Try several sources in order until one succeeds, so data loads even when
  // Bybit or Binance-futures are blocked in the browser (CORS / geo). Binance
  // SPOT reliably allows browser CORS, so it is the last-resort safety net.
  // `source` reports which one actually served the data (honest labelling).
  async function fetchCandles(symbol, interval, limit, startTime, endTime, preferred) {
    const attempts = [
      { name: 'Bybit', fn: () => fromBybit(symbol, interval, limit, startTime, endTime) },
      { name: 'Binance', fn: () => fromBinance(symbol, interval, limit, startTime, endTime, false) },
      { name: 'Binance(spot)', fn: () => fromBinance(symbol, interval, limit, startTime, endTime, true) },
    ];
    // If Binance is explicitly preferred, try it (perp) first.
    if (preferred === 'Binance') attempts.unshift(attempts.splice(1, 1)[0]);

    const errs = [];
    for (let i = 0; i < attempts.length; i++) {
      try {
        const candles = await attempts[i].fn();
        return { candles, source: attempts[i].name, fallback: i > 0, note: errs.join(' | ') };
      } catch (e) {
        errs.push(attempts[i].name + ': ' + e.message);
      }
    }
    throw new Error(errs.join(' | '));
  }

  global.DataSource = {
    fromBinance, fromBybit, fetchCandles, intervalToMs, subInterval,
  };
})(window);
