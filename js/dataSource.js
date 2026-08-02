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

  async function klinesBatch(symbol, interval, n, startTime, endTime) {
    const params = new URLSearchParams({
      symbol, interval, limit: String(Math.min(1000, n)),
    });
    if (startTime) params.set('startTime', String(startTime));
    if (endTime) params.set('endTime', String(endTime));
    // Binance USDT-M *perpetual futures* (fapi), so it matches "BTCUSDT.P"
    // — not spot (api.binance.com/api/v3), which prints slightly different bars.
    const url = 'https://fapi.binance.com/fapi/v1/klines?' + params.toString();
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Binance API error ' + res.status + ': ' + txt.slice(0, 200));
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

  async function fromBinance(symbol, interval, limit, startTime, endTime) {
    symbol = (symbol || 'BTCUSDT').toUpperCase().trim();
    interval = interval || '1h';
    limit = Math.min(MAX_CANDLES, Math.max(1, limit || 500));

    let out = [];
    if (startTime) {
      // Forward pagination from the chosen start date.
      let cursor = startTime;
      while (out.length < limit) {
        const batch = await klinesBatch(symbol, interval, limit - out.length, cursor, endTime);
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
        const batch = await klinesBatch(symbol, interval, limit - out.length, undefined, end);
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

    let out = [];
    if (startTime) {
      // Forward window from the chosen start (Bybit returns newest-first;
      // we sort each batch to advance the cursor correctly).
      let cursor = startTime;
      while (out.length < limit) {
        const batch = await bybitBatch(symbol, interval, limit - out.length, cursor, endTime);
        if (batch.length === 0) break;
        out = out.concat(batch);
        if (batch.length < 1000) break;
        batch.sort((a, b) => a.time - b.time);
        cursor = batch[batch.length - 1].time * 1000 + 1;
        if (endTime && cursor > endTime) break;
      }
    } else {
      // Backward pagination for the most recent `limit` candles.
      let end = endTime;
      while (out.length < limit) {
        const batch = await bybitBatch(symbol, interval, limit - out.length, undefined, end);
        if (batch.length === 0) break;
        out = out.concat(batch);
        if (batch.length < 1000) break;
        batch.sort((a, b) => a.time - b.time);
        end = batch[0].time * 1000 - 1;
      }
    }
    if (out.length === 0) {
      throw new Error('No candles returned (check symbol / interval / date).');
    }
    return dedupAsc(out);
  }

  // Fetch from the preferred exchange. Bybit falls back to Binance on failure
  // (CORS / geo block); Binance is fetched directly. `source` reports the
  // exchange that actually served the data (honest labelling).
  async function fetchCandles(symbol, interval, limit, startTime, endTime, preferred) {
    preferred = (preferred || 'Bybit');
    if (preferred === 'Binance') {
      const candles = await fromBinance(symbol, interval, limit, startTime, endTime);
      return { candles, source: 'Binance' };
    }
    try {
      const candles = await fromBybit(symbol, interval, limit, startTime, endTime);
      return { candles, source: 'Bybit' };
    } catch (e1) {
      const candles = await fromBinance(symbol, interval, limit, startTime, endTime);
      return { candles, source: 'Binance', fallback: true, note: e1.message };
    }
  }

  // --- CSV ----------------------------------------------------------------
  // Flexible parser:
  //   * With a header row: matches columns named time/date, open, high, low,
  //     close, volume (case-insensitive, in any order).
  //   * Without a header: assumes Binance-dump order
  //     openTime,open,high,low,close,volume,...
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) throw new Error('Empty CSV.');

    const split = (line) => line.split(',').map((s) => s.trim());
    const first = split(lines[0]);
    const firstIsHeader = first.some((c) => isNaN(parseFloat(c)));

    let idx = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
    let startRow = 0;

    if (firstIsHeader) {
      startRow = 1;
      const find = (names) =>
        first.findIndex((h) => names.includes(h.toLowerCase()));
      idx = {
        time: find(['time', 'date', 'datetime', 'opentime', 'timestamp']),
        open: find(['open', 'o']),
        high: find(['high', 'h']),
        low: find(['low', 'l']),
        close: find(['close', 'c']),
        volume: find(['volume', 'vol', 'v']),
      };
      if (idx.open < 0 || idx.high < 0 || idx.low < 0 || idx.close < 0) {
        throw new Error('CSV header missing open/high/low/close columns.');
      }
    }

    const toSeconds = (raw) => {
      if (raw == null || raw === '') return null;
      const num = Number(raw);
      if (!isNaN(num)) {
        // Heuristic: ms vs s vs us based on magnitude.
        if (num > 1e14) return Math.floor(num / 1e6);
        if (num > 1e11) return Math.floor(num / 1000);
        return Math.floor(num);
      }
      const d = Date.parse(raw);
      return isNaN(d) ? null : Math.floor(d / 1000);
    };

    const out = [];
    for (let i = startRow; i < lines.length; i++) {
      const cols = split(lines[i]);
      const o = parseFloat(cols[idx.open]);
      const h = parseFloat(cols[idx.high]);
      const l = parseFloat(cols[idx.low]);
      const c = parseFloat(cols[idx.close]);
      if ([o, h, l, c].some((v) => isNaN(v))) continue;
      let t = idx.time >= 0 ? toSeconds(cols[idx.time]) : null;
      if (t == null) t = (out.length ? out[out.length - 1].time : 0) + 60;
      out.push({
        time: t,
        open: o, high: h, low: l, close: c,
        volume: idx.volume >= 0 ? parseFloat(cols[idx.volume]) || 0 : 0,
      });
    }
    if (out.length === 0) throw new Error('No valid rows parsed from CSV.');
    out.sort((a, b) => a.time - b.time);
    // De-duplicate identical timestamps (lightweight-charts needs strictly asc).
    const dedup = [];
    for (const c of out) {
      if (dedup.length && c.time <= dedup[dedup.length - 1].time) {
        c.time = dedup[dedup.length - 1].time + 1;
      }
      dedup.push(c);
    }
    return dedup;
  }

  function fromCSVFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(parseCSV(String(reader.result))); }
        catch (e) { reject(e); }
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsText(file);
    });
  }

  // --- Demo (offline) -----------------------------------------------------
  // Generates a synthetic random-walk OHLC series so the tool is usable with
  // zero network access.
  function demo(count, startPrice, intervalSec) {
    count = count || 500;
    intervalSec = intervalSec || 60;
    let price = startPrice || 30000;
    let t = Math.floor(Date.now() / 1000) - count * intervalSec;
    const out = [];
    let trend = 0;
    for (let i = 0; i < count; i++) {
      trend = trend * 0.95 + (Math.random() - 0.5) * 0.002; // slow drifting trend
      const open = price;
      const drift = open * (trend + (Math.random() - 0.5) * 0.004);
      let close = open + drift;
      const wick = open * (0.001 + Math.random() * 0.006);
      const high = Math.max(open, close) + Math.random() * wick;
      const low = Math.min(open, close) - Math.random() * wick;
      out.push({
        time: t,
        open, high, low, close,
        volume: 100 + Math.random() * 900,
      });
      price = close;
      t += intervalSec;
    }
    return out;
  }

  global.DataSource = {
    fromBinance, fromBybit, fetchCandles, fromCSVFile, parseCSV, demo,
    intervalToMs, subInterval,
  };
})(window);
