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
    tape: [],             // recent-trades feed (synthetic)
    subMap: null,         // Map candleTime -> real sub-candles (for real ticks)
    _loadMeta: null,
  };

  const chart = new ChartWrap($('chart'));
  const account = new Trading.Account(10000);
  let refreshSpeedLabel = null; // set in bind(); refreshes the 배속 label

  // ----- Status / toast --------------------------------------------------
  function setStatus(msg, kind) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status ' + (kind || '');
  }

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
    account.reset();

    // Show the warmup history; replay continues from there.
    chart.setHistory(candles.slice(0, state.warmup));
    chart.fitContent();
    chart.setEntryLine(null);
    chart.setLiqLine(null);

    state.lastPrice = candles[state.warmup - 1].close;
    lastRenderedPrice = state.lastPrice;
    state.sessHigh = state.sessLow = state.lastPrice;
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
    renderOverlays();
    updateStats();
    renderMarket(0, true);
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
      chart.scrollToRealTime();
    }
  }

  // ----- Per-frame render (once per rAF, regardless of ticks done) --------
  let lastRenderedPrice = 0;
  function renderFrame(ts) {
    // Only draw the forming candle once it's been prepared for the current
    // index (its time matches), else lightweight-charts rejects the stale time.
    const cur = state.candles[state.idx];
    if (cur && state.running.time === cur.time) chart.updateCandle(state.running);
    updatePrice(state.lastPrice, state.lastPrice - lastRenderedPrice);
    lastRenderedPrice = state.lastPrice;
    renderAccount();
    renderOverlays();
    updateStats();
    renderMarket(ts);
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
    acc += Math.min(ts - lastTs, 250); // clamp gaps (e.g. tab was backgrounded)
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

  function play() {
    if (state.playing || state.candles.length === 0) return;
    if (state.idx >= state.candles.length) return;
    state.playing = true;
    lastTs = 0; acc = 0;
    $('btn-play').textContent = '⏸ Pause';
    setStatus('Replaying…', 'ok');
    rafId = requestAnimationFrame(frame);
  }

  function pause() {
    state.playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    $('btn-play').textContent = '▶ Play';
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

  // TradingView-style top-left legend: symbol, interval, exchange + OHLC.
  function updateLegend() {
    const c = currentCandle();
    if (!c) return;
    const d = dec(c.close);
    const up = c.close >= c.open;
    const col = up ? 'var(--up)' : 'var(--down)';
    const chg = c.close - c.open;
    const chgPct = c.open ? (chg / c.open) * 100 : 0;
    const meta = [state.interval, state.exchange].filter(Boolean).join(' · ');
    $('legend').innerHTML =
      '<span class="sym">' + state.symbol + '</span>' +
      (meta ? '<span class="meta">' + meta + '</span>' : '') +
      '<span class="ohlc" style="color:' + col + '">' +
      '<span class="lbl">O</span><b>' + fmt(c.open, d) + '</b>' +
      '<span class="lbl">H</span><b>' + fmt(c.high, d) + '</b>' +
      '<span class="lbl">L</span><b>' + fmt(c.low, d) + '</b>' +
      '<span class="lbl">C</span><b>' + fmt(c.close, d) + '</b>' +
      '<b>' + sign(chg) + fmt(chg, d) + ' (' + sign(chgPct) + fmt(chgPct, 2) + '%)</b>' +
      '</span>';
  }

  function fmtDur(s) {
    s = Math.max(0, s | 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
  }

  // Candle-close countdown sitting on the price axis, just below the last
  // price label — like the live countdown on TradingView.
  function updateCountdown() {
    const el = $('countdown');
    if (state.idx >= state.candles.length || state.lastPrice <= 0) {
      el.style.display = 'none'; return;
    }
    const y = chart.priceToY(state.lastPrice);
    if (y == null) { el.style.display = 'none'; return; }
    const i = state.idx;
    let dur = 60;
    if (state.candles[i + 1]) dur = state.candles[i + 1].time - state.candles[i].time;
    else if (state.candles[i - 1]) dur = state.candles[i].time - state.candles[i - 1].time;
    const frac = state.ticks.length ? (state.tickIdx / state.ticks.length) : 0;
    el.textContent = fmtDur(dur * (1 - frac));
    const c = currentCandle();
    el.style.background = (c && c.close >= c.open) ? 'var(--up)' : 'var(--down)';
    el.style.width = chart.priceScaleWidth() + 'px';
    el.style.top = (y + 9) + 'px';
    el.style.display = 'block';
  }

  function renderOverlays() { updateLegend(); updateCountdown(); }

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

  // Top market-stats bar (mark / 24h high-low / funding countdown).
  function updateStats() {
    const d = dec(state.lastPrice);
    $('stat-mark').textContent = fmt(state.lastPrice, d);
    $('stat-high').textContent = fmt(state.sessHigh, d);
    $('stat-low').textContent = fmt(state.sessLow, d);
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
    $('recent-trades').innerHTML = state.tape.map((t) =>
      '<div class="rt-row ' + t.side + '"><span class="p">' + fmt(t.p, d) + '</span>' +
      '<span class="q">' + fmt(t.size, 3) + '</span>' +
      '<span class="tm">' + hhmmss(t.tsec) + '</span></div>').join('');
  }

  function renderAccount() {
    $('balance').textContent = fmt(account.balance);
    $('equity').textContent = fmt(account.equity);
    $('available').textContent = fmt(account.available);

    const tbody = $('pos-rows');
    if (account.qty === 0) {
      tbody.innerHTML = '<tr id="pos-empty"><td colspan="8" class="empty">No open position</td></tr>';
      return;
    }
    const isLong = account.qty > 0;
    const d = dec(account.avgEntry);
    const pnl = account.unrealizedPnl;
    const cls = pnl >= 0 ? 'up' : 'down';
    tbody.innerHTML = '<tr>' +
      '<td>' + state.symbol + '</td>' +
      '<td class="' + (isLong ? 'side-long' : 'side-short') + '">' +
        (isLong ? 'Long' : 'Short') + ' ' + fmt(Math.abs(account.qty), 4) + '</td>' +
      '<td>' + fmt(account.notional) + '</td>' +
      '<td>' + fmt(account.avgEntry, d) + '</td>' +
      '<td>' + fmt(account.markPrice, d) + '</td>' +
      '<td>' + fmt(account.liquidationPrice, d) + '</td>' +
      '<td class="' + cls + '">' + sign(pnl) + fmt(pnl) +
        ' (' + sign(account.unrealizedPnlPct) + fmt(account.unrealizedPnlPct, 2) + '%)</td>' +
      '<td><button class="row-close" id="row-close-btn">Close</button></td>' +
      '</tr>';
    const btn = $('row-close-btn');
    if (btn) btn.addEventListener('click', () => closePartial(1));
  }

  function onPositionChanged() {
    if (account.qty === 0) {
      chart.setEntryLine(null);
      chart.setLiqLine(null);
    } else {
      chart.setEntryLine(account.avgEntry, account.qty > 0 ? 'long' : 'short');
      chart.setLiqLine(account.liquidationPrice);
    }
    renderAccount();
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

    // Speed = real-time multiplier (배속). Slider 0..100 maps exponentially to
    // 1x .. 3600x so both real-time and heavy fast-forward are reachable.
    // The label shows how long ONE candle of the current interval takes.
    const MAXX = 3600;
    const sliderToX = (v) => Math.max(1, Math.round(Math.exp(Math.log(MAXX) * (v / 100))));
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
    $('speed').addEventListener('input', (e) => {
      state.speedX = sliderToX(Number(e.target.value));
      updateSpeedLabel();
    });
    $('inp-interval').addEventListener('change', updateSpeedLabel);
    updateSpeedLabel();
    // Keep the reference so the label can refresh after data loads.
    refreshSpeedLabel = updateSpeedLabel;
    $('tpc').addEventListener('input', (e) => {
      state.ticksPerCandle = Number(e.target.value);
      $('tpc-label').textContent = state.ticksPerCandle + ' ticks/candle';
    });

    $('btn-long').addEventListener('click', () => placeOrder('long'));
    $('btn-short').addEventListener('click', () => placeOrder('short'));
    $('btn-close').addEventListener('click', () => closePartial(1));
    $('btn-close-half').addEventListener('click', () => closePartial(0.5));

    $('order-lev').addEventListener('input', (e) => {
      $('lev-label').textContent = e.target.value + 'x';
      $('lev-chip').textContent = e.target.value + 'x';
    });

    // Data: Bybit perpetual around a chosen date (+ real intra-candle ticks).
    const SIDE = 30; // candles fetched on each side of the chosen date
    $('btn-binance').addEventListener('click', async () => {
      const sym = ($('inp-symbol').value.trim() || 'BTCUSDT').toUpperCase();
      const intv = $('inp-interval').value;
      const exch = 'Bybit'; // Bybit only (Binance kept as silent fallback)
      const startVal = $('inp-start').value; // datetime-local, local time
      if (!startVal) { setStatus('날짜·시각을 먼저 선택하세요.', 'err'); return; }
      try {
        const center = new Date(startVal).getTime();
        if (isNaN(center)) { setStatus('Invalid date.', 'err'); return; }
        const ms = DataSource.intervalToMs(intv);
        setStatus('Fetching ' + sym + ' ' + intv + ' around ' + startVal.replace('T', ' ') + '…');
        const res = await DataSource.fetchCandles(
          sym, intv, SIDE * 2 + 5, center - SIDE * ms, center + SIDE * ms, exch);
        let warmup = 0;
        for (let i = 0; i < res.candles.length; i++) {
          if (res.candles[i].time * 1000 <= center) warmup = i; else break;
        }

        const source = res.source; // exchange that actually served the data
        setStatus('Loading real intra-candle data…');
        const subMap = await fetchSubMap(sym, intv, res.candles, warmup, source);

        const meta = { symbol: sym, interval: intv, exchange: source, subMap, warmup };
        const label = source + ' · ' + sym + ' · ' + intv;
        loadCandles(res.candles, label, meta);

        const bits = [source + ' ' + res.candles.length + ' candles'];
        if (res.fallback) bits.push('(⚠ ' + exch + ' unavailable → ' + source + ')');
        bits.push(subMap ? 'real ticks ✓' : 'synthetic ticks');
        setStatus(bits.join(' · ') + '. Press Play ▶', res.fallback ? 'err' : 'ok');
      } catch (err) {
        setStatus('불러오기 실패 (' + err.message + '). 네트워크·심볼·날짜를 확인하세요.', 'err');
      }
    });

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
  setStatus('심볼·시간봉·날짜를 정하고 Load ▶ 를 누르세요.');
})();
