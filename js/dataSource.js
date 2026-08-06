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
  // Kept high so real sub-candle (tick) data can always be fetched — high enough
  // for the finest sub-intervals (e.g. 250×4h candles × 240 one-minute subs).
  const MAX_CANDLES = 80000;

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

  // Choose the FINEST sub-interval whose total sub-candle count for `replayCount`
  // parent candles stays under `cap`, so ticks are ALWAYS built from real data
  // while keeping the download bounded (finer for small loads, coarser for big).
  // 1m is listed first wherever feasible so intra-candle motion uses the finest
  // real data the exchange offers. The cap keeps the download bounded — the very
  // heaviest case (1d → 1m ≈ 360k subs) is skipped in favour of 1d → 5m.
  const SUB_PREFS = {
    '5m': ['1m'], '15m': ['1m', '5m'], '30m': ['1m', '5m', '15m'],
    '1h': ['1m', '5m', '15m'], '2h': ['1m', '5m', '15m'], '4h': ['1m', '5m', '15m', '1h'],
    '6h': ['1m', '5m', '15m', '1h'], '12h': ['5m', '15m', '1h'], '1d': ['1m', '5m', '15m', '1h'], '1w': ['1h', '4h'],
  };
  function pickSubInterval(interval, replayCount, cap) {
    const prefs = SUB_PREFS[interval];
    if (!prefs) return null;
    cap = cap || 72000;
    const dur = intervalToMs(interval);
    let coarsest = prefs[prefs.length - 1];
    for (const s of prefs) {
      const per = Math.max(1, Math.round(dur / intervalToMs(s)));
      if (replayCount * per <= cap) return s;
    }
    return coarsest; // still real data, just larger — never synthetic
  }

  // --- Symbol registry ----------------------------------------------------
  // Maps each dropdown value to its data provider + display metadata.
  //   provider: 'crypto' (Bybit/Binance) | 'yahoo' (stocks/ETF/gold/KRX)
  //   quote:    'USD' | 'KRW'  (account/price currency for that instrument)
  //   kind:     short exchange/kind tag shown in the legend
  // BTC/ETH stay as Bybit perpetuals; everything else is real spot via Yahoo.
  // All symbols are Bybit USDT-perpetuals so every one supports REAL intra-candle
  // ticks (stocks via Yahoo can't provide real intraday for past dates). The
  // ".P" (TradingView-style) key is stripped to the Bybit API symbol.
  const perp = (t) => ({ label: t + 'USDT.P', provider: 'crypto', api: t + 'USDT', quote: 'USD', kind: 'Bybit Perp' });
  const SYMBOLS = {
    'BTCUSDT.P': perp('BTC'),
    'ETHUSDT.P': perp('ETH'),
    'SOXLUSDT.P': perp('SOXL'),
    'TSLAUSDT.P': perp('TSLA'),
    'COHRUSDT.P': perp('COHR'),
    'ALABUSDT.P': perp('ALAB'),
    'DRAMUSDT.P': perp('DRAM'),
    'XAUUSDT.P': perp('XAU'),
    'SAMSUNGUSDT.P': perp('SAMSUNG'),
  };
  function resolveSymbol(v) {
    if (!v) return null;
    if (SYMBOLS[v]) return SYMBOLS[v];
    // Legacy ".P" values or bare tickers: strip .P and match, else treat as crypto.
    const bare = String(v).toUpperCase().replace(/\.P$/, '');
    for (const k in SYMBOLS) { if (SYMBOLS[k].api === bare || SYMBOLS[k].yahoo === bare) return SYMBOLS[k]; }
    return { label: bare, provider: 'crypto', api: bare, quote: 'USD', kind: 'Crypto' };
  }

  // --- Yahoo Finance (stocks / ETF / gold / KRX) --------------------------
  // Yahoo's chart endpoint returns no CORS headers, so from a browser we fall
  // back through public CORS proxies. interval mapping (Yahoo has no 4h):
  const YAHOO_INTERVAL = {
    '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '4h': '60m',
    '1d': '1d', '1w': '1wk',
  };
  const CORS_PROXIES = [
    (u) => u, // direct first (works if CORS ever allowed / extension present)
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  ];
  async function yahooJson(path) {
    const base = 'https://query1.finance.yahoo.com' + path;
    let lastErr;
    for (const wrap of CORS_PROXIES) {
      try {
        const res = await fetch(wrap(base));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (j && j.chart) return j;
        throw new Error('unexpected shape');
      } catch (e) { lastErr = e; }
    }
    throw new Error('Yahoo unreachable (' + (lastErr && lastErr.message) + ')');
  }
  async function yahooChart(symbol, yint, startSec, endSec) {
    const p = new URLSearchParams({
      interval: yint, period1: String(Math.floor(startSec)),
      period2: String(Math.floor(endSec)), includePrePost: 'false',
    });
    const j = await yahooJson('/v8/finance/chart/' + encodeURIComponent(symbol) + '?' + p.toString());
    const r = j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp || !r.indicators || !r.indicators.quote) return [];
    const q = r.indicators.quote[0];
    const out = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      out.push({ time: r.timestamp[i], open: o, high: h, low: l, close: c, volume: (q.volume && q.volume[i]) || 0 });
    }
    return out;
  }
  // Fetch a window of candles for a Yahoo symbol. Tries the requested interval
  // first; if the date is too old for intraday (Yahoo only serves recent
  // intraday), it widens and falls back to daily so old dates still load.
  async function fromYahoo(symbol, interval, limit, startTime, endTime) {
    const dur = intervalToMs(interval);
    const endMs = endTime || Date.now();
    const startMs = startTime || (endMs - (limit || 200) * dur);
    const yint = YAHOO_INTERVAL[interval] || '1d';
    let rows = [];
    try { rows = await yahooChart(symbol, yint, startMs / 1000, endMs / 1000); } catch (e) { rows = []; }
    if (rows.length < 3 && yint !== '1d') {
      // Intraday unavailable for this (old) date → daily, widened for context.
      rows = await yahooChart(symbol, '1d', startMs / 1000 - 220 * 86400, endMs / 1000 + 5 * 86400);
    }
    if (!rows.length) throw new Error('Yahoo: no data for ' + symbol);
    return dedupAsc(rows);
  }

  // That day's USD→KRW rate. Tries the ECB (frankfurter.app, CORS-friendly, no
  // key), then falls back to Yahoo's KRW=X daily close via the proxy chain.
  // `day` is 'YYYY-MM-DD'. Returns { rate, date, src } or null.
  async function fetchFxUSDKRW(day) {
    if (!day) return null;
    // 1) ECB via frankfurter (returns the date's rate or nearest prior biz day)
    try {
      const r = await fetch('https://api.frankfurter.app/' + day + '?from=USD&to=KRW');
      if (r.ok) {
        const j = await r.json();
        if (j && j.rates && j.rates.KRW) return { rate: j.rates.KRW, date: j.date || day, src: 'ECB' };
      }
    } catch (e) { /* try next */ }
    // 2) Yahoo KRW=X daily close around that date
    try {
      const t = Date.parse(day + 'T00:00:00Z') / 1000;
      if (isFinite(t)) {
        const rows = await yahooChart('KRW=X', '1d', t - 10 * 86400, t + 2 * 86400);
        if (rows.length) {
          let pick = rows[0];
          for (const c of rows) { if (c.time <= t + 86400) pick = c; }
          const d = new Date(pick.time * 1000).toISOString().slice(0, 10);
          return { rate: pick.close, date: d, src: 'Yahoo' };
        }
      }
    } catch (e) { /* give up */ }
    return null;
  }

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
    // Accept either a registry spec object or a raw symbol string.
    const spec = (symbol && typeof symbol === 'object') ? symbol : resolveSymbol(symbol);

    // Stocks / ETF / gold / KRX → Yahoo (with daily fallback for old dates).
    if (spec && spec.provider === 'yahoo') {
      const candles = await fromYahoo(spec.yahoo, interval, limit, startTime, endTime);
      return { candles, source: 'Yahoo', fallback: false, note: '' };
    }

    // Crypto → Bybit, then Binance perp, then Binance spot.
    const apiSym = (spec && spec.api) || (typeof symbol === 'string' ? symbol : 'BTCUSDT');
    const attempts = [
      { name: 'Bybit', fn: () => fromBybit(apiSym, interval, limit, startTime, endTime) },
      { name: 'Binance', fn: () => fromBinance(apiSym, interval, limit, startTime, endTime, false) },
      { name: 'Binance(spot)', fn: () => fromBinance(apiSym, interval, limit, startTime, endTime, true) },
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
    fromBinance, fromBybit, fromYahoo, fetchCandles, intervalToMs, subInterval,
    pickSubInterval, fetchFxUSDKRW, SYMBOLS, resolveSymbol,
  };
})(window);
