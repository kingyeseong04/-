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
    speedMs: 60,          // delay between ticks
    ticksPerCandle: 40,
    focus: false,         // motion-tracking zoom on the forming candle
    zoomBars: 7,          // how many bars stay visible when focused
    lastPrice: 0,
    symbolLabel: 'DEMO',
    symbol: 'DEMO',
    interval: '',
    exchange: '',
  };

  const chart = new ChartWrap($('chart'));
  const account = new Trading.Account(10000);

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
    cam.init = false; // re-aim the focus camera for the new dataset
    if (state.focus) stepCamera(true); else chart.fitContent();
    chart.setEntryLine(null);
    chart.setLiqLine(null);

    state.lastPrice = candles[state.warmup - 1].close;
    lastRenderedPrice = state.lastPrice;
    $('symbol-label').textContent = label || 'data';
    $('candle-count').textContent = (candles.length - state.warmup) + ' candles to replay';
    updatePrice(state.lastPrice, 0);
    renderAccount();
    renderTrades();
    renderOverlays();
    setStatus('Loaded ' + candles.length + ' candles. Press Play ▶', 'ok');
  }

  // ----- Prepare ticks for the candle at state.idx -----------------------
  function prepareCandle() {
    const c = state.candles[state.idx];
    state.ticks = TickEngine.generateTicks(
      c.open, c.high, c.low, c.close, state.ticksPerCandle
    );
    state.tickIdx = 0;
    state.running = {
      time: c.time, open: c.open, high: c.open, low: c.open, close: c.open,
    };
  }

  // ----- Camera (smooth focus / motion-tracking) -------------------------
  // The camera eases toward a target window every frame instead of snapping,
  // so panning (when a candle finalizes) and the price-axis zoom glide.
  const cam = { from: 0, to: 0, pmin: 0, pmax: 0, init: false };
  const lerp = (a, b, t) => a + (b - a) * t;

  // The chart's logical bar index equals the candle array index, because we
  // seed history with candles[0..warmup-1] then update() candles[warmup..].
  // So the forming candle sits at logical index === state.idx.
  function focusTarget() {
    const i = state.idx;
    const from = i - (state.zoomBars - 1);
    const to = i + 1.2; // a little breathing room on the right
    let lo = Infinity, hi = -Infinity;
    const start = Math.max(0, Math.floor(from));
    const end = Math.min(i, state.candles.length - 1);
    for (let j = start; j <= end; j++) {
      const formingHere = j === state.idx &&
        state.candles[j] && state.running.time === state.candles[j].time;
      const c = formingHere ? state.running : state.candles[j];
      if (!c) continue;
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (!isFinite(lo)) { lo = hi = state.lastPrice || 0; }
    const pad = (hi - lo) * 0.12 || (hi * 0.001) || 1;
    return { from, to, pmin: lo - pad, pmax: hi + pad };
  }

  // Provider consulted by lightweight-charts during autoscale (each redraw):
  // when focused we return the eased price range so the vertical zoom is smooth.
  chart.setPriceRangeProvider(() =>
    (state.focus && cam.init) ? { min: cam.pmin, max: cam.pmax } : null);

  function stepCamera(immediate) {
    const t = focusTarget();
    if (immediate || !cam.init) {
      cam.from = t.from; cam.to = t.to; cam.pmin = t.pmin; cam.pmax = t.pmax;
      cam.init = true;
    } else {
      const k = 0.22; // easing factor
      cam.from = lerp(cam.from, t.from, k);
      cam.to = lerp(cam.to, t.to, k);
      cam.pmin = lerp(cam.pmin, t.pmin, k);
      cam.pmax = lerp(cam.pmax, t.pmax, k);
    }
    chart.setVisibleLogicalRange(cam.from, cam.to);
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
      if (!state.focus) chart.scrollToRealTime();
    }
  }

  // ----- Per-frame render (once per rAF, regardless of ticks done) --------
  let lastRenderedPrice = 0;
  function renderFrame() {
    if (state.focus) stepCamera(false);
    if (state.idx < state.candles.length) chart.updateCandle(state.running);
    updatePrice(state.lastPrice, state.lastPrice - lastRenderedPrice);
    lastRenderedPrice = state.lastPrice;
    renderAccount();
    renderOverlays();
  }

  // ----- rAF playback loop (decoupled from tick rate) --------------------
  let rafId = null, lastTs = 0, acc = 0;
  function frame(ts) {
    if (!state.playing) { rafId = null; return; }
    if (lastTs === 0) lastTs = ts;
    acc += Math.min(ts - lastTs, 250); // clamp gaps (e.g. tab was backgrounded)
    lastTs = ts;
    let steps = 0;
    while (acc >= state.speedMs && steps < 200) {
      stepTick();
      acc -= state.speedMs;
      steps++;
      if (!state.playing) break;
    }
    renderFrame();
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
    el.textContent = fmt(price, price < 10 ? 5 : 2);
    el.classList.remove('up', 'down');
    if (delta > 0) el.classList.add('up');
    else if (delta < 0) el.classList.add('down');

    const first = state.candles[state.warmup] ? state.candles[state.warmup].open : price;
    const chg = first ? ((price - first) / first) * 100 : 0;
    const chgEl = $('price-change');
    chgEl.textContent = sign(chg) + fmt(chg, 2) + '%';
    chgEl.className = 'price-change ' + (chg >= 0 ? 'up' : 'down');
  }

  function renderAccount() {
    $('balance').textContent = fmt(account.balance);
    $('equity').textContent = fmt(account.equity);
    $('available').textContent = fmt(account.available);

    const pnl = account.unrealizedPnl;
    const pnlEl = $('upnl');
    pnlEl.textContent = sign(pnl) + fmt(pnl) + '  (' + sign(account.unrealizedPnlPct) + fmt(account.unrealizedPnlPct) + '%)';
    pnlEl.className = 'val ' + (pnl > 0 ? 'up' : pnl < 0 ? 'down' : '');

    const pos = $('position-box');
    if (account.qty === 0) {
      pos.classList.add('flat');
      $('pos-side').textContent = 'FLAT';
      $('pos-side').className = 'pos-side flat';
      $('pos-size').textContent = '-';
      $('pos-entry').textContent = '-';
      $('pos-mark').textContent = fmt(account.markPrice, account.markPrice < 10 ? 5 : 2);
      $('pos-liq').textContent = '-';
      $('pos-lev').textContent = '-';
    } else {
      pos.classList.remove('flat');
      const isLong = account.qty > 0;
      $('pos-side').textContent = isLong ? 'LONG' : 'SHORT';
      $('pos-side').className = 'pos-side ' + (isLong ? 'up' : 'down');
      $('pos-size').textContent = fmt(Math.abs(account.qty), 4) + '  (' + fmt(account.notional) + ' USDT)';
      $('pos-entry').textContent = fmt(account.avgEntry, account.avgEntry < 10 ? 5 : 2);
      $('pos-mark').textContent = fmt(account.markPrice, account.markPrice < 10 ? 5 : 2);
      $('pos-liq').textContent = fmt(account.liquidationPrice, account.avgEntry < 10 ? 5 : 2);
      $('pos-lev').textContent = fmt(account.leverage, 0) + '×';
    }
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
      if (state.candles.length) loadCandles(state.candles, state.symbolLabel);
    });

    $('speed').addEventListener('input', (e) => {
      // Slider 1..100 -> faster on the right. Map to ms (5..200).
      const v = Number(e.target.value);
      state.speedMs = Math.round(205 - v * 2);
      $('speed-label').textContent = state.speedMs + ' ms/tick';
    });
    $('tpc').addEventListener('input', (e) => {
      state.ticksPerCandle = Number(e.target.value);
      $('tpc-label').textContent = state.ticksPerCandle + ' ticks/candle';
    });

    // Focus / motion-tracking zoom on the forming candle.
    $('btn-focus').addEventListener('click', () => {
      state.focus = !state.focus;
      const btn = $('btn-focus');
      btn.textContent = state.focus ? '🎯 Focus: On' : '🎯 Focus: Off';
      btn.classList.toggle('active', state.focus);
      if (state.focus) {
        stepCamera(true); // snap to the candle, then ease from there
      } else {
        cam.init = false;
        chart.setVisibleLogicalRange(state.idx - 80, state.idx + 2);
      }
    });
    $('zoom').addEventListener('input', (e) => {
      state.zoomBars = Number(e.target.value);
      $('zoom-label').textContent = state.zoomBars + ' bars';
      if (state.focus) stepCamera(!state.playing); // snap when paused, ease when live
    });

    $('btn-long').addEventListener('click', () => placeOrder('long'));
    $('btn-short').addEventListener('click', () => placeOrder('short'));
    $('btn-close').addEventListener('click', () => closePartial(1));
    $('btn-close-half').addEventListener('click', () => closePartial(0.5));

    $('order-lev').addEventListener('input', (e) => {
      $('lev-label').textContent = e.target.value + '×';
    });

    // Data: Binance (the single fixed exchange — real market data)
    const SIDE = 30; // candles fetched on each side of a chosen date
    $('btn-binance').addEventListener('click', async () => {
      const sym = ($('inp-symbol').value.trim() || 'BTCUSDT').toUpperCase();
      const intv = $('inp-interval').value;
      const lim = parseInt($('inp-limit').value, 10) || 500;
      const startVal = $('inp-start').value; // datetime-local, local time
      const meta = { symbol: sym, interval: intv, exchange: 'Binance' };
      const label = 'Binance · ' + sym + ' · ' + intv;
      try {
        if (startVal) {
          // Centered window: ~30 candles before (context) + ~30 after (replay),
          // regardless of interval. Replay starts at the chosen candle.
          const center = new Date(startVal).getTime();
          if (isNaN(center)) { setStatus('Invalid date.', 'err'); return; }
          const ms = DataSource.intervalToMs(intv);
          setStatus('Fetching ' + sym + ' ' + intv + ' around ' + startVal.replace('T', ' ') + '…');
          const candles = await DataSource.fromBinance(
            sym, intv, SIDE * 2 + 5, center - SIDE * ms, center + SIDE * ms);
          // The chosen candle = last one starting at/before the picked time.
          let chosen = 0;
          for (let i = 0; i < candles.length; i++) {
            if (candles[i].time * 1000 <= center) chosen = i; else break;
          }
          meta.warmup = chosen;
          loadCandles(candles, label, meta);
          setStatus('Loaded ' + candles.length + ' candles centered on ' +
            startVal.replace('T', ' ') + '. Press Play ▶', 'ok');
        } else {
          setStatus('Fetching latest ' + lim + ' ' + sym + ' ' + intv + ' on Binance…');
          const candles = await DataSource.fromBinance(sym, intv, lim);
          loadCandles(candles, label, meta);
        }
      } catch (err) {
        setStatus('Binance failed (' + err.message + '). Try Demo or CSV.', 'err');
      }
    });

    // Data: CSV
    $('inp-csv').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      setStatus('Parsing ' + file.name + '…');
      try {
        const candles = await DataSource.fromCSVFile(file);
        const sym = file.name.replace(/\.csv$/i, '');
        loadCandles(candles, file.name, { symbol: sym, interval: '', exchange: 'CSV' });
      } catch (err) {
        setStatus('CSV error: ' + err.message, 'err');
      }
      e.target.value = '';
    });

    // Data: Demo
    $('btn-demo').addEventListener('click', () => {
      const candles = DataSource.demo(600, 30000, 60);
      loadCandles(candles, 'DEMO · synthetic', { symbol: 'DEMOUSDT', interval: '1m', exchange: 'Demo' });
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
  // Start with offline demo data so the app is immediately usable.
  loadCandles(DataSource.demo(600, 30000, 60), 'DEMO · synthetic',
    { symbol: 'DEMOUSDT', interval: '1m', exchange: 'Demo' });
})();
