// paint.js — neon line annotation over a chart screenshot (paint.html).
//
// You drop in a chart capture, click points, and the points are joined in the
// order you clicked with a glowing neon line that draws itself on playback.
// Straight segments only — no curve fitting — which is what chart mark-up
// (support / resistance / breakout arrows) actually needs.
//
// The neon look is ADDITIVE, not a translucent marker: the stroke is bloomed
// through two small offscreen buffers scaled back up, then the lit tube is laid
// over it. That is why a stroke reads as light emitted over the chart rather
// than ink on top of it, and why '배경: 검정' + a Screen blend in an editor
// drops the black and keeps only the glow. On a white background none of that
// works, so there is a separate path — see neon().
//
// Points live in NORMALISED canvas coords {u,v} in 0..1 so they survive an
// aspect-ratio change and the canvas being displayed at any on-screen size.

(function () {
  'use strict';

  // ---- constants ----
  const RATIOS = {
    '3:4':  [1080, 1440],
    '9:16': [1080, 1920],
    '1:1':  [1080, 1080],
    '4:5':  [1080, 1350],
    '16:9': [1920, 1080],
  };
  const COLORS = ['#ff2f2f', '#ffe600', '#00e676'];   // 빨 · 노 · 초 (+ 직접 지정)

  // Pen acceleration along a stroke. Progress is eased over the stroke's whole
  // length, so on a multi-segment line the pen keeps easing across the corners
  // instead of restarting per segment. All of these map 0→0 and 1→1, which is
  // what lets the scheduler keep using raw progress to decide what is finished.
  const EASE = {
    linear:   (t) => t,
    cubicOut: (t) => 1 - Math.pow(1 - t, 3),          // 빠르게 출발 → 도착하며 감속
    cubicIn:  (t) => t * t * t,                       // 느리게 출발 → 최고 속도로 끝
    circEase: (t) => t < 0.5                          // 양끝 느리고 중간이 빠름
      ? (1 - Math.sqrt(1 - 4 * t * t)) / 2
      : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2,
  };
  const HIT_PX = 18;      // grab radius for dragging an existing point
  const DUP_PX = 7;       // clicks closer than this to the last point are ignored
  const AUTO_SNAP_PX = 5; // un-shifted clicks this close to level/plumb are straightened
  const TAIL_MS = 900;    // extra recorded time after the last stroke finishes
  const TAP_SLOP = 10;    // movement below this still counts as a tap, not a drag

  // Shown in the toolbar so it is possible to tell at a glance whether the
  // browser is showing the newest deploy or a cached copy. Bump this and the
  // ?v= query on the css/js tags together on every deploy.
  const BUILD = 'v9 · 08-21 선명도';

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const cv = $('cv');
  const ctx = cv.getContext('2d');
  const stage = $('stage');
  const statusEl = $('status');

  // Offscreen canvas holding every stroke that is already fully drawn, so a
  // frame only ever re-renders the one stroke still animating.
  const bake = document.createElement('canvas');
  const bctx = bake.getContext('2d');
  let bakeIdx = 0;

  // ---- state ----
  let CW = 1080, CH = 1440;
  let img = null;                       // background HTMLImageElement
  let bg = { scale: 1, ox: 0, oy: 0 };  // background placement in canvas px
  const strokes = [];                   // [{pts:[{u,v}], color, width, glow, arrow, open}]
  let drag = null;                      // {si, pi} — point being moved
  let panning = null;                   // {x, y} — Alt-drag background pan origin
  let hover = null;                     // {x, y} — rubber-band target in canvas px
  const pointers = new Map();           // live pointers, for two-finger gestures
  let pending = null;                   // finger down, not yet a tap or a drag
  let gesture = null;                   // two-finger pan/pinch anchor
  let dirty = true;                     // something changed → repaint needed
  let playing = false, playT = 0, playStart = 0;
  let recorder = null, chunks = null, stream = null, recording = false;
  let clean = false;
  let bgMode = 'photo';                 // 'photo' | 'black' | 'white'
  let RES = 1;                          // backing-store pixels per logical pixel

  const opt = { kind: 'line', color: COLORS[1], width: 9, glow: 1, speed: 1400, gap: 250, arrow: false, ease: 'cubicOut' };

  // ---------------------------------------------------------------- geometry
  const px = (p) => ({ x: p.u * CW, y: p.v * CH });
  const lightBg = () => bgMode === 'white';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sgn = (v) => (v < 0 ? -1 : 1);   // never 0, unlike Math.sign

  function openStroke() {
    const s = strokes[strokes.length - 1];
    return s && s.open ? s : null;
  }

  function polyLen(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = px(pts[i - 1]), b = px(pts[i]);
      d += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return d;
  }

  // Points of the polyline up to fraction p (0..1) of its total length, with the
  // final point interpolated inside the segment the pen is currently crossing.
  function partial(pts, p) {
    const all = pts.map(px);
    if (all.length < 2 || p >= 1) return all;
    if (p <= 0) return [all[0]];
    let total = 0;
    const segs = [];
    for (let i = 1; i < all.length; i++) {
      const d = Math.hypot(all[i].x - all[i - 1].x, all[i].y - all[i - 1].y);
      segs.push(d); total += d;
    }
    let want = total * p;
    const out = [all[0]];
    for (let i = 0; i < segs.length; i++) {
      if (want >= segs[i]) { out.push(all[i + 1]); want -= segs[i]; continue; }
      const t = segs[i] ? want / segs[i] : 0;
      out.push({
        x: all[i].x + (all[i + 1].x - all[i].x) * t,
        y: all[i].y + (all[i + 1].y - all[i].y) * t,
      });
      break;
    }
    return out;
  }

  // Circles and rectangles are stored as their two defining corners but drawn
  // as a dense polyline, so the whole animation / easing / bake path stays the
  // same code as a straight line — a shape just has more points. The outline is
  // generated in PIXEL space and converted back, otherwise a circle would come
  // out as an ellipse on a non-square canvas.
  // Segment count follows the drawn size: a fixed 96 leaves ~13px facets on a
  // big circle, which reads as a polygon once the canvas is rendered sharp.
  const circleSegs = (rx, ry) =>
    Math.round(clamp(Math.PI * (rx + ry) / 5, 64, 320));

  function shapePts(s) {
    if (!isShape(s)) return s.pts;
    if (s.pts.length < 2) return s.pts;
    // Cached: a circle expands to ~97 points, and this is called for every
    // stroke on every frame by the scheduler. Regenerating them all each frame
    // is pure garbage for a drawing that has not moved.
    const key = s.kind + s.pts[0].u + ',' + s.pts[0].v + ',' + s.pts[1].u + ',' + s.pts[1].v + ',' + CW + 'x' + CH;
    if (s.outKey === key) return s.outline;
    const a = px(s.pts[0]), b = px(s.pts[1]);
    const out = [];
    const back = (x, y) => out.push({ u: x / CW, v: y / CH });
    if (s.kind === 'rect') {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      // top-left → clockwise → closed, so the pen ends where it started
      back(x0, y0); back(x1, y0); back(x1, y1); back(x0, y1); back(x0, y0);
    } else {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
      const segs = circleSegs(rx, ry);
      for (let i = 0; i <= segs; i++) {
        const t = -Math.PI / 2 + (i / segs) * Math.PI * 2;   // start at 12 o'clock
        back(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
      }
    }
    s.outKey = key; s.outline = out;
    return out;
  }

  // 'circle' is the always-round tool; 'ellipse' is the freely stretched one.
  // They share the same outline maths — a circle simply has its two corners
  // squared off at input time, so rx and ry come out equal.
  const isShape = (s) => s.kind === 'circle' || s.kind === 'ellipse' || s.kind === 'rect';

  // Straighten a segment: Shift locks to horizontal / vertical / 45°, and an
  // un-shifted point that is already within a few px of level is nudged flat —
  // a support line that is 2px off looks wrong on video.
  function snap(prev, x, y, shift, kind) {
    if (!prev) return { x, y };
    const a = px(prev);
    let dx = x - a.x, dy = y - a.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (kind && kind !== 'line') {
      // The round tool is square-constrained always; the stretchy ones only
      // while Shift is held. The auto-flatten never applies to a shape — it
      // would collapse it into a line.
      if (shift || kind === 'circle') {
        // sgn(), not Math.sign(): a perfectly horizontal drag has dy === 0, and
        // Math.sign(0) is 0 — which would square the shape down onto a flat
        // line instead of rounding it out.
        const m = (ax + ay) / 2;
        dx = sgn(dx) * m; dy = sgn(dy) * m;
      }
      return { x: a.x + dx, y: a.y + dy };
    }
    if (shift) {
      if (ay < ax * 0.4142) dy = 0;              // within 22.5° of horizontal
      else if (ax < ay * 0.4142) dx = 0;         // within 22.5° of vertical
      else { const m = (ax + ay) / 2; dx = sgn(dx) * m; dy = sgn(dy) * m; }
    } else {
      if (ay <= AUTO_SNAP_PX) dy = 0;
      else if (ax <= AUTO_SNAP_PX) dx = 0;
    }
    return { x: a.x + dx, y: a.y + dy };
  }

  // ---------------------------------------------------------------- timeline
  // Strokes play one after another at a constant pen speed, so a long line
  // takes proportionally longer than a short one instead of every stroke
  // taking the same time regardless of length.
  function schedule() {
    const items = [];
    let t = 0;
    for (const s of strokes) {
      const dur = Math.max(90, (polyLen(shapePts(s)) / opt.speed) * 1000);
      items.push({ start: t, dur: dur, end: t + dur });
      t += dur + opt.gap;
    }
    return { items: items, total: items.length ? items[items.length - 1].end : 0 };
  }

  // Raw 0..1 fraction of a stroke's time slot — used to decide what has
  // finished, so it must stay un-eased.
  function progressAt(item, t) {
    if (!item.dur) return 1;
    return clamp((t - item.start) / item.dur, 0, 1);
  }

  // How far along its own length the pen has actually travelled.
  function easedAt(s, item, t) {
    return (EASE[s.ease] || EASE.linear)(progressAt(item, t));
  }

  // --------------------------------------------------------------- rendering
  // Glow is real bloom: the stroke is rendered into two small offscreen
  // buffers and scaled back up, so bilinear filtering does the blurring. That
  // gives a continuous falloff instead of the visible stair-steps you get from
  // stacking a handful of ever-wider strokes, and it costs two drawImage calls
  // instead of a ~100px blur kernel (which stalls the frame loop hard enough
  // that MediaRecorder captures nothing).
  //
  //   far  — 1/18 scale, the wide atmospheric haze
  //   near — 1/5  scale, the tight halo hugging the line
  //   then the line itself, then a slightly lightened core.
  const BLOOM = [
    { div: 18, spread: 1.9, alpha: 0.42 },
    { div: 5,  spread: 1.25, alpha: 0.38 },
  ];
  const bloomBufs = BLOOM.map(() => document.createElement('canvas'));

  function sizeBlooms() {
    BLOOM.forEach((b, i) => {
      bloomBufs[i].width = Math.max(1, Math.round(CW / b.div));
      bloomBufs[i].height = Math.max(1, Math.round(CH / b.div));
    });
  }

  // The core keeps the stroke's hue instead of blowing out to pure white —
  // a fully white centre reads as a cheap arcade sign rather than lit glass.
  function lighten(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const m = (c) => Math.round(c + (255 - c) * amt);
    return 'rgb(' + m(r) + ',' + m(g) + ',' + m(b) + ')';
  }

  function bloom(g, path, color, width, glow, light, box) {
    for (let i = 0; i < BLOOM.length; i++) {
      const cfg = BLOOM[i], buf = bloomBufs[i];
      const s = 1 / cfg.div;
      const b = buf.getContext('2d');
      b.setTransform(s, 0, 0, s, 0, 0);
      b.clearRect(0, 0, CW, CH);
      b.lineCap = 'round';
      b.lineJoin = 'round';
      b.strokeStyle = color;
      // Widen with glow, but keep a floor so glow=0 is a clean line, not a blob.
      b.lineWidth = width * (1 + (cfg.spread - 1) * glow);
      b.globalAlpha = 1;
      b.stroke(path);
      b.setTransform(1, 0, 0, 1, 0, 0);

      // Composite only the stroke's own neighbourhood. The upscale costs
      // destination pixels, and a support line spanning the frame still covers
      // a sliver of it — blooming all 1080x1440 for that is most of the work
      // thrown away. Padding covers the smear: about one destination pixel per
      // buffer pixel, plus the drawn width.
      const pad = width * cfg.spread + cfg.div * 3;
      const dx0 = clamp(box.x0 - pad, 0, CW), dy0 = clamp(box.y0 - pad, 0, CH);
      const dx1 = clamp(box.x1 + pad, 0, CW), dy1 = clamp(box.y1 + pad, 0, CH);
      const dw = dx1 - dx0, dh = dy1 - dy0;
      if (dw <= 0 || dh <= 0) continue;

      g.globalCompositeOperation = light ? 'source-over' : 'lighter';
      g.globalAlpha = cfg.alpha * glow * (light ? 0.5 : 1);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(buf, dx0 * s, dy0 * s, dw * s, dh * s, dx0, dy0, dw, dh);
    }
  }

  function bboxOf(pts, pad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }

  function neon(g, path, color, width, glow, box) {
    const light = lightBg();
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';

    if (glow > 0.01) bloom(g, path, color, width, glow, light, box);

    g.globalCompositeOperation = light ? 'source-over' : 'lighter';
    g.imageSmoothingEnabled = true;

    if (light) {
      // Additive blending has nowhere to go on white — every stroke saturates
      // to white and vanishes, and a light core is invisible anyway. Here the
      // colour itself is the line and the bloom sits under it.
      g.globalAlpha = 1;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.stroke(path);
      g.restore();
      return;
    }

    // The lit tube: colour body, then a narrower lightened core. Two soft
    // shoulders in between keep the edge from turning into a hard rim.
    g.globalAlpha = 0.55;
    g.strokeStyle = color;
    g.lineWidth = width * 1.5;
    g.stroke(path);

    g.globalAlpha = 0.85;
    g.lineWidth = width;
    g.stroke(path);

    g.globalAlpha = 0.9;
    g.strokeStyle = lighten(color, 0.55);
    g.lineWidth = Math.max(1, width * 0.5);
    g.stroke(path);

    g.globalAlpha = 1;
    g.strokeStyle = lighten(color, 0.86);
    g.lineWidth = Math.max(1, width * 0.22);
    g.stroke(path);

    g.restore();
  }

  function linePath(pts) {
    const p = new Path2D();
    if (!pts.length) return p;
    p.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
    return p;
  }

  function arrowPath(from, to, size) {
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const spread = Math.PI / 7;
    const p = new Path2D();
    p.moveTo(to.x - size * Math.cos(ang - spread), to.y - size * Math.sin(ang - spread));
    p.lineTo(to.x, to.y);
    p.lineTo(to.x - size * Math.cos(ang + spread), to.y - size * Math.sin(ang + spread));
    return p;
  }

  // Paint one stroke (whole or partially advanced) onto a context.
  function paintStroke(g, s, p) {
    const pts = partial(shapePts(s), p);
    if (pts.length < 2) return;
    neon(g, linePath(pts), s.color, s.width, s.glow, bboxOf(pts, s.width));
    if (s.arrow && !isShape(s)) {
      // The head rides the leading tip for the whole draw rather than popping
      // in at the end, so the stroke reads as an arrow flying to its target.
      // It scales up over the first stretch — a full-size head on a 5px stub
      // just looks like a detached arrowhead floating on the chart.
      const n = pts.length;
      const full = Math.max(34, s.width * 5.5);
      let drawn = 0;
      for (let i = 1; i < n; i++) drawn += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      const size = full * clamp(drawn / (full * 1.6), 0, 1);
      if (size > 1) {
        neon(g, arrowPath(pts[n - 2], pts[n - 1], size), s.color, s.width, s.glow,
             bboxOf([pts[n - 1]], size + s.width));
      }
    }
  }

  function invalidateBake() {
    bakeIdx = 0;
    bctx.clearRect(0, 0, CW, CH);
    touch();
  }

  function bakeUpTo(n) {
    while (bakeIdx < n) { paintStroke(bctx, strokes[bakeIdx], 1); bakeIdx++; }
  }

  function drawBackground() {
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = lightBg() ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, CW, CH);
    if (img && bgMode === 'photo') {
      ctx.drawImage(img, bg.ox, bg.oy, img.width * bg.scale, img.height * bg.scale);
    }
  }

  function setBgMode(m) {
    bgMode = m;
    $('bgmode').value = m;
    invalidateBake();   // the neon itself is rendered differently on white
  }

  // Where the next click would land, as a thin dashed outline. Deliberately not
  // rendered in neon — a full-brightness preview reads as already committed.
  function drawPreview(open) {
    if (!hover) return;
    // The anchor is the last placed point, or — on the very first drag of a new
    // shape, where no stroke exists yet — wherever the finger went down.
    let base = null, kind = opt.kind;
    if (open && open.pts.length) { base = open.pts; kind = open.kind; }
    else if (pending && pending.moved) base = [{ u: pending.x / CW, v: pending.y / CH }];
    if (!base) return;
    const ghost = { kind: kind, pts: base.concat([{ u: hover.x / CW, v: hover.y / CH }]) };
    const pts = shapePts(ghost).map(px);
    if (pts.length < 2) return;
    ctx.save();
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = lightBg() ? 'rgba(0,0,0,.5)' : 'rgba(255,255,255,.55)';
    ctx.stroke(linePath(isShape(ghost) ? pts : pts.slice(-2)));
    ctx.restore();
  }

  function drawHandles() {
    ctx.save();
    ctx.font = '600 20px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of strokes) {
      for (let i = 0; i < s.pts.length; i++) {
        const p = px(s.pts[i]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = lightBg() ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.55)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = lightBg()
          ? (s.open ? '#111111' : 'rgba(0,0,0,.5)')
          : (s.open ? '#ffffff' : 'rgba(255,255,255,.55)');
        ctx.stroke();
        if (s.open) {
          ctx.fillStyle = lightBg() ? 'rgba(0,0,0,.8)' : 'rgba(255,255,255,.85)';
          ctx.fillText(String(i + 1), p.x, p.y - 20);
        }
      }
    }
    ctx.restore();
  }

  function render(sch) {
    drawBackground();

    if (playing || recording) {
      let live = -1;
      let done = 0;
      for (let i = 0; i < strokes.length; i++) {
        const p = progressAt(sch.items[i], playT);
        if (p >= 1) done = i + 1;
        else { if (p > 0) live = i; break; }
      }
      bakeUpTo(done);
      blitBake();
      if (live >= 0) paintStroke(ctx, strokes[live], easedAt(strokes[live], sch.items[live], playT));
    } else {
      // Editing: everything is shown finished. Only the stroke still being
      // clicked stays out of the bake, since it changes on every click.
      const open = openStroke();
      bakeUpTo(strokes.length - (open ? 1 : 0));
      blitBake();
      if (open) paintStroke(ctx, open, 1);
      if (!clean) { drawPreview(open); drawHandles(); }
    }

    const total = sch.total / 1000;
    const now = playing ? Math.min(playT, sch.total) / 1000 : total;
    const pts = strokes.reduce((n, s) => n + s.pts.length, 0);
    statusEl.textContent = strokes.length
      ? `획 ${strokes.length} · 점 ${pts} · ${now.toFixed(1)} / ${total.toFixed(1)}s`
      : '';
  }

  function blitBake() {
    ctx.save();
    ctx.globalCompositeOperation = lightBg() ? 'source-over' : 'lighter';
    ctx.drawImage(bake, 0, 0, bake.width, bake.height, 0, 0, CW, CH);
    ctx.restore();
  }

  function frame(now) {
    const sch = schedule();
    if (playing) {
      playT = now - playStart;
      if (playT >= sch.total + (recording ? TAIL_MS : 500)) {
        playing = false;
        playT = sch.total;
        if (recording) stopRec();
        setPlayingUI(false);
        $('btn-play').classList.remove('on');
      }
    }
    // Idle frames paint nothing. On a tablet a permanently running canvas loop
    // is the difference between the app being usable for an hour and the
    // device getting hot — and the recorder only needs frames while it records.
    if (playing || recording || dirty) { render(sch); dirty = false; }
    requestAnimationFrame(frame);
  }

  function touch() { dirty = true; }

  // ----------------------------------------------------------------- canvas
  function setRatio(key) {
    const [w, h] = RATIOS[key] || RATIOS['3:4'];
    CW = w; CH = h;
    sizeBlooms();
    sizeCanvases();
    fitBg();
    layout();
  }

  // Drawing coordinates stay logical (CW x CH); only the backing store grows.
  // On a retina tablet the canvas was authored at 1080 wide and then stretched
  // to ~1430 device pixels, which is what made diagonals and circle arcs look
  // stepped while axis-aligned edges stayed clean. Rendering at the display's
  // real pixel count removes the upscale entirely.
  function sizeCanvases() {
    const bw = Math.max(2, Math.round(CW * RES / 2) * 2);   // even: encoders prefer it
    const bh = Math.max(2, Math.round(CH * RES / 2) * 2);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw; cv.height = bh;
      bake.width = bw; bake.height = bh;
    }
    // Setting .width resets context state, so the transform is re-applied here.
    const sx = bw / CW, sy = bh / CH;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    bctx.setTransform(sx, 0, 0, sy, 0, 0);
    invalidateBake();
  }

  function layout() {
    const pad = clean ? 0 : 28;
    const aw = Math.max(1, stage.clientWidth - pad);
    const ah = Math.max(1, stage.clientHeight - pad);
    const s = Math.min(aw / CW, ah / CH);
    const cssW = Math.floor(CW * s);
    cv.style.width = cssW + 'px';
    cv.style.height = Math.floor(CH * s) + 'px';

    // Match the backing store to the pixels actually on screen, 1:1. Anything
    // else leaves the browser rescaling the canvas, and a fractional rescale is
    // what shreds thin diagonals and circle arcs while leaving axis-aligned
    // edges clean. Recording overrides this upward — see startRec.
    const want = clamp((cssW * (window.devicePixelRatio || 1)) / CW, 0.3, 2);
    if (Math.abs(want - RES) > 0.02) { RES = want; sizeCanvases(); }
    touch();
  }

  function fitBg() {
    touch();
    if (!img) return;
    const s = Math.min(CW / img.width, CH / img.height);
    bg = { scale: s, ox: (CW - img.width * s) / 2, oy: (CH - img.height * s) / 2 };
  }

  function loadImage(src) {
    const im = new Image();
    im.onload = () => { img = im; fitBg(); $('hint').hidden = true; touch(); };
    im.src = src;
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const fr = new FileReader();
    fr.onload = () => loadImage(fr.result);
    fr.readAsDataURL(file);
  }

  // --------------------------------------------------------------- pointers
  function toCanvas(e) {
    const r = cv.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (CW / r.width),
      y: (e.clientY - r.top) * (CH / r.height),
    };
  }

  function hitPoint(x, y) {
    for (let si = strokes.length - 1; si >= 0; si--) {
      const s = strokes[si];
      for (let pi = s.pts.length - 1; pi >= 0; pi--) {
        const p = px(s.pts[pi]);
        if (Math.hypot(p.x - x, p.y - y) <= HIT_PX) return { si, pi };
      }
    }
    return null;
  }

  function newStroke() {
    const s = {
      kind: opt.kind, pts: [], color: opt.color, width: opt.width,
      glow: opt.glow, arrow: opt.arrow, ease: opt.ease, open: true,
    };
    strokes.push(s);
    return s;
  }

  function addPoint(s, x, y, shift) {
    const prev = s.pts[s.pts.length - 1];
    const p = snap(prev, x, y, shift, s.kind);
    // Swallow the second click of a double-click (and stray double taps).
    if (prev && Math.hypot(p.x - px(prev).x, p.y - px(prev).y) < DUP_PX) return false;
    s.pts.push({ u: p.x / CW, v: p.y / CH });
    $('hint').hidden = true;   // drawing started; stop advertising the drop target
    // A box or circle is fully defined by two corners, so it closes itself and
    // the next tap starts a new one.
    if (isShape(s) && s.pts.length === 2) { s.open = false; hover = null; }
    return true;
  }

  function onDown(e) {
    if (playing) return;
    const { x, y } = toCanvas(e);
    pointers.set(e.pointerId, { x, y });

    // Second finger down starts a background pan/zoom and abandons whatever the
    // first finger was in the middle of — a two-finger gesture must never leave
    // a stray point behind.
    if (pointers.size === 2) {
      pending = null; drag = null; hover = null;
      gesture = gestureState();
      touch();
      return;
    }
    if (pointers.size > 1) return;

    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    if (e.altKey && img) { panning = { x: x - bg.ox, y: y - bg.oy }; return; }

    const hit = hitPoint(x, y);
    if (hit) { drag = hit; hover = null; touch(); return; }

    // Nothing is committed yet: this becomes a tap (place a point) or a drag
    // (rubber-band out a shape / segment) depending on what the finger does.
    pending = { x, y, moved: false };
    touch();
  }

  function onMove(e) {
    const { x, y } = toCanvas(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y });

    if (gesture && pointers.size >= 2) { applyGesture(); touch(); return; }
    if (panning) { bg.ox = x - panning.x; bg.oy = y - panning.y; touch(); return; }

    if (drag) {
      const s = strokes[drag.si];
      const prev = drag.pi > 0 ? s.pts[drag.pi - 1] : null;
      const p = snap(prev, x, y, e.shiftKey, s.kind);
      s.pts[drag.pi] = { u: p.x / CW, v: p.y / CH };
      if (!s.open) invalidateBake();   // a baked stroke changed shape
      touch();
      return;
    }

    if (pending) {
      if (!pending.moved && Math.hypot(x - pending.x, y - pending.y) > TAP_SLOP) pending.moved = true;
      if (pending.moved) {
        // Live size preview while the finger is still down. Without this a
        // touch user places every circle blind — there is no hover to rely on.
        const s = openStroke();
        const from = (s && s.pts.length) ? s.pts[s.pts.length - 1] : { u: pending.x / CW, v: pending.y / CH };
        hover = snap(from, x, y, e.shiftKey, s ? s.kind : opt.kind);
        pending.anchor = from;
        touch();
      }
      return;
    }

    // Mouse hover (no button held) — same rubber band, no drag required.
    // Only repaint when the band actually moves; otherwise sweeping the mouse
    // across the canvas would redraw every frame for no visible change.
    const s = openStroke();
    const next = (s && s.pts.length) ? snap(s.pts[s.pts.length - 1], x, y, e.shiftKey, s.kind) : null;
    if (!!next !== !!hover || (next && (next.x !== hover.x || next.y !== hover.y))) {
      hover = next;
      touch();
    }
  }

  function onUp(e) {
    try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
    pointers.delete(e.pointerId);
    if (gesture) { if (pointers.size < 2) gesture = null; touch(); return; }
    // Always drop the rubber band on release, whatever this gesture turned out
    // to be — a ghost outline left behind after moving a point looks like a
    // shape that failed to commit.
    const wasDrag = drag;
    drag = null; panning = null; hover = null;

    const p = pending; pending = null;
    if (!p || wasDrag) { touch(); return; }
    const { x, y } = toCanvas(e);
    let s = openStroke() || newStroke();
    if (p.moved) {
      // press → drag → release draws the whole thing in one gesture
      if (!s.pts.length) addPoint(s, p.x, p.y, false);
      addPoint(s, x, y, e.shiftKey);
    } else {
      addPoint(s, p.x, p.y, e.shiftKey);
    }
    hover = null;
    touch();
  }

  // ---- background pan / pinch-zoom ----
  function gestureState() {
    const [a, b] = [...pointers.values()];
    return {
      dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
      bg: { scale: bg.scale, ox: bg.ox, oy: bg.oy },
    };
  }

  function applyGesture() {
    if (!img) return;
    const [a, b] = [...pointers.values()];
    const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const g = gesture;
    const ns = clamp(g.bg.scale * (dist / g.dist), 0.05, 12);
    const k = ns / g.bg.scale;
    // Zoom about the pinch centre, then follow however the centre itself moved.
    bg.scale = ns;
    bg.ox = g.cx - (g.cx - g.bg.ox) * k + (cx - g.cx);
    bg.oy = g.cy - (g.cy - g.bg.oy) * k + (cy - g.cy);
  }

  function onWheel(e) {
    if (!img) return;
    e.preventDefault();
    const { x, y } = toCanvas(e);
    const ns = clamp(bg.scale * Math.exp(-e.deltaY * 0.0015), 0.05, 12);
    bg.ox = x - (x - bg.ox) * (ns / bg.scale);
    bg.oy = y - (y - bg.oy) * (ns / bg.scale);
    bg.scale = ns;
    touch();
  }

  // ---------------------------------------------------------------- actions
  function endStroke() {
    hover = null; touch();
    const s = openStroke();
    if (!s) return;
    if (s.pts.length < 2) { strokes.pop(); return; }
    s.open = false;
  }

  // Switching tool always starts a fresh stroke — half a line finished as a box
  // is never what was meant.
  function setKind(k) {
    endStroke();
    touch();
    opt.kind = k;
    [...$('tools').children].forEach((el) => el.classList.toggle('on', el.dataset.kind === k));
    $('btn-arrow').disabled = k !== 'line';
  }

  function undo() {
    const s = strokes[strokes.length - 1];
    if (!s) return;
    if (s.pts.length > 1) s.pts.pop(); else strokes.pop();
    invalidateBake();
  }

  function clearAll() {
    strokes.length = 0;
    invalidateBake();
    playing = false; playT = 0;
  }

  function play() {
    endStroke();
    if (!strokes.length) return;
    invalidateBake();
    playT = 0;
    playStart = performance.now();
    playing = true;
    setPlayingUI(true);
    $('btn-play').classList.add('on');
  }

  function startRec() {
    if (recording || !strokes.length) return;
    if (!cv.captureStream || typeof MediaRecorder === 'undefined') {
      alert('이 브라우저는 캔버스 녹화를 지원하지 않습니다. 데스크톱 Chrome을 쓰거나 화면 녹화로 대신하세요.');
      return;
    }
    // Safari (iPad) has MediaRecorder but no VP8/VP9 — it encodes H.264 in mp4.
    // Listing mp4 last keeps webm on Chrome while letting a tablet record at all.
    const types = [
      'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
      'video/mp4;codecs=avc1', 'video/mp4',
    ];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) { alert('이 브라우저는 캔버스 녹화를 지원하지 않습니다. 화면 녹화를 사용하세요.'); return; }
    chunks = [];
    // The displayed size drives RES, so on a small window the backing store —
    // and therefore the recording — would sit below the authored 1080. Force it
    // up for the duration; layout() restores it when recording ends.
    if (RES < 1) { RES = 1; sizeCanvases(); }
    // Keep our own reference to the stream: if only the MediaRecorder holds it,
    // the capture track can be collected mid-recording and the file comes out
    // with zero frames.
    stream = cv.captureStream(60);
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const ext = /mp4/.test(mime) ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: 'video/' + ext });
      if (blob.size < 2000) {
        // Header-only file: the encoder produced no frames (usually a machine
        // with no GPU video encoding). Better to say so than to hand over a
        // webm that opens as a black rectangle.
        alert('녹화된 프레임이 없습니다. 이 PC에서 캔버스 녹화가 동작하지 않는 것 같습니다 — 속도를 늦춰 다시 시도하거나 화면 녹화를 사용하세요.');
        recorder = null; chunks = null; stream = null;
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'neon-' + Date.now() + '.' + ext;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      recorder = null; chunks = null; stream = null;
    };
    recording = true;
    $('btn-rec').classList.add('on');
    recorder.start(250);   // chunked: without a timeslice some builds emit an empty blob
    play();
  }

  function stopRec() {
    if (!recording) return;
    recording = false;
    $('btn-rec').classList.remove('on');
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    layout();   // back to a display-matched backing store
  }

  // Clean mode hides the toolbar and, where the browser allows it, takes the
  // page fullscreen. `fromFs` marks the call as a reaction to a fullscreen
  // change that already happened (browser Esc, window chrome) so we don't turn
  // around and ask the browser to undo it again.
  function setClean(on, fromFs) {
    clean = on;
    document.body.classList.toggle('clean', on);
    $('btn-clean').classList.toggle('on', on);
    $('btn-exit').hidden = !on;
    $('btn-fsplay').hidden = !on;
    if (!fromFs) {
      const el = document.documentElement;
      if (on && el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
    layout();
    touch();
    if (on) pokeExit();
  }

  // Bring the exit button back to full opacity, then let it fade again once
  // the pointer has been still for a moment.
  let exitTimer = 0;
  function pokeExit() {
    const els = [$('btn-exit'), $('btn-fsplay')];
    els.forEach((b) => b.classList.remove('idle'));
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => { if (clean) els.forEach((b) => b.classList.add('idle')); }, 2500);
  }

  // While the animation runs the overlay buttons go away entirely. Canvas
  // recording never saw them, but a screen recording would.
  function setPlayingUI(on) {
    document.body.classList.toggle('playing', on);
    if (!on && clean) pokeExit();
  }

  // Settings edit the open stroke too, so a colour/width change is visible
  // while you are still clicking the line out.
  function applyToOpen(key, val) {
    const s = openStroke();
    if (s) s[key] = val;
  }

  // --------------------------------------------------------------------- UI
  // Colour: three fixed presets plus a freely picked one. Whichever is active
  // gets the ring, and the hex box always shows the colour in use so it can be
  // read off or pasted into.
  function selectColor(c) {
    touch();
    opt.color = c;
    applyToOpen('color', c);
    const custom = $('custom');
    [...$('swatches').children].forEach((el) => el.classList.toggle('on', el.dataset.color === c));
    custom.classList.toggle('on', !COLORS.includes(c));
    custom.style.boxShadow = '0 0 10px ' + custom.value;
    const hex = $('hex');
    hex.value = c.toUpperCase();
    hex.classList.remove('bad');
  }

  function buildSwatches() {
    const wrap = $('swatches');
    COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'sw';
      b.style.color = c;
      b.dataset.color = c;
      b.title = String(i + 1);
      b.onclick = () => selectColor(c);
      wrap.appendChild(b);
    });
  }

  function pickColor(i) {
    const b = $('swatches').children[i];
    if (b) b.click();
  }

  function slider(id, key, fmt, after) {
    const el = $(id), out = $(id + '-v');
    const sync = () => {
      const v = Number(el.value);
      opt[key] = key === 'glow' ? v / 100 : v;
      out.textContent = fmt(opt[key]);
      applyToOpen(key, opt[key]);
      touch();
      if (after) after();
    };
    el.addEventListener('input', sync);
    sync();
  }

  function init() {
    buildSwatches();
    $('build').textContent = BUILD;
    selectColor(opt.color);
    setRatio('3:4');

    [...$('tools').children].forEach((b) => { b.onclick = () => setKind(b.dataset.kind); });
    $('custom').addEventListener('input', (e) => selectColor(e.target.value));
    $('hex').addEventListener('input', (e) => {
      const v = e.target.value.trim().replace(/^#?/, '#');
      if (!/^#[0-9a-f]{6}$/i.test(v)) { e.target.classList.add('bad'); return; }
      e.target.classList.remove('bad');
      if (!COLORS.includes(v.toLowerCase())) $('custom').value = v;
      opt.color = v;
      applyToOpen('color', v);
      [...$('swatches').children].forEach((el) => el.classList.toggle('on', el.dataset.color === v.toLowerCase()));
      $('custom').classList.toggle('on', !COLORS.includes(v.toLowerCase()));
      $('custom').style.boxShadow = '0 0 10px ' + $('custom').value;
    });
    $('ease').addEventListener('change', (e) => {
      opt.ease = e.target.value;
      applyToOpen('ease', opt.ease);
    });

    slider('width', 'width', (v) => String(v), invalidateBake);
    slider('glow', 'glow', (v) => v.toFixed(1), invalidateBake);
    slider('speed', 'speed', (v) => String(v));
    slider('gap', 'gap', (v) => String(v));

    $('ratio').addEventListener('change', (e) => setRatio(e.target.value));
    $('btn-img').onclick = () => $('file').click();
    $('file').onchange = (e) => loadFile(e.target.files[0]);
    $('btn-end').onclick = endStroke;
    $('btn-undo').onclick = undo;
    $('btn-clear').onclick = clearAll;
    $('btn-play').onclick = play;
    $('btn-rec').onclick = () => (recording ? stopRec() : startRec());
    $('btn-clean').onclick = () => setClean(!clean);
    $('btn-exit').onclick = () => setClean(false);
    $('btn-help').onclick = () => ($('help').hidden = false);
    $('help-close').onclick = () => ($('help').hidden = true);
    $('btn-arrow').onclick = () => {
      opt.arrow = !opt.arrow;
      $('btn-arrow').classList.toggle('on', opt.arrow);
      applyToOpen('arrow', opt.arrow);
      invalidateBake();
    };
    $('bgmode').addEventListener('change', (e) => setBgMode(e.target.value));
    $('btn-fsplay').onclick = play;

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('pointerleave', () => { hover = null; });
    cv.addEventListener('dblclick', endStroke);
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('resize', layout);

    // The toolbar wraps to more rows on a narrow screen, so its height cannot
    // be a constant — measure it and let the stage size itself from that.
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty('--bar-h', $('bar').offsetHeight + 'px');
        layout();
      }).observe($('bar'));
    }

    // Leaving fullscreen by any route the page doesn't own — Esc, F11, the
    // browser's own control — has to drop clean mode too, or the toolbar stays
    // hidden with no way back to it.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && clean) setClean(false, true);
    });
    ['pointermove', 'pointerdown', 'keydown'].forEach((t) =>
      window.addEventListener(t, () => { if (clean) pokeExit(); }, { passive: true }));

    // drop / paste an image anywhere on the page
    ['dragenter', 'dragover'].forEach((t) =>
      window.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((t) =>
      window.addEventListener(t, () => document.body.classList.remove('dragover')));
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });
    window.addEventListener('paste', (e) => {
      for (const it of e.clipboardData.items) {
        if (it.type.indexOf('image') === 0) { loadFile(it.getAsFile()); break; }
      }
    });

    window.addEventListener('keydown', (e) => {
      // A slider keeps focus after it is dragged, so blanket-ignoring every
      // focused control would silently kill Space / F right after adjusting
      // speed. Only text-entry and selects swallow keys; a range gives up
      // everything except its own arrow keys.
      const t = e.target;
      if (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range')) return;
      const k = e.key;
      if (t.tagName === 'INPUT' && /^Arrow/.test(k)) return;
      if (k >= '1' && k <= '3') { pickColor(Number(k) - 1); return; }
      switch (k) {
        case 'q': case 'Q': setKind('line'); break;
        case 'w': case 'W': setKind('circle'); break;
        case 'e': case 'E': setKind('ellipse'); break;
        case 'r': case 'R': setKind('rect'); break;
        case 'Enter': endStroke(); break;
        case 'Backspace': e.preventDefault(); undo(); break;
        case ' ': e.preventDefault(); play(); break;
        case '[': $('width').value = Math.max(2, opt.width - 1); $('width').dispatchEvent(new Event('input')); break;
        case ']': $('width').value = Math.min(28, opt.width + 1); $('width').dispatchEvent(new Event('input')); break;
        case '0': fitBg(); break;
        case 'v': case 'V': recording ? stopRec() : startRec(); break;
        case 'b': case 'B': {
          const order = ['photo', 'black', 'white'];
          setBgMode(order[(order.indexOf(bgMode) + 1) % order.length]);
          break;
        }
        case 'f': case 'F': setClean(!clean); break;
        case 'Escape':
          if (!$('help').hidden) $('help').hidden = true;
          else if (clean) setClean(false);
          else if (playing) { playing = false; setPlayingUI(false); $('btn-play').classList.remove('on'); }
          else endStroke();
          break;
      }
    });

    requestAnimationFrame(frame);
  }

  init();
})();
