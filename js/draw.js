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
  let magnetOn = false;

  const lines = [];          // committed trendlines: [{a:{time,price}, b:{...}}]
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
    const r = wrapEl.getBoundingClientRect();
    const dpr = global.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
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
  // Pixel → data point, with optional strong-magnet snap to nearest candle OHLC.
  function toDataPoint(x, y) {
    let time = chart.xToTime(x);
    let price = chart.yToPrice(y);
    if (time == null || price == null) return null;
    if (magnetOn && getCandles) {
      const candles = getCandles();
      if (candles && candles.length) {
        // nearest candle by time
        let best = null, bestDT = Infinity;
        for (let i = 0; i < candles.length; i++) {
          const dt = Math.abs(candles[i].time - time);
          if (dt < bestDT) { bestDT = dt; best = candles[i]; }
        }
        if (best) {
          const cands = [best.open, best.high, best.low, best.close];
          let snapPrice = best.close, bestDP = Infinity;
          for (const p of cands) {
            const dp = Math.abs(p - price);
            if (dp < bestDP) { bestDP = dp; snapPrice = p; }
          }
          return { time: best.time, price: snapPrice };
        }
      }
    }
    return { time: time, price: price };
  }
  function toPixel(pt) {
    const x = chart.timeToX(pt.time);
    const y = chart.priceToY(pt.price);
    if (x == null || y == null) return null;
    return { x, y };
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
    const moved = a && b && (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 4);
    if (tool === 'draw') {
      if (moved) lines.push({ a: drag.a, b: drag.b });
    } else if (tool === 'ruler') {
      if (moved) measure = { a: drag.a, b: drag.b };
    }
    drag = null;
    redraw();
  }

  // ---- rendering ----
  function redraw() {
    if (!ctx || !canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // committed trendlines
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#e0b040';
    for (const ln of lines) drawSeg(ln.a, ln.b);

    // in-progress trendline preview
    if (tool === 'draw' && drag) { ctx.strokeStyle = '#e0b040'; drawSeg(drag.a, drag.b); }

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

  function drawRuler(a, b) {
    const pa = toPixel(a), pb = toPixel(b);
    if (!pa || !pb) return;
    const up = b.price >= a.price;
    const col = up ? 'rgba(32,178,108,0.9)' : 'rgba(239,69,74,0.9)';
    const fill = up ? 'rgba(32,178,108,0.12)' : 'rgba(239,69,74,0.12)';
    // shaded box
    ctx.fillStyle = fill;
    ctx.fillRect(Math.min(pa.x, pb.x), Math.min(pa.y, pb.y), Math.abs(pb.x - pa.x), Math.abs(pb.y - pa.y));
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();

    // measurement text
    const dPrice = b.price - a.price;
    const pct = a.price ? (dPrice / a.price) * 100 : 0;
    const bars = barsBetween(a.time, b.time);
    const dMin = Math.round((b.time - a.time) / 60);
    const label = (dPrice >= 0 ? '+' : '') + fmt(dPrice) + '  (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)\n' +
      bars + ' bars · ' + fmtDur(dMin);
    drawLabel(label, (pa.x + pb.x) / 2, Math.min(pa.y, pb.y) - 6, col);
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
  function drawLabel(text, cx, cy, col) {
    ctx.font = "600 12px -apple-system, 'Segoe UI', Roboto, sans-serif";
    const lines2 = text.split('\n');
    let maxW = 0;
    for (const l of lines2) maxW = Math.max(maxW, ctx.measureText(l).width);
    const padX = 8, padY = 5, lh = 15;
    const boxW = maxW + padX * 2, boxH = lines2.length * lh + padY * 2;
    let x = cx - boxW / 2, y = cy - boxH;
    x = Math.max(2, Math.min(x, canvas.clientWidth - boxW - 2));
    y = Math.max(2, y);
    ctx.fillStyle = 'rgba(16,16,20,0.92)';
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    roundRect(x, y, boxW, boxH, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < lines2.length; i++) ctx.fillText(lines2[i], x + padX, y + padY + lh * (i + 1) - 3);
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
