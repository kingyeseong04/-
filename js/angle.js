// angle.js — 빗각(피보나치 채널) 저장 + 터치 알림.
//
// 인범TV식 "빗각" 매매의 도구화: 캔들 위에 3점으로 피보나치 채널을 그으면
// 0 / 0.5 / 1(1:1) / 1.5(1:1.5) / 2(1:2) … 평행 빗각이 뻗어 나가고, 그 선을
// 종목별로 저장해 두었다가 주가가 선에 닿으면 알려 준다.
//
// 기하 정의 (트레이딩뷰 "피보나치 채널"과 동일)
//   1·2번 점  → 기준 추세선(레벨 0)
//   3번 점    → 채널 폭. d = p3 - base(x3)
//   레벨 L 선 = base(x) + L * d      (base는 x에 대한 1차 함수)
// x축은 시간이 아니라 **봉 인덱스**를 쓴다. 트레이딩뷰가 그렇게 그리기 때문에
// 장중 공백(주식)이 있는 차트에서도 선이 어긋나지 않는다. 24시간 도는 무기한
// 선물이면 봉 인덱스와 시간은 같은 값이라 결과가 동일하다.
//
// 저장은 브라우저 localStorage. 즉 알림은 이 페이지가 열려 있는 동안만 온다
// (잠긴 폰까지 가는 푸시는 각 빗각의 Pine 스크립트를 트레이딩뷰에 걸면 된다).
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- storage
  const LS = { setups: 'angle.setups.v1', prefs: 'angle.prefs.v1', log: 'angle.log.v1' };
  const DEF_PREFS = {
    poll: 20, levels: '0, 0.5, 1, 1.5, 2, 2.5, 3', tol: 0.1,
    near: false, nearPct: 0.5, sound: true, notify: true, wake: false,
  };

  function readJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  }
  function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* quota / private mode */ }
  }

  let setups = readJSON(LS.setups, []);
  let prefs = Object.assign({}, DEF_PREFS, readJSON(LS.prefs, {}));
  let log = readJSON(LS.log, []);

  const saveSetups = () => writeJSON(LS.setups, setups);
  const savePrefs = () => writeJSON(LS.prefs, prefs);
  const saveLog = () => writeJSON(LS.log, log.slice(0, 200));
  const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ------------------------------------------------------------- geometry
  // Candle arrays are ascending by time. Bar index is fractional so anchors
  // between/outside candles still map to an exact x.
  function medianStep(candles) {
    const n = candles.length;
    if (n < 2) return 3600;
    // The median gap is robust against a single missing candle.
    const gaps = [];
    for (let i = 1; i < n; i++) gaps.push(candles[i].time - candles[i - 1].time);
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1] || 3600;
  }
  function indexAt(candles, t) {
    const n = candles.length;
    if (!n) return 0;
    const step = medianStep(candles);
    if (t <= candles[0].time) return (t - candles[0].time) / step;
    if (t >= candles[n - 1].time) return (n - 1) + (t - candles[n - 1].time) / step;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (candles[m].time <= t) lo = m; else hi = m; }
    const span = (candles[hi].time - candles[lo].time) || step;
    return lo + (t - candles[lo].time) / span;
  }
  function timeAt(candles, x) {
    const n = candles.length;
    if (!n) return 0;
    const step = medianStep(candles);
    if (x <= 0) return Math.round(candles[0].time + x * step);
    if (x >= n - 1) return Math.round(candles[n - 1].time + (x - (n - 1)) * step);
    const i = Math.floor(x), f = x - i;
    return Math.round(candles[i].time + f * (candles[i + 1].time - candles[i].time));
  }

  // Build the level functions of one setup against a candle array.
  function lineFns(s, candles) {
    const x1 = indexAt(candles, s.p1.time);
    const x2 = indexAt(candles, s.p2.time);
    const x3 = indexAt(candles, s.p3.time);
    const dx = (x2 - x1) || 1e-9;
    const base = (x) => s.p1.price + (s.p2.price - s.p1.price) * ((x - x1) / dx);
    const d = s.p3.price - base(x3);
    return { x1, x2, x3, base, d, at: (L, x) => base(x) + L * d };
  }

  function parseLevels(str) {
    const out = [];
    String(str || '').split(/[,\s]+/).forEach((tok) => {
      if (!tok) return;
      const v = parseFloat(tok);
      if (isFinite(v) && out.indexOf(v) < 0) out.push(v);
    });
    out.sort((a, b) => a - b);
    return out.length ? out : [0, 1];
  }
  const levelColor = (L) => (Math.abs(L - Math.round(L)) < 1e-9 ? '#2962ff' : '#e3b505');

  // ---------------------------------------------------------------- format
  function fmtPrice(n) {
    if (!isFinite(n)) return '-';
    const a = Math.abs(n), d = a >= 1000 ? 1 : a >= 1 ? 2 : a >= 0.1 ? 4 : 6;
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const p2 = (n) => String(n).padStart(2, '0');
  function fmtTime(sec) {
    const d = new Date(sec * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function fmtClock(ms) {
    const d = new Date(ms);
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  // 'YYYY-MM-DDTHH:mm' in LOCAL time, for <input type=datetime-local>.
  function toLocalInput(sec) {
    const d = new Date(sec * 1000);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
      'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000);

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ chart view
  const view = { symbol: 'DRAMUSDT.P', interval: '4h', candles: [], source: '' };
  let chart = null;            // ChartWrap
  let ov = null, ctx = null;   // overlay canvas
  let cw = 0, chh = 0;
  let tool = null;             // null | 'fib' | 'edit'
  let magnet = true;
  let draft = null;            // {pts:[{x,price}], hover:{x,price}} while drawing
  let selId = null;            // selected setup (handles shown, list highlighted)
  let dragHandle = null;       // {id, i} while dragging an anchor in edit mode

  const SNAP_PX = 18, HANDLE_PX = 22;

  function initChart() {
    chart = new global.ChartWrap($('chart'));
    // Leave room on the right: the whole point of a 빗각 is where it goes NEXT.
    chart.chart.applyOptions({ timeScale: { rightOffset: 26, barSpacing: 7 } });

    ov = $('ov');
    ctx = ov.getContext('2d');
    ov.addEventListener('pointerdown', onDown);
    ov.addEventListener('pointermove', onMove);
    ov.addEventListener('pointerup', onUp);
    ov.addEventListener('pointercancel', onUp);

    chart.subscribeRange(redraw);
    chart.subscribeCrosshair(redraw);
    global.addEventListener('resize', () => { resizeOverlay(); redraw(); });
    resizeOverlay();
    // The price scale can rescale without a range event (new data, autoscale),
    // so keep a cheap safety-net repaint.
    setInterval(redraw, 400);
  }

  function resizeOverlay() {
    const r = $('chart-wrap').getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = global.devicePixelRatio || 1;
    cw = r.width; chh = r.height;
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
    ov.width = Math.max(1, Math.round(r.width * dpr));
    ov.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Setups drawn on the current chart = same symbol + timeframe, not hidden.
  function onChartSetups() {
    return setups.filter((s) => s.symbol === view.symbol && s.interval === view.interval && s.show !== false);
  }

  // ------------------------------------------------------------- rendering
  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, chh);
    if (!view.candles.length) return;

    for (const s of onChartSetups()) drawSetup(s, s.id === selId);
    if (draft) drawDraft();
  }

  function drawSetup(s, selected) {
    const f = lineFns(s, view.candles);
    if (!isFinite(f.d)) return;
    const lx = chart.xToLogical(0), rx = chart.xToLogical(cw);
    if (lx == null || rx == null) return;

    for (const L of s.levels) {
      const ya = chart.priceToY(f.at(L, lx));
      const yb = chart.priceToY(f.at(L, rx));
      if (ya == null || yb == null) continue;
      ctx.save();
      ctx.strokeStyle = levelColor(L);
      ctx.lineWidth = (Math.abs(L) < 1e-9 || Math.abs(L - 1) < 1e-9) ? 2 : 1.4;
      ctx.globalAlpha = s.enabled === false ? 0.35 : 1;
      ctx.beginPath(); ctx.moveTo(0, ya); ctx.lineTo(cw, yb); ctx.stroke();

      // TradingView-style label: "1.5 (65.85)" at ~70% across the pane.
      const lab = cw * 0.68;
      const price = f.at(L, chart.xToLogical(lab));
      const y = chart.priceToY(price);
      if (y != null && y > 8 && y < chh - 8) {
        ctx.globalAlpha = s.enabled === false ? 0.45 : 1;
        ctx.font = "600 11.5px -apple-system, 'Segoe UI', Roboto, sans-serif";
        const txt = L + ' (' + fmtPrice(price) + ')';
        const w = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(16,16,20,.72)';
        ctx.fillRect(lab - 3, y - 15, w + 6, 14);
        ctx.fillStyle = levelColor(L);
        ctx.fillText(txt, lab, y - 4);
      }
      ctx.restore();
    }

    if (selected) {
      const anchors = [
        { x: f.x1, price: s.p1.price }, { x: f.x2, price: s.p2.price }, { x: f.x3, price: s.p3.price },
      ];
      anchors.forEach((a, i) => {
        const px = chart.logicalToX(a.x), py = chart.priceToY(a.price);
        if (px == null || py == null) return;
        ctx.save();
        ctx.fillStyle = '#101014'; ctx.strokeStyle = '#f7a600'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#f7a600';
        ctx.font = "700 10px -apple-system, 'Segoe UI', Roboto, sans-serif";
        ctx.fillText(String(i + 1), px + 8, py - 6);
        ctx.restore();
      });
    }
  }

  function drawDraft() {
    const pts = draft.pts.concat(draft.hover ? [draft.hover] : []);
    ctx.save();
    ctx.strokeStyle = '#f7a600'; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]);
    if (pts.length >= 2) {
      const a = px(pts[0]), b = px(pts[1]);
      if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    // With two points down, preview the whole channel the third point defines.
    if (pts.length >= 3) {
      const s = draftSetup(pts);
      ctx.setLineDash([]);
      ctx.restore();
      drawSetup(s, false);
      ctx.save();
    }
    ctx.setLineDash([]);
    for (const p of draft.pts) {
      const q = px(p);
      if (!q) continue;
      ctx.fillStyle = '#101014'; ctx.strokeStyle = '#f7a600'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q.x, q.y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  function px(p) {
    const x = chart.logicalToX(p.x), y = chart.priceToY(p.price);
    return (x == null || y == null) ? null : { x, y };
  }
  // A throwaway setup object so the live preview reuses drawSetup().
  function draftSetup(pts) {
    const c = view.candles;
    return {
      id: '_draft', symbol: view.symbol, interval: view.interval,
      p1: { time: timeAt(c, pts[0].x), price: pts[0].price },
      p2: { time: timeAt(c, pts[1].x), price: pts[1].price },
      p3: { time: timeAt(c, pts[2].x), price: pts[2].price },
      levels: parseLevels(prefs.levels), enabled: true,
    };
  }

  // ----------------------------------------------------------- interaction
  function localXY(e) {
    const r = ov.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  // Pixel → {x: bar index, price}, snapping to a nearby candle's O/H/L/C.
  function toPoint(sx, sy) {
    const x = chart.xToLogical(sx), price = chart.yToPrice(sy);
    if (x == null || price == null) return null;
    if (magnet) {
      const c = view.candles, i = Math.round(x);
      if (c && i >= 0 && i < c.length) {
        const cd = c[i];
        let best = cd.close, bd = Infinity;
        for (const v of [cd.open, cd.high, cd.low, cd.close]) {
          const d = Math.abs(v - price); if (d < bd) { bd = d; best = v; }
        }
        const bx = chart.logicalToX(i), by = chart.priceToY(best);
        if (bx != null && by != null && Math.hypot(bx - sx, by - sy) <= SNAP_PX) return { x: i, price: best };
      }
    }
    return { x, price };
  }

  function handleNear(sx, sy) {
    const s = setups.find((v) => v.id === selId);
    if (!s || s.symbol !== view.symbol || s.interval !== view.interval) return null;
    const f = lineFns(s, view.candles);
    const anchors = [
      { x: f.x1, price: s.p1.price }, { x: f.x2, price: s.p2.price }, { x: f.x3, price: s.p3.price },
    ];
    for (let i = 0; i < 3; i++) {
      const q = px(anchors[i]);
      if (q && Math.hypot(q.x - sx, q.y - sy) <= HANDLE_PX) return { id: s.id, i };
    }
    return null;
  }

  function onDown(e) {
    if (!tool) return;
    const { x, y } = localXY(e);
    if (tool === 'edit') {
      dragHandle = handleNear(x, y);
      if (dragHandle) { e.preventDefault(); try { ov.setPointerCapture(e.pointerId); } catch (_) {} }
      return;
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (!tool) return;
    const { x, y } = localXY(e);
    if (tool === 'edit' && dragHandle) {
      const p = toPoint(x, y);
      if (!p) return;
      const s = setups.find((v) => v.id === dragHandle.id);
      if (!s) return;
      const key = ['p1', 'p2', 'p3'][dragHandle.i];
      s[key] = { time: timeAt(view.candles, p.x), price: p.price };
      redraw();
      return;
    }
    if (tool === 'fib' && draft) {
      const p = toPoint(x, y);
      if (p) { draft.hover = p; redraw(); }
    }
  }

  function onUp(e) {
    if (!tool) return;
    const { x, y } = localXY(e);
    if (tool === 'edit') {
      if (dragHandle) { dragHandle = null; saveSetups(); renderList(); }
      return;
    }
    // 'fib': each tap drops one of the three points.
    const p = toPoint(x, y);
    if (!p) return;
    if (!draft) draft = { pts: [], hover: null };
    draft.pts.push(p);
    draft.hover = p;
    if (draft.pts.length >= 3) commitDraft();
    else setHint(draft.pts.length === 1 ? '② 추세선의 끝점을 탭하세요 (여기까지가 0선)' : '③ 채널 폭 = 1:1 선이 지날 점을 탭하세요');
    redraw();
  }

  function commitDraft() {
    const c = view.candles;
    const pts = draft.pts;
    const s = {
      id: uid(),
      symbol: view.symbol, interval: view.interval,
      name: view.symbol.replace(/USDT\.P$/, '') + ' ' + view.interval + ' 빗각',
      p1: { time: timeAt(c, pts[0].x), price: pts[0].price },
      p2: { time: timeAt(c, pts[1].x), price: pts[1].price },
      p3: { time: timeAt(c, pts[2].x), price: pts[2].price },
      levels: parseLevels(prefs.levels),
      tol: prefs.tol, bias: 'auto', enabled: true, show: true,
      created: Date.now(), fired: [],
    };
    setups.unshift(s);
    saveSetups();
    selId = s.id;
    draft = null;
    setTool(null);
    setHint('저장됨 — 이 빗각에 닿으면 알려 줍니다', 1800);
    renderList();
    redraw();
  }

  let hintTimer = null;
  function setHint(txt, ms) {
    const el = $('hint');
    clearTimeout(hintTimer);
    if (!txt) { el.hidden = true; return; }
    el.textContent = txt; el.hidden = false;
    if (ms) hintTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function setTool(t) {
    tool = (tool === t) ? null : t;
    if (tool !== 'fib') draft = null;
    ov.style.pointerEvents = tool ? 'auto' : 'none';
    ov.style.cursor = tool ? 'crosshair' : 'default';
    $('t-fib').classList.toggle('on', tool === 'fib');
    $('t-edit').classList.toggle('on', tool === 'edit');
    if (tool === 'fib') setHint('① 추세선의 시작점을 탭하세요');
    else if (tool === 'edit') setHint(selId ? '①②③ 점을 끌어서 수정하세요' : '먼저 아래 목록에서 빗각을 고르세요', 2600);
    else setHint(null);
    redraw();
  }

  // ------------------------------------------------------------ data / load
  function status(txt, cls) {
    const el = $('status');
    el.textContent = txt;
    el.className = cls || '';
  }
  function updateLegend() {
    const c = view.candles;
    const last = c.length ? c[c.length - 1] : null;
    $('legend').innerHTML = '<b>' + view.symbol + '</b> · ' + view.interval +
      (last ? ' · <span style="color:#eaecef">' + fmtPrice(last.close) + '</span>' : '') +
      (view.source ? ' · ' + view.source : '');
  }

  async function loadChart() {
    const symbol = ($('sym').value || '').trim().toUpperCase() || 'BTCUSDT.P';
    const interval = $('tf').value;
    const bars = Math.max(80, Math.min(1000, parseInt($('bars').value, 10) || 300));
    status('불러오는 중…');
    try {
      const r = await global.DataSource.fetchCandles(symbol, interval, bars);
      view.symbol = symbol; view.interval = interval;
      view.candles = r.candles; view.source = r.source;
      chart.setHistory(r.candles);
      chart.fitContent();
      seriesCache.set(symbol + '|' + interval, {
        candles: r.candles.slice(), fullAt: Date.now(), topAt: Date.now(), from: r.candles[0].time,
      });
      updateLegend();
      status(r.candles.length + '봉 · ' + r.source + (r.fallback ? ' (폴백)' : ''), 'ok');
      renderList();
      redraw();
    } catch (e) {
      status('불러오기 실패: ' + (e && e.message ? e.message : e), 'err');
    }
  }

  // Candle cache shared by the chart and the watcher. A full fetch reaches back
  // to the oldest anchor (so bar-index mapping is exact); later polls only top
  // up the last few candles.
  const seriesCache = new Map();
  async function getSeries(symbol, interval, needFrom) {
    const key = symbol + '|' + interval;
    const now = Date.now();
    const dur = global.DataSource.intervalToMs(interval);
    const c = seriesCache.get(key);
    if (c && c.from <= needFrom && now - c.fullAt < 6 * 3600e3) {
      if (now - c.topAt > 3000) {
        const r = await global.DataSource.fetchCandles(symbol, interval, 3);
        mergeCandles(c.candles, r.candles);
        c.topAt = now;
        if (symbol === view.symbol && interval === view.interval) {
          for (const k of r.candles) chart.updateCandle(k);
          view.candles = c.candles;
          updateLegend();
        }
      }
      return c.candles;
    }
    const need = Math.min(1000, Math.max(120, Math.ceil((now - needFrom * 1000) / dur) + 30));
    const r = await global.DataSource.fetchCandles(symbol, interval, need);
    seriesCache.set(key, { candles: r.candles.slice(), fullAt: now, topAt: now, from: r.candles[0].time });
    return seriesCache.get(key).candles;
  }
  function mergeCandles(arr, fresh) {
    for (const k of fresh) {
      const last = arr[arr.length - 1];
      if (!last || k.time > last.time) arr.push(k);
      else if (k.time === last.time) arr[arr.length - 1] = k;
      else {
        for (let i = arr.length - 2; i >= 0; i--) { if (arr[i].time === k.time) { arr[i] = k; break; } }
      }
    }
  }

  // ---------------------------------------------------------------- watcher
  let watchTimer = null, tickTimer = null, nextPollAt = 0, polling = false;

  function watching() { return !!watchTimer; }
  function startWatch() {
    if (watchTimer) return;
    unlockAudio();
    pollAll();
    watchTimer = setInterval(pollAll, Math.max(5, prefs.poll) * 1000);
    tickTimer = setInterval(updateWatchPill, 500);
    requestWakeLock();
    updateWatchPill();
  }
  function stopWatch() {
    clearInterval(watchTimer); clearInterval(tickTimer);
    watchTimer = tickTimer = null;
    releaseWakeLock();
    updateWatchPill();
  }
  function updateWatchPill() {
    const pill = $('watch-pill'), txt = $('watch-txt');
    pill.classList.toggle('on', watching());
    $('btn-watch').textContent = watching() ? '감시 중지' : '감시 시작';
    if (!watching()) { txt.textContent = '감시 꺼짐'; return; }
    const n = setups.filter((s) => s.enabled !== false).length;
    const left = Math.max(0, Math.round((nextPollAt - Date.now()) / 1000));
    txt.textContent = polling ? ('확인 중… · ' + n + '개') : (n + '개 감시 · ' + left + '초');
  }

  async function pollAll() {
    if (polling) return;
    const live = setups.filter((s) => s.enabled !== false);
    nextPollAt = Date.now() + Math.max(5, prefs.poll) * 1000;
    if (!live.length) { updateWatchPill(); return; }
    polling = true; updateWatchPill();
    // One fetch per symbol+timeframe, however many setups share it.
    const groups = new Map();
    for (const s of live) {
      const key = s.symbol + '|' + s.interval;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    for (const [key, arr] of groups) {
      const [symbol, interval] = key.split('|');
      const from = Math.min.apply(null, arr.map((s) => Math.min(s.p1.time, s.p2.time, s.p3.time)));
      try {
        const candles = await getSeries(symbol, interval, from);
        for (const s of arr) evaluate(s, candles);
      } catch (e) {
        status(symbol + ' 확인 실패: ' + (e && e.message ? e.message : e), 'err');
      }
    }
    polling = false;
    saveSetups();
    renderList();
    redraw();
    updateWatchPill();
  }

  function evaluate(s, candles) {
    if (!candles || !candles.length) return;
    const bar = candles[candles.length - 1];
    const f = lineFns(s, candles);
    if (!isFinite(f.d)) return;
    const x = indexAt(candles, bar.time);
    const tolPct = isFinite(s.tol) ? s.tol : prefs.tol;
    if (!s.fired) s.fired = [];
    let nearest = null;

    for (const L of s.levels) {
      const v = f.at(L, x);
      if (!isFinite(v) || v <= 0) continue;
      const tol = Math.abs(v) * tolPct / 100;
      const gapPct = Math.abs(bar.close - v) / v * 100;
      if (!nearest || gapPct < nearest.gapPct) nearest = { L, v, gapPct };

      const touched = bar.high >= v - tol && bar.low <= v + tol;
      if (touched) { fire(s, 'touch', L, v, bar); continue; }
      if (prefs.near && gapPct <= prefs.nearPct) fire(s, 'near', L, v, bar);
    }
    s.last = nearest ? { price: bar.close, L: nearest.L, v: nearest.v, gapPct: nearest.gapPct, at: Date.now() } : null;
  }

  function fire(s, kind, L, v, bar) {
    const key = kind + '|' + L + '|' + bar.time;
    if (s.fired.indexOf(key) >= 0) return;
    s.fired.push(key);
    if (s.fired.length > 60) s.fired = s.fired.slice(-60);

    const side = s.bias === 'long' ? ' · 롱' : s.bias === 'short' ? ' · 숏' : '';
    const title = (kind === 'touch' ? '빗각 터치! ' : '빗각 근접 ') + s.symbol + ' ' + s.interval;
    const body = L + ' 빗각 ' + fmtPrice(v) + ' · 현재 ' + fmtPrice(bar.close) + side;

    log.unshift({ ts: Date.now(), kind, sym: s.symbol, tf: s.interval, name: s.name, L, v, price: bar.close, bias: s.bias });
    log = log.slice(0, 200);
    saveLog();
    renderLog();
    notify(title, body, s.id + key);
    beep(kind === 'touch');
    if (kind === 'touch') status(title + ' — ' + body, 'ok');
  }

  // ------------------------------------------------- notification / sound
  async function notify(title, body, tag) {
    if (!prefs.notify) return;
    if (!('Notification' in global) || Notification.permission !== 'granted') return;
    try {
      const reg = global.navigator.serviceWorker && await global.navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) {
        reg.showNotification(title, { body, tag, renotify: true, requireInteraction: false });
        return;
      }
    } catch (_) { /* fall through to the plain constructor */ }
    try { new Notification(title, { body, tag }); } catch (_) { /* unsupported (some mobile browsers) */ }
  }

  let audio = null;
  function unlockAudio() {
    try {
      if (!audio) audio = new (global.AudioContext || global.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (_) { audio = null; }
  }
  function beep(strong) {
    if (!prefs.sound || !audio) return;
    try {
      const t0 = audio.currentTime;
      const notes = strong ? [880, 1320, 1760] : [660];
      notes.forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = t0 + i * 0.16;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        o.connect(g); g.connect(audio.destination);
        o.start(t); o.stop(t + 0.16);
      });
    } catch (_) { /* audio blocked */ }
  }

  let wakeLock = null;
  async function requestWakeLock() {
    if (!prefs.wake || !global.navigator.wakeLock) return;
    try { wakeLock = await global.navigator.wakeLock.request('screen'); } catch (_) { wakeLock = null; }
  }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (_) {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && watching()) { requestWakeLock(); pollAll(); }
  });

  // ------------------------------------------------------------------- UI
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function renderList() {
    const el = $('tab-list');
    // Don't yank the field the user is typing in (the watcher re-renders often).
    if (el.contains(document.activeElement) && document.activeElement !== document.body) return;

    let html = '<div class="set-row" style="border:none;padding:0 0 8px">' +
      '<button class="btn sm" data-act="new-draw">＋ 차트에 그리기</button>' +
      '<button class="btn sm" data-act="new-coords">＋ 좌표로 추가</button>' +
      '<label class="sw"><input type="checkbox" id="only-cur"' + (prefs.onlyCur ? ' checked' : '') + '> 이 차트만</label>' +
      '</div>';

    let list = setups.slice();
    if (prefs.onlyCur) list = list.filter((s) => s.symbol === view.symbol && s.interval === view.interval);

    if (!list.length) {
      html += '<div class="empty">저장된 빗각이 없습니다.<br>' +
        '오른쪽 위 <b>빗각</b> 버튼을 누르고 차트를 <b>세 번 탭</b>하세요.<br>' +
        '① 추세선 시작 → ② 추세선 끝(0선) → ③ 1:1 선이 지날 점' +
        '</div>';
      el.innerHTML = html;
      bindList();
      return;
    }

    const bySym = new Map();
    for (const s of list) {
      if (!bySym.has(s.symbol)) bySym.set(s.symbol, []);
      bySym.get(s.symbol).push(s);
    }
    for (const [sym, arr] of bySym) {
      html += '<div class="grp-head">' + esc(sym) + ' · ' + arr.length + '개</div>';
      for (const s of arr) html += cardHTML(s);
    }
    el.innerHTML = html;
    bindList();
  }

  function cardHTML(s) {
    const biasTag = s.bias === 'long' ? '<span class="tag long">롱</span>'
      : s.bias === 'short' ? '<span class="tag short">숏</span>' : '';
    const near = s.last
      ? ('가장 가까운 선 <b>' + s.last.L + '</b> ' + fmtPrice(s.last.v) +
         ' · 거리 ' + s.last.gapPct.toFixed(2) + '% · 현재 ' + fmtPrice(s.last.price))
      : '아직 확인 전 — 감시를 시작하세요';
    return '<div class="card' + (s.id === selId ? ' sel' : '') + '" data-id="' + s.id + '">' +
      '<div class="row1">' +
        '<label class="sw" title="알림 켜기/끄기"><input type="checkbox" data-f="enabled"' + (s.enabled !== false ? ' checked' : '') + '></label>' +
        '<span class="nm" data-act="rename">' + esc(s.name || s.symbol) + '</span>' +
        biasTag +
        '<span class="tag">' + esc(s.interval) + '</span>' +
      '</div>' +
      '<div class="meta">' + near + '</div>' +
      '<div class="meta">① ' + fmtTime(s.p1.time) + ' ' + fmtPrice(s.p1.price) +
        ' → ② ' + fmtTime(s.p2.time) + ' ' + fmtPrice(s.p2.price) +
        ' · ③ ' + fmtPrice(s.p3.price) + '</div>' +
      '<div class="row2">' +
        '<label>레벨 <input type="text" class="lv-in" data-f="levels" value="' + esc(s.levels.join(', ')) + '"></label>' +
        '<label>오차 <input type="number" class="tol-in" data-f="tol" step="0.05" min="0" value="' + (isFinite(s.tol) ? s.tol : prefs.tol) + '">%</label>' +
        '<select data-f="bias"><option value="auto"' + (s.bias === 'auto' || !s.bias ? ' selected' : '') + '>방향 미정</option>' +
          '<option value="long"' + (s.bias === 'long' ? ' selected' : '') + '>롱 자리</option>' +
          '<option value="short"' + (s.bias === 'short' ? ' selected' : '') + '>숏 자리</option></select>' +
        '<label class="sw"><input type="checkbox" data-f="show"' + (s.show !== false ? ' checked' : '') + '> 차트표시</label>' +
        '<button class="btn sm" data-act="view">보기</button>' +
        '<button class="btn sm" data-act="coords">좌표</button>' +
        '<button class="btn sm" data-act="pine">Pine</button>' +
        '<button class="btn sm danger" data-act="del">삭제</button>' +
      '</div>' +
    '</div>';
  }

  function bindList() {
    const el = $('tab-list');
    const cur = $('only-cur');
    if (cur) cur.onchange = () => { prefs.onlyCur = cur.checked; savePrefs(); renderList(); };

    el.querySelectorAll('.card').forEach((card) => {
      const s = setups.find((v) => v.id === card.dataset.id);
      if (!s) return;
      card.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f;
        const apply = () => {
          if (f === 'enabled') s.enabled = inp.checked;
          else if (f === 'show') s.show = inp.checked;
          else if (f === 'levels') s.levels = parseLevels(inp.value);
          else if (f === 'tol') s.tol = Math.max(0, parseFloat(inp.value) || 0);
          else if (f === 'bias') s.bias = inp.value;
          saveSetups(); redraw(); updateWatchPill();
        };
        inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', apply);
      });
      card.addEventListener('click', (e) => {
        const act = e.target.dataset && e.target.dataset.act;
        if (!act) { selId = s.id; renderList(); redraw(); return; }
        if (act === 'rename') {
          const v = prompt('이름', s.name || '');
          if (v != null) { s.name = v.trim(); saveSetups(); renderList(); }
        } else if (act === 'view') {
          $('sym').value = s.symbol; $('tf').value = s.interval;
          selId = s.id;
          loadChart();
        } else if (act === 'coords') {
          openCoords(s);
        } else if (act === 'pine') {
          openPine(s);
        } else if (act === 'del') {
          if (confirm('이 빗각을 지울까요?\n' + (s.name || s.symbol))) {
            setups = setups.filter((v) => v.id !== s.id);
            saveSetups(); renderList(); redraw();
          }
        }
      });
    });

    el.querySelectorAll('[data-act="new-draw"]').forEach((b) => b.onclick = () => setTool('fib'));
    el.querySelectorAll('[data-act="new-coords"]').forEach((b) => b.onclick = () => openCoords(null));
  }

  function renderLog() {
    const el = $('log');
    if (!log.length) { el.innerHTML = '<div class="empty">아직 알림이 없습니다.</div>'; return; }
    el.innerHTML = log.map((r) => {
      const side = r.bias === 'long' ? ' · 롱 자리' : r.bias === 'short' ? ' · 숏 자리' : '';
      return '<div class="log-item ' + r.kind + '">' +
        '<span class="t">' + fmtClock(r.ts) + '</span>' +
        '<span class="b"><span class="s">' + esc(r.sym) + ' ' + esc(r.tf) + ' · ' + r.L + ' 빗각 ' +
          (r.kind === 'touch' ? '터치' : '근접') + '</span>' +
          '<div class="d">선 ' + fmtPrice(r.v) + ' · 현재 ' + fmtPrice(r.price) + side + '</div></span>' +
      '</div>';
    }).join('');
  }

  // ------------------------------------------------------------ modal sheets
  function openSheet(html, after) {
    $('sheet').innerHTML = html;
    $('modal').hidden = false;
    if (after) after();
  }
  function closeSheet() { $('modal').hidden = true; $('sheet').innerHTML = ''; }
  function copyText(txt, btn) {
    const done = () => { if (btn) { const t = btn.textContent; btn.textContent = '복사됨!'; setTimeout(() => { btn.textContent = t; }, 1200); } };
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(txt).then(done, () => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (_) {}
      document.body.removeChild(ta);
    }
  }

  // Manual coordinate entry — the exact numbers from TradingView's 좌표 tab.
  function openCoords(s) {
    const isNew = !s;
    const d = s || {
      symbol: view.symbol, interval: view.interval, name: '',
      p1: { time: 0, price: 0 }, p2: { time: 0, price: 0 }, p3: { time: 0, price: 0 },
      levels: parseLevels(prefs.levels), tol: prefs.tol, bias: 'auto',
    };
    const row = (i, p) => '<div class="pt-row"><span class="lb">' + i + '번 점</span>' +
      '<input type="datetime-local" id="c-t' + i + '" value="' + (p.time ? toLocalInput(p.time) : '') + '">' +
      '<input type="number" step="any" id="c-p' + i + '" placeholder="가격" value="' + (p.price || '') + '"></div>';
    openSheet(
      '<h3>' + (isNew ? '좌표로 빗각 추가' : '좌표 수정') + '</h3>' +
      '<p class="sub">트레이딩뷰에서 피보나치 채널을 길게 눌러 <b>설정 → 좌표</b>를 열면 1·2·3번 점의 시간과 가격이 그대로 나옵니다. ' +
      '시간은 <b>차트에 보이는 로컬 시간</b> 기준으로 넣으세요.</p>' +
      '<div class="pt-row"><span class="lb">심볼 · 시간봉</span>' +
        '<input type="text" id="c-sym" value="' + esc(d.symbol) + '">' +
        '<input type="text" id="c-tf" style="width:70px" value="' + esc(d.interval) + '"></div>' +
      '<div class="pt-row"><span class="lb">이름</span><input type="text" id="c-name" style="flex:1" value="' + esc(d.name || '') + '"></div>' +
      row(1, d.p1) + row(2, d.p2) + row(3, d.p3) +
      '<div class="pt-row"><span class="lb">레벨</span><input type="text" id="c-lv" style="flex:1" value="' + esc(d.levels.join(', ')) + '"></div>' +
      '<div class="pt-row"><span class="lb">허용오차 %</span><input type="number" step="0.05" id="c-tol" value="' + (isFinite(d.tol) ? d.tol : prefs.tol) + '"></div>' +
      '<div class="foot"><button class="btn" id="c-cancel">취소</button><button class="btn primary" id="c-ok">저장</button></div>',
      () => {
        $('c-cancel').onclick = closeSheet;
        $('c-ok').onclick = () => {
          const get = (i) => ({ time: fromLocalInput($('c-t' + i).value), price: parseFloat($('c-p' + i).value) });
          const p1 = get(1), p2 = get(2), p3 = get(3);
          if (![p1, p2, p3].every((p) => isFinite(p.time) && isFinite(p.price))) { alert('세 점의 시간과 가격을 모두 채워 주세요.'); return; }
          if (p1.time === p2.time) { alert('1번과 2번 점의 시간이 같습니다.'); return; }
          const target = s || { id: uid(), enabled: true, show: true, created: Date.now(), fired: [] };
          Object.assign(target, {
            symbol: ($('c-sym').value || '').trim().toUpperCase(),
            interval: ($('c-tf').value || '').trim(),
            name: $('c-name').value.trim() || (($('c-sym').value || '').trim().toUpperCase() + ' 빗각'),
            p1, p2, p3,
            levels: parseLevels($('c-lv').value),
            tol: Math.max(0, parseFloat($('c-tol').value) || 0),
          });
          if (isNew) setups.unshift(target);
          saveSetups(); selId = target.id; closeSheet(); renderList(); redraw();
        };
      }
    );
  }

  // Pine v5 script — for real push alerts on a locked phone via TradingView.
  function pineScript(s) {
    const lv = s.levels.map((n) => (Number.isInteger(n) ? n.toFixed(1) : String(n))).join(', ');
    const tol = isFinite(s.tol) ? s.tol : prefs.tol;
    return [
      '//@version=5',
      'indicator("빗각 ' + (s.name || s.symbol).replace(/"/g, "'") + '", overlay=true, max_lines_count=60)',
      '',
      '// ── 앵커 3점 (UNIX 밀리초). 트레이딩뷰 피보나치 채널의 1·2·3번 점과 같습니다.',
      't1 = ' + s.p1.time * 1000 + '',
      'p1 = ' + s.p1.price,
      't2 = ' + s.p2.time * 1000 + '',
      'p2 = ' + s.p2.price,
      't3 = ' + s.p3.time * 1000 + '',
      'p3 = ' + s.p3.price,
      '',
      'lvls  = array.from(' + lv + ')',
      'tolPc = ' + tol + '        // 허용오차 %',
      '',
      'base(t) => p1 + (p2 - p1) * (1.0 * (t - t1) / (t2 - t1))',
      'd = p3 - base(t3)',
      '',
      '// 빗각 그리기',
      'var line[] ln = array.new_line()',
      'if barstate.islast',
      '    for i = 0 to array.size(ln) - 1',
      '        line.delete(array.get(ln, i))',
      '    array.clear(ln)',
      '    for i = 0 to array.size(lvls) - 1',
      '        L = array.get(lvls, i)',
      '        col = L == math.round(L) ? color.new(#2962ff, 0) : color.new(#e3b505, 0)',
      '        array.push(ln, line.new(t1, base(t1) + L * d, t2, base(t2) + L * d, xloc = xloc.bar_time, extend = extend.both, color = col, width = 2))',
      '',
      '// 터치 감지',
      'hit  = false',
      'hitL = 0.0',
      'for i = 0 to array.size(lvls) - 1',
      '    L = array.get(lvls, i)',
      '    v = base(time) + L * d',
      '    tol = math.abs(v) * tolPc / 100',
      '    if high >= v - tol and low <= v + tol',
      '        hit  := true',
      '        hitL := L',
      '',
      'plotshape(hit, title = "빗각 터치", style = shape.circle, location = location.belowbar, color = color.new(#f7a600, 0), size = size.tiny)',
      'alertcondition(hit, title = "빗각 터치", message = "빗각 터치 {{ticker}} {{interval}} @ {{close}}")',
      'if hit',
      '    alert("빗각 터치 " + syminfo.ticker + " " + timeframe.period + " · " + str.tostring(hitL) + "선 @ " + str.tostring(close), alert.freq_once_per_bar)',
      '',
      '// 쓰는 법: 트레이딩뷰 → Pine 에디터에 붙여넣기 → 차트에 추가 → 알림(Alert) 만들기 →',
      '//          조건에 이 스크립트를 고르고 "Any alert() function call" 선택 → 앱 푸시 켜기.',
      '// 주의: 시간 기준이라 24시간 거래(무기한 선물)에서 정확합니다. 장 마감이 있는 종목은',
      '//       휴장 구간만큼 기울기가 트레이딩뷰 작도와 미세하게 다를 수 있습니다.',
    ].join('\n');
  }
  function openPine(s) {
    const code = pineScript(s);
    openSheet(
      '<h3>Pine 스크립트 · ' + esc(s.name || s.symbol) + '</h3>' +
      '<p class="sub">트레이딩뷰에 붙여넣고 알림을 걸면 <b>페이지를 닫아도 폰으로 푸시</b>가 옵니다.</p>' +
      '<textarea id="pine-ta" style="height:230px" readonly>' + esc(code) + '</textarea>' +
      '<div class="foot"><button class="btn" id="p-close">닫기</button><button class="btn primary" id="p-copy">복사</button></div>',
      () => {
        $('p-close').onclick = closeSheet;
        $('p-copy').onclick = (e) => copyText(code, e.target);
      }
    );
  }

  // ----------------------------------------------------------------- init
  function bindPrefs() {
    const map = [
      ['p-poll', 'poll', 'number'], ['p-levels', 'levels', 'text'], ['p-tol', 'tol', 'number'],
      ['p-near', 'near', 'check'], ['p-nearpct', 'nearPct', 'number'],
      ['p-sound', 'sound', 'check'], ['p-notify', 'notify', 'check'], ['p-wake', 'wake', 'check'],
    ];
    for (const [id, key, kind] of map) {
      const el = $(id);
      if (!el) continue;
      if (kind === 'check') el.checked = !!prefs[key]; else el.value = prefs[key];
      el.addEventListener(kind === 'check' ? 'change' : 'input', () => {
        prefs[key] = kind === 'check' ? el.checked : (kind === 'number' ? parseFloat(el.value) : el.value);
        savePrefs();
        if (key === 'poll' && watching()) { stopWatch(); startWatch(); }
        if (key === 'wake') { if (prefs.wake && watching()) requestWakeLock(); else releaseWakeLock(); }
      });
    }
  }

  function bindUI() {
    $('btn-load').onclick = loadChart;
    $('sym').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadChart(); });
    $('t-fib').onclick = () => setTool('fib');
    $('t-edit').onclick = () => setTool('edit');
    $('t-magnet').onclick = () => { magnet = !magnet; $('t-magnet').classList.toggle('on', magnet); };
    $('t-fit').onclick = () => { chart.fitContent(); redraw(); };

    document.querySelectorAll('.tab[data-tab]').forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.toggle('on', x === t));
        ['list', 'alerts', 'set'].forEach((k) => { $('tab-' + k).hidden = (k !== t.dataset.tab); });
        $('panel').classList.remove('collapsed');
      };
    });
    $('btn-collapse').onclick = () => {
      const p = $('panel');
      p.classList.toggle('collapsed');
      $('btn-collapse').textContent = p.classList.contains('collapsed') ? '▴' : '▾';
      setTimeout(() => { resizeOverlay(); redraw(); }, 60);
    };

    $('btn-watch').onclick = () => { watching() ? stopWatch() : startWatch(); };
    $('btn-perm').onclick = async () => {
      unlockAudio();
      if (!('Notification' in global)) { alert('이 브라우저는 알림을 지원하지 않습니다. 소리 알림은 동작합니다.'); return; }
      const r = await Notification.requestPermission();
      status(r === 'granted' ? '알림 권한 허용됨' : '알림 권한 거부됨 — 소리로만 알립니다', r === 'granted' ? 'ok' : 'err');
    };
    $('btn-test').onclick = () => {
      unlockAudio();
      notify('빗각 알림 테스트', 'DRAM 4h · 1 빗각 62.68 · 현재 62.70', 'test');
      beep(true);
    };
    $('btn-clearlog').onclick = () => { log = []; saveLog(); renderLog(); };

    $('btn-export').onclick = () => {
      const ta = $('io');
      ta.hidden = false;
      ta.value = JSON.stringify({ v: 1, exported: new Date().toISOString(), prefs, setups }, null, 2);
      ta.select();
    };
    $('btn-import').onclick = () => {
      const ta = $('io');
      if (ta.hidden || !ta.value.trim()) { ta.hidden = false; ta.value = ''; ta.focus(); status('JSON을 붙여넣고 다시 누르세요'); return; }
      try {
        const j = JSON.parse(ta.value);
        const incoming = Array.isArray(j) ? j : (j.setups || []);
        let added = 0;
        for (const s of incoming) {
          if (!s || !s.p1 || !s.p2 || !s.p3) continue;
          if (setups.some((x) => x.id === s.id)) continue;
          s.id = s.id || uid();
          s.levels = parseLevels((s.levels || []).join(','));
          setups.push(s); added++;
        }
        saveSetups(); renderList(); redraw();
        status(added + '개 불러왔습니다', 'ok');
      } catch (e) { status('JSON을 읽지 못했습니다: ' + e.message, 'err'); }
    };

    $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeSheet(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    // Any tap unlocks the audio context (browsers require a gesture first).
    document.addEventListener('pointerdown', unlockAudio, { once: true });
  }

  function fillSymbols() {
    const dl = $('symlist');
    const known = Object.keys((global.DataSource && global.DataSource.SYMBOLS) || {});
    const saved = setups.map((s) => s.symbol);
    const all = [];
    for (const s of known.concat(saved)) if (all.indexOf(s) < 0) all.push(s);
    dl.innerHTML = all.map((s) => '<option value="' + esc(s) + '"></option>').join('');
  }

  function start() {
    if (!global.LightweightCharts || !global.ChartWrap || !global.DataSource) {
      status('스크립트 로딩 실패 — 새로고침 해 주세요', 'err');
      return;
    }
    initChart();
    fillSymbols();
    bindPrefs();
    bindUI();
    renderList();
    renderLog();
    updateWatchPill();
    // A service worker is what lets mobile browsers show notifications; it has
    // no fetch handler, so it never touches how the rest of the site loads.
    if (global.navigator.serviceWorker) {
      global.navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    loadChart();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // Exposed for quick console debugging.
  global.Angle = {
    get setups() { return setups; }, get prefs() { return prefs; },
    get candles() { return view.candles; }, get view() { return view; },
    get chart() { return chart; },
    lineFns, indexAt, timeAt, pollAll, pineScript,
  };
})(window);
