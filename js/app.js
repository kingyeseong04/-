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
    timer: null,
    lastPrice: 0,
    symbolLabel: 'DEMO',
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
  function loadCandles(candles, label) {
    if (!candles || candles.length < 5) {
      setStatus('Not enough candles to replay.', 'err');
      return;
    }
    pause();
    state.candles = candles;
    state.symbolLabel = label || '';
    state.warmup = Math.min(state.warmup, Math.max(2, Math.floor(candles.length * 0.3)));
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
    $('symbol-label').textContent = label || 'data';
    $('candle-count').textContent = (candles.length - state.warmup) + ' candles to replay';
    updatePrice(state.lastPrice, 0);
    renderAccount();
    renderTrades();
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

  // Keep a tight window around the forming candle (logical index = state.idx)
  // so it stays large and the view tracks it. Price autoscale does the rest.
  function applyFocus() {
    const i = state.idx;
    chart.setVisibleLogicalRange(i - (state.zoomBars - 1), i + 1.2);
  }

  // ----- One tick step ---------------------------------------------------
  function step() {
    if (state.idx >= state.candles.length) { finishReplay(); return; }
    if (state.tickIdx === 0 && state.ticks.length === 0) prepareCandle();

    const price = state.ticks[state.tickIdx];
    const r = state.running;
    r.high = Math.max(r.high, price);
    r.low = Math.min(r.low, price);
    r.close = price;

    chart.updateCandle(r);
    if (state.focus) applyFocus();

    const prev = state.lastPrice;
    state.lastPrice = price;
    account.setMark(price);

    // Liquidation check on every tick.
    if (account.checkLiquidation(r.time)) {
      onPositionChanged();
      renderTrades();
      setStatus(account.liquidated ? '💥 Account liquidated — balance wiped.'
        : '💥 Position liquidated.', 'err');
    }

    updatePrice(price, price - prev);
    renderAccount();

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
      if (state.focus) applyFocus(); else chart.scrollToRealTime();
    }
  }

  function loop() {
    if (!state.playing) return;
    step();
    if (!state.playing) return;
    state.timer = setTimeout(loop, state.speedMs);
  }

  function play() {
    if (state.playing || state.candles.length === 0) return;
    if (state.idx >= state.candles.length) return;
    state.playing = true;
    $('btn-play').textContent = '⏸ Pause';
    setStatus('Replaying…', 'ok');
    loop();
  }

  function pause() {
    state.playing = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    $('btn-play').textContent = '▶ Play';
  }

  function togglePlay() { state.playing ? pause() : play(); }

  function finishReplay() {
    pause();
    setStatus('Replay finished. Reload data to run again.', 'ok');
  }

  // ----- Rendering -------------------------------------------------------
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
      if (state.focus) applyFocus();
      else chart.setVisibleLogicalRange(state.idx - 80, state.idx + 2);
    });
    $('zoom').addEventListener('input', (e) => {
      state.zoomBars = Number(e.target.value);
      $('zoom-label').textContent = state.zoomBars + ' bars';
      if (state.focus) applyFocus();
    });

    $('btn-long').addEventListener('click', () => placeOrder('long'));
    $('btn-short').addEventListener('click', () => placeOrder('short'));
    $('btn-close').addEventListener('click', () => closePartial(1));
    $('btn-close-half').addEventListener('click', () => closePartial(0.5));

    $('order-lev').addEventListener('input', (e) => {
      $('lev-label').textContent = e.target.value + '×';
    });

    // Data: Binance (the single fixed exchange — real market data)
    $('btn-binance').addEventListener('click', async () => {
      const sym = ($('inp-symbol').value.trim() || 'BTCUSDT').toUpperCase();
      const intv = $('inp-interval').value;
      const lim = parseInt($('inp-limit').value, 10) || 500;
      const startVal = $('inp-start').value; // datetime-local, local time
      let startTime;
      if (startVal) {
        const ms = new Date(startVal).getTime();
        if (!isNaN(ms)) startTime = ms;
      }
      const when = startVal ? (' from ' + startVal) : '';
      setStatus('Fetching ' + sym + ' ' + intv + when + ' on Binance…');
      try {
        const candles = await DataSource.fromBinance(sym, intv, lim, startTime);
        const label = 'Binance · ' + sym + ' · ' + intv +
          (startVal ? (' · ' + startVal.replace('T', ' ')) : '');
        loadCandles(candles, label);
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
        loadCandles(candles, file.name);
      } catch (err) {
        setStatus('CSV error: ' + err.message, 'err');
      }
      e.target.value = '';
    });

    // Data: Demo
    $('btn-demo').addEventListener('click', () => {
      const candles = DataSource.demo(600, 30000, 60);
      loadCandles(candles, 'DEMO · synthetic');
    });

    // Keyboard: space = play/pause, L/S/C orders.
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'l' || e.key === 'L') placeOrder('long');
      else if (e.key === 's' || e.key === 'S') placeOrder('short');
      else if (e.key === 'c' || e.key === 'C') closePartial(1);
    });
  }

  // ----- Boot ------------------------------------------------------------
  bind();
  // Start with offline demo data so the app is immediately usable.
  loadCandles(DataSource.demo(600, 30000, 60), 'DEMO · synthetic');
})();
