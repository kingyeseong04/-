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
  async function fromBinance(symbol, interval, limit, startTime) {
    symbol = (symbol || 'BTCUSDT').toUpperCase().trim();
    interval = interval || '1m';
    limit = Math.min(1000, Math.max(1, limit || 500));

    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
    if (startTime) params.set('startTime', String(startTime));

    const url = 'https://api.binance.com/api/v3/klines?' + params.toString();
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Binance API error ' + res.status + ': ' + txt.slice(0, 200));
    }
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('No candles returned (check symbol / interval).');
    }
    return raw.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
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

  global.DataSource = { fromBinance, fromCSVFile, parseCSV, demo };
})(window);
