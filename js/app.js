// app.js
// Orchestrates: data loading, the tick-by-tick playback loop, the live chart,
// and the trading account UI.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) =>
    (n == null || isNaN(n)) ? '-' :
      Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = (n) => (n > 0 ? '+' : '');

  // ----- State -----------------------------------------------------------
  const state = {
    candles: [],          // full historical series
    warmup: 60,           // how many candles to show as "history" before replay
    idx: 0,               // index of the candle currently being replayed
    ticks: [],            // synthesized ticks for the current candle
    tickIdx: 0,
    running: { time: 0, open: 0, high: 0, low: 0, close: 0 }, // forming candle
    playing: false,
    speedX: 60,           // playback speed multiplier vs real time (1x = real)
    ticksPerCandle: 60,
    lastPrice: 0,
    symbolLabel: 'DEMO',
    symbol: 'DEMO',
    interval: '',
    exchange: '',
    sessHigh: 0,          // "24h" high/low over the replayed session
    sessLow: 0,
    turnover: 0,          // synthetic 24h turnover (USDT)
    tape: [],             // recent-trades feed (synthetic)
    subMap: null,         // Map candleTime -> real sub-candles (for real ticks)
    pnlBig: false,        // enlarged unrealized-P&L overlay (for video)
    walletBig: false,     // enlarged wallet-balance overlay (for video)
    fx: 1350,             // ₩ per USDT (for KRW conversion)
    orderbook: true,      // show the order book (off → account panel)
    lockView: true,       // lock the chart to the forming candle (no mouse pan)
    _loadMeta: null,
  };

  const chart = new ChartWrap($('chart'));
  const account = new Trading.Account(10000);
  let refreshSpeedLabel = null; // set in bind(); refreshes the 배속 label

  // Sticky price range so the scale (and therefore the position line) stays
  // put while price oscillates within a candle — recomputed only on candle
  // close / load, expanded (never shrunk) if the forming candle breaks out.
  let priceRange = null;
  chart.setPriceRangeProvider(() => priceRange);
  function recomputePriceRange() {
    const from = Math.max(0, state.idx - 48), to = state.idx;
    let lo = Infinity, hi = -Infinity;
    for (let j = from; j <= to; j++) {
      const cc = state.candles[j];
      let c;
      if (j === state.idx) {
        c = (cc && state.running.time === cc.time) ? state.running : null; // skip un-revealed
      } else {
        c = cc;
      }
      if (!c) continue;
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (!isFinite(lo)) { priceRange = null; return; }
    const pad = (hi - lo) * 0.08 || hi * 0.001 || 1;
    priceRange = { min: lo - pad, max: hi + pad, pad };
  }
  function expandPriceRangeToForming() {
    if (!priceRange) { recomputePriceRange(); return; }
    const c = state.running;
    if (!c || !c.time) return;
    const pad = priceRange.pad;
    if (c.low - pad < priceRange.min) priceRange.min = c.low - pad;
    if (c.high + pad > priceRange.max) priceRange.max = c.high + pad;
  }
  // On candle close, only recenter the scale if the visible candles no longer
  // fit the current range — so the entry line holds still across candles.
  function maybeRecenterRange() {
    if (!priceRange) { recomputePriceRange(); return; }
    const from = Math.max(0, state.idx - 48);
    let lo = Infinity, hi = -Infinity;
    for (let j = from; j < state.idx; j++) {
      const c = state.candles[j]; if (!c) continue;
      if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high;
    }
    if (!isFinite(lo)) return;
    if (lo >= priceRange.min && hi <= priceRange.max) return; // still fits — hold
    recomputePriceRange();
  }

  // Indicator settings (both use OHLC only — no volume needed).
  const ind = {
    bb: { on: false, period: 20, mult: 2 },
    ichi: { on: false, tenkan: 9, kijun: 26, senkouB: 52, disp: 26 },
  };
  let indicatorsDirty = false;

  // Recompute indicators from the revealed (closed) candles and redraw.
  function recomputeIndicators() {
    const revealed = state.candles.slice(0, Math.max(1, state.idx));
    if (ind.bb.on && revealed.length >= ind.bb.period) {
      chart.renderBollinger(Indicators.bollinger(revealed, ind.bb.period, ind.bb.mult));
    } else {
      chart.clearBollinger();
    }
    const intervalSec = DataSource.intervalToMs(state.interval || '1h') / 1000;
    if (ind.ichi.on && revealed.length >= Math.max(ind.ichi.kijun, ind.ichi.senkouB)) {
      chart.renderIchimoku(Indicators.ichimoku(
        revealed, ind.ichi.tenkan, ind.ichi.kijun, ind.ichi.senkouB, ind.ichi.disp, intervalSec));
    } else {
      chart.clearIchimoku();
    }
    indicatorsDirty = false;
  }

  // ----- Status / toast --------------------------------------------------
  function setStatus(msg, kind) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status ' + (kind || '');
  }

  // Big centered message over the chart (loading / errors) so it's noticeable.
  function showLoadMsg(msg, kind) {
    const el = $('load-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'load-msg ' + (kind || '');
    el.style.display = 'block';
  }
  function hideLoadMsg() { const el = $('load-msg'); if (el) el.style.display = 'none'; }

  // ----- Load a candle dataset ------------------------------------------
  function loadCandles(candles, label, meta) {
    if (!candles || candles.length < 5) {
      setStatus('Not enough candles to replay.', 'err');
      return;
    }
    pause();
    state.candles = candles;
    state.symbolLabel = label || '';
    meta = meta || {};
    state.symbol = meta.symbol || (label || 'DATA').split('·')[0].trim();
    state.interval = meta.interval || '';
    state.exchange = meta.exchange || '';
    state.subMap = meta.subMap || null;
    chart.setWatermark(state.symbol + (state.interval ? ' · ' + state.interval : ''));
    // History shown before the playhead. Explicit when a centered date window
    // is requested; otherwise a sensible default. Clamp so both sides exist.
    const w = (meta.warmup != null) ? meta.warmup
      : Math.min(60, Math.floor(candles.length * 0.3));
    state.warmup = Math.max(2, Math.min(w, candles.length - 2));
    state.idx = state.warmup;
    state.ticks = [];
    state.tickIdx = 0;
    // Keep the wallet (balance / leverage / trade history) across a
    // same-symbol reload (e.g. switching timeframe); otherwise start fresh.
    if (!meta.keepAccount) account.reset();

    // Show the warmup history; replay continues from there.
    chart.setHistory(candles.slice(0, state.warmup));
    chart.fitContent();
    chart.setEntryLine(null);
    chart.setLiqLine(null);

    state.lastPrice = candles[state.warmup - 1].close;
    if (meta.keepAccount) account.setMark(state.lastPrice);
    lastRenderedPrice = state.lastPrice;
    state.sessHigh = state.sessLow = state.lastPrice;
    state.turnover = state.lastPrice * 180000; // plausible 24h turnover base
    state.tape = [];
    state._tapePrev = state.lastPrice;
    state._loadMeta = {
      symbol: state.symbol, interval: state.interval,
      exchange: state.exchange, warmup: state.warmup, subMap: state.subMap,
    };
    $('symbol-label').textContent = state.symbol;
    $('candle-count').textContent = (candles.length - state.warmup) + ' candles to replay';
    updatePrice(state.lastPrice, 0);
    renderAccount();
    renderTrades();
    recomputePriceRange();
    renderOverlays();
    updateStats();
    renderMarket(0, true);
    recomputeIndicators();
    setPlayEnabled(true); // data is ready — replay can start
    if (refreshSpeedLabel) refreshSpeedLabel(); // label uses the loaded interval
    setStatus('Loaded ' + candles.length + ' candles. Press Play ▶', 'ok');
  }

  // ----- Prepare ticks for the candle at state.idx -----------------------
  function prepareCandle() {
    const c = state.candles[state.idx];
    let ticks = null;
    // Prefer REAL intra-candle motion built from lower-timeframe sub-candles.
    if (state.subMap) {
      const subs = state.subMap.get(c.time);
      if (subs && subs.length) {
        const perSub = Math.max(3, Math.min(8, Math.ceil(state.ticksPerCandle / subs.length)));
        ticks = TickEngine.ticksFromSubs(subs, perSub);
      }
    }
    // Fall back to synthesized ticks (CSV/demo, or no sub data available).
    if (!ticks) {
      ticks = TickEngine.generateTicks(c.open, c.high, c.low, c.close, state.ticksPerCandle);
    }
    state.ticks = ticks;
    state.tickIdx = 0;
    state.running = {
      time: c.time, open: c.open, high: c.open, low: c.open, close: c.open,
    };
  }

  // Fetch finer-timeframe candles for the replay region and group them per
  // parent candle, so playback can use REAL intra-candle motion. Returns a
  // Map(candleTimeSec -> sub-candles[]) or null if not feasible/available.
  async function fetchSubMap(sym, intv, candles, warmupIdx, exch) {
    const subIntv = DataSource.subInterval(intv);
    if (!subIntv) return null;
    const durMs = DataSource.intervalToMs(intv);
    const subDurMs = DataSource.intervalToMs(subIntv);
    const subsPer = Math.max(1, Math.round(durMs / subDurMs));
    const replayCount = candles.length - warmupIdx;
    const needed = replayCount * subsPer + subsPer; // always fetch real data
    const startMs = candles[warmupIdx].time * 1000;
    const endMs = candles[candles.length - 1].time * 1000 + durMs;
    let subRes;
    try {
      subRes = await DataSource.fetchCandles(sym, subIntv, needed, startMs, endMs, exch);
    } catch (e) { return null; }
    const subs = subRes.candles;
    if (!subs || !subs.length) return null;
    const durSec = durMs / 1000;
    const map = new Map();
    let p = 0;
    for (let ci = warmupIdx; ci < candles.length; ci++) {
      const c = candles[ci];
      const lo = c.time, hi = c.time + durSec;
      while (p < subs.length && subs[p].time < lo) p++;
      let q = p; const list = [];
      while (q < subs.length && subs[q].time < hi) { list.push(subs[q]); q++; }
      if (list.length) map.set(c.time, list);
      p = q;
    }
    return map.size ? map : null;
  }

  // ----- Tick advance (data only; no view work) --------------------------
  function stepTick() {
    if (state.idx >= state.candles.length) { finishReplay(); return; }
    if (state.tickIdx === 0 && state.ticks.length === 0) prepareCandle();

    const price = state.ticks[state.tickIdx];
    const r = state.running;
    r.high = Math.max(r.high, price);
    r.low = Math.min(r.low, price);
    r.close = price;
    state.lastPrice = price;
    if (price > state.sessHigh) state.sessHigh = price;
    if (price < state.sessLow) state.sessLow = price;
    account.setMark(price);

    if (account.checkLiquidation(r.time)) {
      onPositionChanged();
      renderTrades();
      setStatus(account.liquidated ? '💥 Account liquidated — balance wiped.'
        : '💥 Position liquidated.', 'err');
    }

    state.tickIdx++;
    if (state.tickIdx >= state.ticks.length) {
      // Finalize candle exactly to real OHLC, then advance.
      const c = state.candles[state.idx];
      chart.updateCandle({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
      });
      state.lastPrice = c.close;
      state.idx++;
      state.ticks = [];
      state.tickIdx = 0;
      indicatorsDirty = true; // a candle closed -> indicators need updating
      maybeRecenterRange();   // hold the scale unless candles exceed it
      if (!state.lockView) chart.scrollToRealTime();
    }
  }

  // Keep the visible window anchored to the forming candle (view lock).
  function anchorView() {
    if (!state.lockView || state.candles.length === 0) return;
    chart.setVisibleLogicalRange(state.idx - 46, state.idx + 12);
  }

  // ----- Per-frame render (once per rAF, regardless of ticks done) --------
  let lastRenderedPrice = 0;
  function renderFrame(ts) {
    // Only draw the forming candle once it's been prepared for the current
    // index (its time matches), else lightweight-charts rejects the stale time.
    const cur = state.candles[state.idx];
    if (cur && state.running.time === cur.time) {
      expandPriceRangeToForming();
      chart.updateCandle(state.running);
    }
    if (state.lockView) anchorView();
    updatePrice(state.lastPrice, state.lastPrice - lastRenderedPrice);
    lastRenderedPrice = state.lastPrice;
    renderAccount();
    renderOverlays();
    updateStats();
    renderMarket(ts);
    if (indicatorsDirty && (ind.bb.on || ind.ichi.on)) recomputeIndicators();
  }

  // Real milliseconds each tick should take, so playback tracks real time:
  // one tick represents (candle duration / #ticks) of market time, divided by
  // the speed multiplier. At 1x a 1-minute candle plays over a real minute.
  function tickDelayMs() {
    const durSec = candleDur();
    const nt = state.ticks.length || state.ticksPerCandle;
    const marketMsPerTick = (durSec * 1000) / Math.max(1, nt);
    return marketMsPerTick / Math.max(0.05, state.speedX);
  }

  // ----- rAF playback loop (real-time paced) -----------------------------
  let rafId = null, lastTs = 0, acc = 0;
  function frame(ts) {
    if (!state.playing) { rafId = null; return; }
    if (lastTs === 0) lastTs = ts;
    acc += Math.min(ts - lastTs, 250); // clamp gaps (e.g. backgrounded tab)
    lastTs = ts;
    let steps = 0;
    while (steps < 2000) {
      const delay = tickDelayMs();
      if (acc < delay) break;
      stepTick();
      acc -= delay;
      steps++;
      if (!state.playing) break;
    }
    renderFrame(ts);
    rafId = state.playing ? requestAnimationFrame(frame) : null;
  }

  // These inputs change how the replay behaves, so they're locked while it's
  // playing and only editable when paused (changes then apply on resume).
  function setInputsLocked(locked) {
    ['inp-capital', 'speed', 'speed-num'].forEach((id) => {
      const el = $(id); if (el) el.disabled = locked;
    });
  }

  // Play / Restart only make sense once data is loaded (enforces the flow:
  // set date → Load → Play).
  function setPlayEnabled(enabled) {
    $('btn-play').disabled = !enabled;
    $('btn-restart').disabled = !enabled;
  }

  function play() {
    if (state.playing || state.candles.length === 0) return;
    if (state.idx >= state.candles.length) return;
    state.playing = true;
    lastTs = 0; acc = 0;
    $('btn-play').textContent = '⏸ Pause';
    setInputsLocked(true);
    setStatus('Replaying… (설정 변경은 일시정지 후)', 'ok');
    rafId = requestAnimationFrame(frame);
  }

  function pause() {
    state.playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    $('btn-play').textContent = '▶ Play';
    setInputsLocked(false);
  }

  function togglePlay() { state.playing ? pause() : play(); }

  function finishReplay() {
    pause();
    setStatus('Replay finished. Reload data to run again.', 'ok');
  }

  // ----- Rendering -------------------------------------------------------
  // Sensible price decimals based on magnitude (like an exchange).
  function dec(p) {
    p = Math.abs(p);
    if (p >= 1000) return 2;
    if (p >= 1) return 2;
    if (p >= 0.1) return 4;
    return 6;
  }

  // The candle currently shown: the forming one mid-replay, else the last
  // revealed candle.
  function currentCandle() {
    const cur = state.candles[state.idx];
    if (cur && state.running.time === cur.time) return state.running;
    const j = Math.min(state.idx, state.candles.length) - 1;
    return state.candles[Math.max(0, j)];
  }

  // TradingView resolution code shown in Bybit's legend (5m→5, 1h→60, 1d→1D).
  function tvRes(intv) {
    return { '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120',
      '4h': '240', '6h': '360', '12h': '720', '1d': '1D', '1w': '1W' }[intv] || intv;
  }

  // Bybit-style top-left legend: "SYM Perpetual · RES · Bybit" + colored OHLC.
  function updateLegend() {
    const c = currentCandle();
    if (!c) return;
    const d = dec(c.close);
    const up = c.close >= c.open;
    const col = up ? 'var(--up)' : 'var(--down)';
    const chg = c.close - c.open;
    const chgPct = c.open ? (chg / c.open) * 100 : 0;
    const meta = 'Perpetual · ' + tvRes(state.interval) + ' · ' + (state.exchange || 'Bybit');
    $('legend').innerHTML =
      '<span class="sym">' + state.symbol + '</span>' +
      '<span class="meta"> ' + meta + '</span>' +
      '<span class="ohlc" style="color:' + col + '">' +
      '<span class="lbl">O</span>' + fmt(c.open, d) + ' ' +
      '<span class="lbl">H</span>' + fmt(c.high, d) + ' ' +
      '<span class="lbl">L</span>' + fmt(c.low, d) + ' ' +
      '<span class="lbl">C</span>' + fmt(c.close, d) + '  ' +
      sign(chg) + fmt(chg, d) + ' (' + sign(chgPct) + fmt(chgPct, 2) + '%)' +
      '</span>';
  }

  function fmtDur(s) {
    s = Math.max(0, s | 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
  }

  // Convert a USDT amount to a "₩1,234,567" Korean-won string.
  function fmtKRW(usdt) {
    const won = Math.round((usdt || 0) * state.fx);
    return (won < 0 ? '-₩' : '₩') + Math.abs(won).toLocaleString('en-US');
  }

  // Enlarged unrealized-P&L overlay (toggle + draggable) for video emphasis.
  function updatePnlBig() {
    const el = $('pnl-big');
    if (!state.pnlBig) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    if (account.qty === 0) {
      el.className = 'pnl-big';
      el.innerHTML =
        '<span class="pnl-big-label">Unrealized P&amp;L</span>' +
        '<span class="pnl-big-val" style="color:var(--muted)">포지션 없음</span>';
      return;
    }
    const pnl = account.unrealizedPnl;
    const pct = account.unrealizedPnlPct;
    el.className = 'pnl-big ' + (pnl > 0 ? 'up' : pnl < 0 ? 'down' : '');
    el.innerHTML =
      '<span class="pnl-big-label">Unrealized P&amp;L</span>' +
      '<span class="pnl-big-val">' + sign(pnl) + fmt(pnl) + ' USDT</span>' +
      '<span class="pnl-big-pct">' + sign(pct) + fmt(pct, 2) + '%</span>' +
      '<span class="pnl-big-krw">' + fmtKRW(pnl) + '</span>';
  }

  // Enlarged Equity + Available overlay (toggle + draggable) for video.
  function updateWalletBig() {
    const el = $('wallet-big');
    if (!state.walletBig) { el.style.display = 'none'; return; }
    el.className = 'pnl-big';
    el.innerHTML =
      '<span class="pnl-big-label">Equity</span>' +
      '<span class="pnl-big-val" style="color:var(--text)">' + fmt(account.equity) + ' USDT</span>' +
      '<span class="pnl-big-krw">' + fmtKRW(account.equity) + '</span>' +
      '<span class="pnl-big-label" style="margin-top:12px">Available</span>' +
      '<span class="pnl-big-val" style="color:var(--text)">' + fmt(account.available) + ' USDT</span>' +
      '<span class="pnl-big-krw">' + fmtKRW(account.available) + '</span>';
    el.style.display = 'flex';
  }

  // Account panel shown in place of the order book (Unrealized P&L + Wallet).
  function updateAccountPanel() {
    if (state.orderbook) return; // panel is hidden
    const pnl = account.unrealizedPnl, pct = account.unrealizedPnlPct;
    $('ap-pnl-usdt').parentElement.className = 'ap-block ' + (pnl > 0 ? 'up' : pnl < 0 ? 'down' : '');
    $('ap-pnl-usdt').textContent = (account.qty === 0 ? '0.00 USDT' : sign(pnl) + fmt(pnl) + ' USDT');
    $('ap-pnl-pct').textContent = sign(pct) + fmt(pct, 2) + '%';
    $('ap-pnl-krw').textContent = fmtKRW(pnl);
    $('ap-equity').textContent = fmt(account.equity) + ' USDT';
    $('ap-equity-krw').textContent = fmtKRW(account.equity);
    $('ap-available').textContent = fmt(account.available) + ' USDT';
    $('ap-available-krw').textContent = fmtKRW(account.available);
  }

  // Bybit-style position label sitting on the entry line: side-coloured P&L
  // box + size + close (×). Tracks the entry price's y so it rides the line.
  function updatePosLabel() {
    const el = $('pos-label');
    if (account.qty === 0) { el.style.display = 'none'; return; }
    const y = chart.priceToY(account.avgEntry);
    if (y == null) { el.style.display = 'none'; return; }
    const isLong = account.qty > 0;
    const pnl = account.unrealizedPnl;
    el.className = 'pos-label ' + (isLong ? 'long' : 'short');
    el.innerHTML =
      '<span class="pl-pnl">P&amp;L ' + sign(pnl) + fmt(pnl) + '</span>' +
      '<span class="pl-size">' + fmt(Math.abs(account.qty), 3) + '</span>' +
      '<span class="pl-close" data-poscloseall>✕</span>';
    el.style.top = y + 'px';
    el.style.display = 'flex';
  }

  function renderOverlays() {
    updateLegend(); updatePnlBig(); updateWalletBig(); updateAccountPanel(); updatePosLabel();
  }

  // Cost (initial margin) shown on the Buy/Sell buttons.
  function updateCost() {
    const margin = parseFloat($('order-margin').value) || 0;
    const txt = 'Cost ' + fmt(margin);
    $('cost-long').textContent = txt;
    $('cost-short').textContent = txt;
  }

  function updatePrice(price, delta) {
    const el = $('price');
    el.textContent = fmt(price, dec(price));
    el.classList.remove('up', 'down');
    if (delta > 0) el.classList.add('up');
    else if (delta < 0) el.classList.add('down');

    const first = state.candles[state.warmup] ? state.candles[state.warmup].open : price;
    const chg = first ? ((price - first) / first) * 100 : 0;
    const chgEl = $('price-change');
    chgEl.textContent = sign(chg) + fmt(chg, 2) + '%';
    chgEl.className = 'price-change ' + (chg >= 0 ? 'up' : 'down');
  }

  // Duration (seconds) of the candle currently being replayed.
  function candleDur() {
    const i = state.idx;
    if (state.candles[i + 1] && state.candles[i]) return state.candles[i + 1].time - state.candles[i].time;
    if (state.candles[i] && state.candles[i - 1]) return state.candles[i].time - state.candles[i - 1].time;
    return 60;
  }

  function hhmmss(sec) {
    const dt = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
  }

  function fmtBig(n) {
    n = Math.abs(n || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return n.toFixed(0);
  }

  // Top market-stats bar (mark / 24h high-low / turnover / funding countdown).
  function updateStats() {
    const d = dec(state.lastPrice);
    $('stat-mark').textContent = fmt(state.lastPrice, d);
    $('stat-high').textContent = fmt(state.sessHigh, d);
    $('stat-low').textContent = fmt(state.sessLow, d);
    $('stat-turnover').textContent = fmtBig(state.turnover);
    // Funding countdown to the next 8h boundary (cosmetic, uses the wall clock).
    const now = Date.now() / 1000;
    const period = 8 * 3600;
    $('stat-countdown').textContent = fmtDur(period - (now % period));
  }

  // ----- Order book + trade tape (synthetic, Bybit look) -----------------
  let _bookSeed = 1, _lastMktTs = -1e9;
  function obRow(side, lvl, maxTotal, d) {
    const w = Math.max(2, (lvl.total / maxTotal) * 100);
    return '<div class="ob-row ' + side + '">' +
      '<span class="p">' + fmt(lvl.price, d) + '</span>' +
      '<span class="q">' + fmt(lvl.size, 3) + '</span>' +
      '<span class="t">' + fmt(lvl.total, 2) + '</span>' +
      '<span class="depth" style="width:' + w.toFixed(1) + '%"></span></div>';
  }

  function renderMarket(ts, force) {
    if (state.lastPrice <= 0) return;
    if (!force && ts != null && (ts - _lastMktTs) < 130) return;
    _lastMktTs = (ts == null ? _lastMktTs : ts);

    const d = dec(state.lastPrice);
    _bookSeed++;
    const book = OrderBook.build(state.lastPrice, 11, _bookSeed);
    $('ob-asks').innerHTML = book.asks.slice().reverse()
      .map((l) => obRow('ask', l, book.maxTotal, d)).join('');
    $('ob-bids').innerHTML = book.bids
      .map((l) => obRow('bid', l, book.maxTotal, d)).join('');

    const obEl = $('ob-spread');
    const upDir = state.lastPrice >= (state._prevMkt || state.lastPrice);
    state._prevMkt = state.lastPrice;
    obEl.textContent = fmt(state.lastPrice, d);
    obEl.className = 'ob-last ' + (upDir ? 'up' : 'down');

    // Append one synthetic trade to the tape.
    const side = state.lastPrice >= (state._tapePrev || state.lastPrice) ? 'buy' : 'sell';
    state._tapePrev = state.lastPrice;
    const frac = state.ticks.length ? state.tickIdx / state.ticks.length : 0;
    const tsec = (state.running.time || (state.candles[state.warmup - 1] || {}).time || 0) + frac * candleDur();
    const base = state.lastPrice < 1 ? 5000 : state.lastPrice < 100 ? 200 : state.lastPrice < 5000 ? 3 : 0.6;
    const size = +(base * (0.05 + Math.random() * 0.6)).toFixed(3);
    state.tape.unshift({ p: state.lastPrice, size, side, tsec });
    if (state.tape.length > 28) state.tape.pop();
    state.turnover += size * state.lastPrice; // accumulate 24h turnover
    $('recent-trades').innerHTML = state.tape.map((t) =>
      '<div class="rt-row ' + t.side + '"><span class="p">' + fmt(t.p, d) + '</span>' +
      '<span class="q">' + fmt(t.size, 3) + '</span>' +
      '<span class="tm">' + hhmmss(t.tsec) + '</span></div>').join('');

    // Buy/sell ratio bar from cumulative book depth.
    const bidVol = book.bids[book.bids.length - 1].total;
    const askVol = book.asks[book.asks.length - 1].total;
    const bpct = Math.round((bidVol / (bidVol + askVol)) * 100);
    $('ob-ratio-fill').style.width = bpct + '%';
    $('ob-ratio-b').textContent = 'B ' + bpct + '%';
    $('ob-ratio-s').textContent = (100 - bpct) + '% S';
  }

  // Rebuild the position-row STRUCTURE only when it changes (open/close/side/
  // qty/entry); update the per-tick values (mark, value, P&L) with textContent.
  // This avoids rebuilding DOM + re-attaching a listener every frame, which
  // made frames heavy while a position was open (and dropped taps on iPad).
  let _posSig = null;
  function renderAccount() {
    $('balance').textContent = fmt(account.balance);
    $('equity').textContent = fmt(account.equity);
    $('available').textContent = fmt(account.available);

    const tbody = $('pos-rows');
    const isLong = account.qty > 0;
    const sig = account.qty === 0 ? 'flat'
      : (isLong ? 'L' : 'S') + Math.abs(account.qty).toFixed(6) + '@' + account.avgEntry;
    if (sig !== _posSig) {
      _posSig = sig;
      if (account.qty === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty">No open position</td></tr>';
      } else {
        const d = dec(account.avgEntry);
        tbody.innerHTML = '<tr>' +
          '<td>' + state.symbol + '</td>' +
          '<td class="' + (isLong ? 'side-long' : 'side-short') + '">' +
            (isLong ? 'Long' : 'Short') + ' ' + fmt(Math.abs(account.qty), 4) + '</td>' +
          '<td id="pos-value-cell"></td>' +
          '<td>' + fmt(account.avgEntry, d) + '</td>' +
          '<td id="pos-mark-cell"></td>' +
          '<td>' + fmt(account.liquidationPrice, d) + '</td>' +
          '<td id="pos-pnl-cell"></td>' +
          '<td><button class="row-close" data-close="1">Close</button></td>' +
          '</tr>';
      }
    }
    if (account.qty !== 0) {
      const d = dec(account.avgEntry);
      const pnl = account.unrealizedPnl;
      const vc = $('pos-value-cell'); if (vc) vc.textContent = fmt(account.notional);
      const mc = $('pos-mark-cell'); if (mc) mc.textContent = fmt(account.markPrice, d);
      const pc = $('pos-pnl-cell');
      if (pc) {
        pc.className = pnl >= 0 ? 'up' : 'down';
        pc.textContent = sign(pnl) + fmt(pnl) +
          ' (' + sign(account.unrealizedPnlPct) + fmt(account.unrealizedPnlPct, 2) + '%)';
      }
    }
  }

  function onPositionChanged() {
    if (account.qty === 0) {
      chart.setEntryLine(null);
      chart.setLiqLine(null);
    } else {
      chart.setEntryLine(account.avgEntry, account.qty > 0 ? 'long' : 'short', Math.abs(account.qty));
      chart.setLiqLine(account.liquidationPrice);
    }
    renderAccount();
    updatePnlBig();
    updateWalletBig();
    updateAccountPanel();
    updatePosLabel();
  }

  function renderTrades() {
    const tbody = $('trades-body');
    tbody.innerHTML = '';
    const rows = account.trades.slice().reverse();
    for (const t of rows) {
      const tr = document.createElement('tr');
      const cls = t.pnl >= 0 ? 'up' : 'down';
      tr.innerHTML =
        '<td class="' + (t.side === 'long' ? 'up' : 'down') + '">' + t.side.toUpperCase() +
        (t.liquidated ? ' 💥' : '') + '</td>' +
        '<td>' + fmt(t.entry, t.entry < 10 ? 5 : 2) + '</td>' +
        '<td>' + fmt(t.exit, t.exit < 10 ? 5 : 2) + '</td>' +
        '<td>' + fmt(t.qty, 4) + '</td>' +
        '<td class="' + cls + '">' + sign(t.pnl) + fmt(t.pnl) + '</td>' +
        '<td class="' + cls + '">' + sign(t.pnlPct) + fmt(t.pnlPct, 1) + '%</td>';
      tbody.appendChild(tr);
    }
    const realized = account.realizedTotal;
    const rEl = $('realized-total');
    rEl.textContent = sign(realized) + fmt(realized);
    rEl.className = realized >= 0 ? 'up' : 'down';
    $('fees-total').textContent = fmt(account.feesTotal);
    $('trade-count').textContent = account.trades.length;
  }

  // ----- Trading actions -------------------------------------------------
  function placeOrder(side) {
    if (state.lastPrice <= 0) { setStatus('Load data first.', 'err'); return; }
    const margin = parseFloat($('order-margin').value);
    const lev = parseFloat($('order-lev').value);
    const time = state.running.time || 0;
    const res = account.order(side, margin, lev, state.lastPrice, time);
    if (!res.ok) { setStatus(res.msg, 'err'); return; }
    onPositionChanged();
    renderTrades();
    setStatus(side.toUpperCase() + ' filled @ ' + fmt(state.lastPrice), 'ok');
  }

  function closePartial(frac) {
    if (account.qty === 0) { setStatus('No open position.', 'err'); return; }
    const res = account.reduce(frac, state.lastPrice, state.running.time || 0);
    if (!res.ok) { setStatus(res.msg, 'err'); return; }
    onPositionChanged();
    renderTrades();
    setStatus('Closed ' + Math.round(frac * 100) + '% @ ' + fmt(state.lastPrice), 'ok');
  }

  // ----- Wiring ----------------------------------------------------------
  function bind() {
    $('btn-play').addEventListener('click', togglePlay);
    $('btn-restart').addEventListener('click', () => {
      if (state.candles.length) loadCandles(state.candles, state.symbolLabel, state._loadMeta);
    });

    // Tabs (Positions / Trade History)
    const switchTab = (which) => {
      const p = which === 'positions';
      $('tab-positions').classList.toggle('active', p);
      $('tab-history').classList.toggle('active', !p);
      $('panel-positions').style.display = p ? '' : 'none';
      $('panel-history').style.display = p ? 'none' : '';
    };
    $('tab-positions').addEventListener('click', () => switchTab('positions'));
    $('tab-history').addEventListener('click', () => switchTab('history'));

    // Delegated Close button (row is rebuilt on change, not every frame).
    $('pos-rows').addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closePartial(1);
    });
    // Close (×) on the on-chart position label.
    $('pos-label').addEventListener('click', (e) => {
      if (e.target.closest('[data-poscloseall]')) closePartial(1);
    });

    // Speed = real-time multiplier (배속). Slider 0..100 maps exponentially to
    // 1×..3600×. The label shows how long ONE candle of the current interval
    // takes at the chosen speed.
    const MAXX = 3600;
    const sliderToX = (v) => Math.max(1, Math.min(MAXX, Math.round(Math.exp(Math.log(MAXX) * (v / 100)))));
    const xToSlider = (x) => Math.round(100 * Math.log(Math.max(1, x)) / Math.log(MAXX));
    const fmtDurLabel = (s) => s >= 60 ? (s / 60).toFixed(1) + '분'
      : s >= 1 ? s.toFixed(1) + '초' : (s * 1000).toFixed(0) + 'ms';
    const currentIntervalSec = () => {
      const intv = state.interval || $('inp-interval').value || '1m';
      return DataSource.intervalToMs(intv) / 1000;
    };
    const updateSpeedLabel = () => {
      const perCandle = currentIntervalSec() / state.speedX;
      $('speed-label').textContent = state.speedX + '× · 1봉≈' + fmtDurLabel(perCandle);
    };
    // Slider and the direct-entry number box both drive speedX and sync.
    const setSpeed = (x, from) => {
      state.speedX = Math.max(1, Math.min(MAXX, Math.round(x || 1)));
      if (from !== 'num') $('speed-num').value = state.speedX;
      if (from !== 'slider') $('speed').value = xToSlider(state.speedX);
      updateSpeedLabel();
    };
    $('speed').addEventListener('input', (e) => setSpeed(sliderToX(Number(e.target.value)), 'slider'));
    $('speed-num').addEventListener('input', (e) => setSpeed(Number(e.target.value), 'num'));
    $('inp-interval').addEventListener('change', updateSpeedLabel);
    setSpeed(state.speedX);
    // Keep the reference so the label can refresh after data loads.
    refreshSpeedLabel = updateSpeedLabel;

    // Starting capital (USDT). Applies immediately when flat, and on next load.
    $('inp-capital').addEventListener('change', (e) => {
      const v = Math.max(1, Number(e.target.value) || 10000);
      account.startBalance = v;
      if (account.qty === 0) { account.reset(); onPositionChanged(); renderTrades(); }
    });
    // Exchange rate (₩/USDT) for the KRW readouts.
    $('inp-fx').addEventListener('input', (e) => {
      state.fx = Math.max(0, Number(e.target.value) || 0);
      updatePnlBig();
      updateWalletBig();
      updateAccountPanel();
    });

    // Order book on/off — when off, the column shows the P&L + Wallet panel.
    $('btn-book').addEventListener('click', () => {
      state.orderbook = !state.orderbook;
      $('btn-book').classList.toggle('active', state.orderbook);
      $('book-section').style.display = state.orderbook ? '' : 'none';
      $('account-panel').style.display = state.orderbook ? 'none' : 'flex';
      updateAccountPanel();
    });
    $('btn-long').addEventListener('click', () => placeOrder('long'));
    $('btn-short').addEventListener('click', () => placeOrder('short'));
    $('btn-close').addEventListener('click', () => closePartial(1));
    $('btn-close-half').addEventListener('click', () => closePartial(0.5));

    $('order-lev').addEventListener('input', (e) => {
      $('lev-label').textContent = e.target.value + 'x';
      $('lev-chip').textContent = e.target.value + 'x';
      updateCost();
    });

    // Order size % of available (Bybit-style quick sizing) + cost estimate.
    const setPct = (pct) => {
      const avail = Math.max(0, account.available);
      $('order-margin').value = Math.max(1, Math.round(avail * pct / 100));
      $('order-pct').value = pct;
      updateCost();
    };
    $('order-pct').addEventListener('input', (e) => setPct(Number(e.target.value)));
    document.querySelectorAll('.qty-pct-btns button').forEach((b) => {
      b.addEventListener('click', () => setPct(Number(b.dataset.pct)));
    });
    $('order-margin').addEventListener('input', updateCost);
    updateCost();

    // Data: Bybit perpetual around a chosen date (+ real intra-candle ticks).
    // Extra history is pulled BEFORE the date so indicators (Ichimoku needs
    // ~78 bars of lookback) are valid immediately; the view still focuses near
    // the chosen date and only the AFTER candles are replayed.
    const BEFORE = 130, AFTER = 30, VIEW_BEFORE = 34;
    $('btn-binance').addEventListener('click', async () => {
      // Accept TradingView ".P" notation (e.g. TSLAUSDT.P) — strip it for the API.
      const sym = ($('inp-symbol').value.trim() || 'BTCUSDT').toUpperCase().replace(/\.P$/, '');
      const intv = $('inp-interval').value;
      const exch = 'Bybit'; // Bybit only (Binance kept as silent fallback)
      const startVal = $('inp-start').value; // datetime-local, local time
      if (!startVal) { setStatus('날짜·시각을 먼저 선택하세요.', 'err'); return; }
      try {
        // If the SAME symbol+date is reloaded (i.e. only the timeframe changed),
        // continue from the current playhead time and carry the open position —
        // instead of rewinding to the date.
        const sameSymbol = state.candles.length > 0 && sym === state.symbol;
        const continueRun = sameSymbol && startVal === state._loadDateStr;
        let center = new Date(startVal).getTime();
        if (isNaN(center)) { setStatus('Invalid date.', 'err'); return; }
        if (continueRun) {
          const cur = state.candles[Math.min(state.idx, state.candles.length - 1)];
          if (cur) center = cur.time * 1000;
        }
        const ms = DataSource.intervalToMs(intv);
        showLoadMsg('불러오는 중… ' + sym + ' ' + intv);
        setStatus('Fetching ' + sym + ' ' + intv + ' around ' + startVal.replace('T', ' ') + '…');
        const res = await DataSource.fetchCandles(
          sym, intv, BEFORE + AFTER + 5, center - BEFORE * ms, center + AFTER * ms, exch);
        let warmup = 0;
        for (let i = 0; i < res.candles.length; i++) {
          if (res.candles[i].time * 1000 <= center) warmup = i; else break;
        }

        const source = res.source; // exchange that actually served the data
        setStatus('Loading real intra-candle data…');
        const subMap = await fetchSubMap(sym, intv, res.candles, warmup, source);

        // Same symbol → keep the wallet (balance/leverage/trades). In a
        // timeframe switch (continueRun) also KEEP the open position and pick
        // up at the current time. When only the DATE changed, settle the open
        // position first (money isn't lost) since the replay jumps elsewhere.
        const keepAccount = sameSymbol;
        if (keepAccount && !continueRun && account.qty !== 0) {
          account.closeAll(state.lastPrice, state.running.time || 0);
        }

        const meta = { symbol: sym, interval: intv, exchange: source, subMap, warmup, keepAccount };
        const label = source + ' · ' + sym + ' · ' + intv;
        loadCandles(res.candles, label, meta);
        state._loadDateStr = startVal;
        // Re-draw the carried-over position's lines (loadCandles cleared them).
        if (continueRun && account.qty !== 0) onPositionChanged();
        // Focus the view near the chosen date (extra lookback stays off-screen).
        if (state.lockView) anchorView();
        else chart.setVisibleLogicalRange(warmup - VIEW_BEFORE, res.candles.length + 2);
        hideLoadMsg();

        const bits = [source + ' ' + res.candles.length + ' candles'];
        if (res.fallback) bits.push('(⚠ → ' + source + ')');
        bits.push(subMap ? 'real ticks ✓' : 'synthetic ticks');
        if (continueRun) bits.push((account.qty !== 0 ? '포지션·잔고' : '잔고') + ' 유지 (이어서)');
        else if (keepAccount) bits.push('잔고 유지 ' + fmt(account.balance) + ' USDT');
        setStatus(bits.join(' · ') + '. Press Play ▶', res.fallback ? 'err' : 'ok');
      } catch (err) {
        showLoadMsg('불러오기 실패\n' + err.message +
          '\n\n브라우저에서 거래소 API가 막혔을 수 있어요 (지역 차단/네트워크).', 'err');
        setStatus('불러오기 실패: ' + err.message, 'err');
      }
    });

    // Draggable helper. Uses document-level listeners added only while
    // dragging (no setPointerCapture, which could get stuck on touch and
    // then swallow every tap on the page).
    const makeDraggable = (el) => {
      let ox = 0, oy = 0;
      const onMove = (e) => {
        const p = el.parentElement.getBoundingClientRect();
        el.style.left = (e.clientX - p.left - ox) + 'px';
        el.style.top = (e.clientY - p.top - oy) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      };
      el.addEventListener('pointerdown', (e) => {
        const r = el.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        el.style.transform = 'none';
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        e.preventDefault();
      });
    };
    makeDraggable($('pnl-big'));
    makeDraggable($('wallet-big'));

    // Enlarged P&L overlay toggle.
    $('btn-pnl').addEventListener('click', () => {
      state.pnlBig = !state.pnlBig;
      $('btn-pnl').classList.toggle('active', state.pnlBig);
      updatePnlBig();
    });
    // Enlarged Wallet-balance overlay toggle.
    $('btn-wallet').addEventListener('click', () => {
      state.walletBig = !state.walletBig;
      $('btn-wallet').classList.toggle('active', state.walletBig);
      updateWalletBig();
    });
    // Lock the chart to the forming candle (disable mouse pan/zoom).
    const applyLock = () => {
      $('btn-lock').classList.toggle('active', state.lockView);
      chart.setInteraction(!state.lockView);
      if (state.lockView) anchorView();
    };
    $('btn-lock').addEventListener('click', () => {
      state.lockView = !state.lockView;
      applyLock();
    });
    applyLock(); // set initial interaction state (locked by default)

    // Indicators: toggle panel + apply settings live.
    $('btn-ind').addEventListener('click', () => {
      const p = $('ind-panel');
      p.style.display = (p.style.display === 'none' || !p.style.display) ? 'flex' : 'none';
    });
    const readInd = () => {
      ind.bb.on = $('bb-on').checked;
      ind.bb.period = Math.max(2, parseInt($('bb-period').value, 10) || 20);
      ind.bb.mult = Math.max(0.1, parseFloat($('bb-mult').value) || 2);
      ind.ichi.on = $('ichi-on').checked;
      ind.ichi.tenkan = Math.max(1, parseInt($('ichi-t').value, 10) || 9);
      ind.ichi.kijun = Math.max(1, parseInt($('ichi-k').value, 10) || 26);
      ind.ichi.senkouB = Math.max(1, parseInt($('ichi-b').value, 10) || 52);
      ind.ichi.disp = Math.max(0, parseInt($('ichi-d').value, 10) || 26);
      recomputeIndicators();
    };
    ['bb-on', 'bb-period', 'bb-mult', 'ichi-on', 'ichi-t', 'ichi-k', 'ichi-b', 'ichi-d']
      .forEach((id) => $(id).addEventListener('change', readInd));

    // Clean / recording mode: chart-only, optionally real fullscreen.
    $('btn-clean').addEventListener('click', () => setClean(true));
    $('btn-exit-clean').addEventListener('click', () => setClean(false));
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) document.body.classList.remove('clean');
    });

    // Keyboard: space = play/pause, L/S/C orders, F = clean mode, Esc = exit.
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'l' || e.key === 'L') placeOrder('long');
      else if (e.key === 's' || e.key === 'S') placeOrder('short');
      else if (e.key === 'c' || e.key === 'C') closePartial(1);
      else if (e.key === 'f' || e.key === 'F') setClean(!document.body.classList.contains('clean'));
      else if (e.key === 'Escape') setClean(false);
    });
  }

  // Toggle chart-only recording mode (and real fullscreen when available).
  function setClean(on) {
    document.body.classList.toggle('clean', on);
    try {
      if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (!on && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    } catch (_) { /* fullscreen may be blocked; class toggle still applies */ }
  }

  // ----- Boot ------------------------------------------------------------
  bind();
  setPlayEnabled(false); // nothing to play until data is loaded
  setStatus('① 심볼·시간봉·날짜 선택 → ② Load → ③ Play');
})();
