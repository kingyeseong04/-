// draw.js
// A lightweight drawing layer on top of the chart, since lightweight-charts
// has no built-in drawing tools. Implements three TradingView-style tools:
//   • 선 긋기 (trendline)  — drag to draw persistent lines
//   • 자 (ruler/measure)   — drag to measure Δprice / % / #bars (+ time)
//   • 스트롱 마그넷 (magnet) — snaps drawn points to the nearest candle O/H/L/C
//
// Points are stored in DATA coordinates {time, price} so drawings stay anchored
// to the candles as the chart scrolls, scales, or replays.

(function (global) {
  'use strict';

  let chart = null;          // ChartWrap
  let wrapEl = null;         // #chart-wrap (positioning context)
  let getCandles = null;     // () => candles[]
  let canvas = null, ctx = null;
  let tool = null;           // null | 'draw' | 'ruler'
  let magnetOn = true;       // strong magnet on by default (snaps to candle OHLC)

  const SNAP_PX = 16;        // magnet range: snap only when this close to a candle
  const lines = [];          // committed trendlines: [{a:{logical,price}, b:{...}}]
  let measure = null;        // last ruler measurement (persists until cleared)
  let drag = null;           // in-progress drag: {a, b}

  function init(chartWrap, wrapElement, candlesGetter) {
    chart = chartWrap; wrapEl = wrapElement; getCandles = candlesGetter;
    canvas = document.createElement('canvas');
    canvas.id = 'draw-canvas';
    canvas.style.cssText =
      'position:absolute;inset:0;z-index:4;pointer-events:none;touch-action:none;';
    wrapEl.appendChild(canvas);
    ctx = canvas.getContext('2d');

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('dblclick', () => { // clear everything with a double-tap
      lines.length = 0; measure = null; drag = null; redraw();
    });

    if (chart.subscribeRange) chart.subscribeRange(redraw);
    if (chart.subscribeCrosshair) chart.subscribeCrosshair(redraw);
    window.addEventListener('resize', () => { resize(); redraw(); });
    resize();
  }

  function resize() {
    if (!canvas || !wrapEl) return;
    // <canvas> doesn't stretch via inset:0, so size it explicitly to the current
    // chart-wrap box (CSS size for layout + backing store for crisp rendering).
    const r = wrapEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = global.devicePixelRatio || 1;
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- tool state ----
  function toggle(which) {
    if (which === 'magnet') { magnetOn = !magnetOn; return; }
    tool = (tool === which) ? null : which;
    // Only capture pointer events while a drawing tool is active, so the chart
    // stays pannable otherwise.
    canvas.style.pointerEvents = tool ? 'auto' : 'none';
    canvas.style.cursor = tool ? 'crosshair' : 'default';
    if (!tool) drag = null;
    redraw();
  }
  function active() { return tool; }
  function magnet() { return magnetOn; }
  function clearAll() { lines.length = 0; measure = null; drag = null; redraw(); }

  // ---- coordinate mapping ----
  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  // Pixel → data point in {logical, price}. Using the LOGICAL index (not time)
  // lets lines/ruler extend into empty space beyond the candles ("허공"), since
  // logicalToCoordinate extrapolates past the data range. When the magnet is on
  // and the point is over a real candle, snap to that candle's nearest O/H/L/C.
  function toDataPoint(x, y) {
    const logical = chart.xToLogical(x);
    const price = chart.yToPrice(y);
    if (logical == null || price == null) return null;
    if (magnetOn && getCandles) {
      const c = getCandles();
      const i = Math.round(logical);
      if (c && i >= 0 && i < c.length) {
        const cd = c[i];
        const cands = [cd.open, cd.high, cd.low, cd.close];
        let sp = cd.close, bd = Infinity;
        for (const p of cands) { const d = Math.abs(p - price); if (d < bd) { bd = d; sp = p; } }
        // Proximity magnet (Bybit/TV feel): snap only when the finger is actually
        // NEAR the candle's O/H/L/C point; otherwise move freely ("허공").
        const cxp = chart.logicalToX(i), cyp = chart.priceToY(sp);
        if (cxp != null && cyp != null && Math.hypot(cxp - x, cyp - y) <= SNAP_PX) {
          return { logical: i, price: sp };
        }
      }
    }
    return { logical: logical, price: price };
  }
  function toPixel(pt) {
    const x = chart.logicalToX(pt.logical);
    const y = chart.priceToY(pt.price);
    if (x == null || y == null) return null;
    return { x, y };
  }
  // Approx timestamp for a logical index (real candle time in range, else
  // extrapolated by the bar spacing) — used for the ruler's duration readout.
  function logicalToTime(logical) {
    const c = getCandles(); if (!c || !c.length) return 0;
    const i = Math.round(logical);
    if (i >= 0 && i < c.length) return c[i].time;
    const step = c.length > 1 ? (c[c.length - 1].time - c[c.length - 2].time) : 3600;
    if (i < 0) return c[0].time + i * step;
    return c[c.length - 1].time + (i - (c.length - 1)) * step;
  }

  // ---- pointer handlers ----
  function onDown(e) {
    if (!tool) return;
    e.preventDefault();
    const { x, y } = localXY(e);
    const p = toDataPoint(x, y);
    if (!p) return;
    drag = { a: p, b: p };
    if (tool === 'ruler') measure = null;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    redraw();
  }
  function onMove(e) {
    if (!tool || !drag) return;
    const { x, y } = localXY(e);
    const p = toDataPoint(x, y);
    if (p) { drag.b = p; redraw(); }
  }
  function onUp(e) {
    if (!tool || !drag) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    const a = toPixel(drag.a), b = toPixel(drag.b);
    const moved = a && b && (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 6);
    if (tool === 'draw') {
      if (moved) lines.push({ a: drag.a, b: drag.b });
      else deleteLineNear(b || a); // a tap (no drag) near a line removes it
    } else if (tool === 'ruler') {
      if (moved) measure = { a: drag.a, b: drag.b };
      else measure = null; // tap clears the measurement
    }
    drag = null;
    redraw();
  }

  // ---- rendering ----
  function redraw() {
    if (!ctx || !canvas) return;
    // Auto-correct sizing if the chart-wrap box changed (initial layout, window
    // resize, entering/exiting clean mode) — <canvas> won't reflow on its own.
    const dpr = global.devicePixelRatio || 1;
    const r = wrapEl.getBoundingClientRect();
    if (r.width && Math.round(r.width * dpr) !== canvas.width) resize();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // committed trendlines (TradingView blue)
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = '#2962ff';
    for (const ln of lines) drawSeg(ln.a, ln.b);

    // in-progress trendline preview
    if (tool === 'draw' && drag) { ctx.strokeStyle = '#2962ff'; drawSeg(drag.a, drag.b); }

    // ruler (committed or in-progress)
    const m = (tool === 'ruler' && drag) ? drag : measure;
    if (m) drawRuler(m.a, m.b);
  }

  function drawSeg(a, b) {
    const pa = toPixel(a), pb = toPixel(b);
    if (!pa || !pb) return;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    // small endpoint dots
    ctx.fillStyle = ctx.strokeStyle;
    for (const p of [pa, pb]) { ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill(); }
  }

  // Bybit/TradingView measure box: BLUE when price rose, RED when it fell,
  // a shaded rectangle with centered direction arrows, and a solid label:
  //   Δprice (%) ticks  /  N bars, duration     (colours sampled from Bybit)
  function drawRuler(a, b) {
    const pa = toPixel(a), pb = toPixel(b);
    if (!pa || !pb) return;
    const up = b.price >= a.price;
    const solid = up ? '#3961f5' : '#f23645';           // label + arrows
    const fill = up ? 'rgba(57,97,245,0.20)' : 'rgba(242,54,69,0.20)';
    const edge = up ? 'rgba(57,97,245,0.55)' : 'rgba(242,54,69,0.55)';
    const x0 = Math.min(pa.x, pb.x), x1 = Math.max(pa.x, pb.x);
    const y0 = Math.min(pa.y, pb.y), y1 = Math.max(pa.y, pb.y);

    // shaded box + outline
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = edge; ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

    // centered vertical (price) + horizontal (time) arrows pointing to b
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    ctx.strokeStyle = solid; ctx.fillStyle = solid; ctx.lineWidth = 2;
    arrow(cx, pa.y, cx, pb.y);
    arrow(pa.x, cy, pb.x, cy);

    // metrics (no volume, per request)
    const dPrice = b.price - a.price;
    const pct = a.price ? (dPrice / a.price) * 100 : 0;
    const tick = tickSize(a.price);
    const ticks = tick ? Math.round(dPrice / tick) : 0;
    const bars = Math.abs(Math.round(b.logical - a.logical));
    const dMin = Math.round((logicalToTime(b.logical) - logicalToTime(a.logical)) / 60);
    const sgn = (n) => (n >= 0 ? '+' : '');
    const l1 = sgn(dPrice) + fmt(dPrice) + '  (' + sgn(pct) + pct.toFixed(2) + '%)  ' + sgn(ticks) + ticks;
    const l2 = bars + ' bars, ' + fmtDur(dMin);
    // label above the box for an up-move, below for a down-move (like TV)
    drawLabel(l1 + '\n' + l2, cx, up ? y0 - 6 : y1 + 6, solid, !up);
    // small price tags at the two endpoints (like Bybit's axis labels)
    drawPriceTag(a.price, x1, pa.y, solid);
    drawPriceTag(b.price, x1, pb.y, solid);
  }

  function drawPriceTag(price, x, y, col) {
    ctx.font = "600 11px -apple-system, 'Segoe UI', Roboto, sans-serif";
    const t = fmt(price);
    const w = ctx.measureText(t).width + 12, h = 18;
    let bx = x - w - 2; // sit just inside the box's right edge
    bx = Math.max(2, Math.min(bx, canvas.clientWidth - w - 2));
    const by = Math.max(2, Math.min(y - h / 2, canvas.clientHeight - h - 2));
    ctx.fillStyle = col;
    roundRect(bx, by, w, h, 3); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(t, bx + 6, by + h - 5);
  }

  function arrow(x0, y0, x1, y1) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const ang = Math.atan2(y1 - y0, x1 - x0), h = 7;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - h * Math.cos(ang - Math.PI / 6), y1 - h * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x1 - h * Math.cos(ang + Math.PI / 6), y1 - h * Math.sin(ang + Math.PI / 6));
    ctx.closePath(); ctx.fill();
  }

  function tickSize(price) {
    const a = Math.abs(price);
    if (a >= 1000) return 0.1;
    if (a >= 1) return 0.01;
    if (a >= 0.1) return 0.0001;
    return 0.000001;
  }
  function sumVolume(t0, t1) {
    if (!getCandles) return 0;
    const c = getCandles(); if (!c) return 0;
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    let s = 0;
    for (const cc of c) { if (cc.time >= lo && cc.time <= hi) s += (cc.volume || 0); }
    return s;
  }
  function fmtBig(n) {
    n = Math.abs(n || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return n.toFixed(0);
  }

  // Remove the trendline whose segment is closest to a tapped pixel point.
  function deleteLineNear(pt) {
    if (!pt) return;
    let bestI = -1, bestD = 10; // px threshold
    for (let i = 0; i < lines.length; i++) {
      const a = toPixel(lines[i].a), b = toPixel(lines[i].b);
      if (!a || !b) continue;
      const d = segDist(pt.x, pt.y, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI >= 0) lines.splice(bestI, 1);
  }
  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function barsBetween(t0, t1) {
    if (!getCandles) return '?';
    const c = getCandles(); if (!c || c.length < 2) return '?';
    let i0 = nearestIdx(c, t0), i1 = nearestIdx(c, t1);
    return Math.abs(i1 - i0);
  }
  function nearestIdx(c, t) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < c.length; i++) { const d = Math.abs(c[i].time - t); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function fmtDur(min) {
    min = Math.abs(min | 0);
    if (min >= 1440) return (min / 1440).toFixed(1) + 'd';
    if (min >= 60) return (min / 60).toFixed(1) + 'h';
    return min + 'm';
  }
  function fmt(n) {
    const a = Math.abs(n), d = a >= 1 ? 2 : a >= 0.1 ? 4 : 6;
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function drawLabel(text, cx, cy, col, below) {
    ctx.font = "600 12px -apple-system, 'Segoe UI', Roboto, sans-serif";
    const lines2 = text.split('\n');
    let maxW = 0;
    for (const l of lines2) maxW = Math.max(maxW, ctx.measureText(l).width);
    const padX = 9, padY = 6, lh = 16;
    const boxW = maxW + padX * 2, boxH = lines2.length * lh + padY * 2;
    let x = cx - boxW / 2, y = below ? cy : cy - boxH;
    x = Math.max(2, Math.min(x, canvas.clientWidth - boxW - 2));
    y = Math.max(2, Math.min(y, canvas.clientHeight - boxH - 2));
    // Solid coloured label with white text (TradingView measure style).
    ctx.fillStyle = col;
    roundRect(x, y, boxW, boxH, 4); ctx.fill();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < lines2.length; i++) ctx.fillText(lines2[i], x + padX, y + padY + lh * (i + 1) - 4);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  global.Draw = { init, toggle, active, magnet, clearAll, redraw, resize };
})(window);
