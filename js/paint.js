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
  // 빨 · 노 · 초 · 파 · 분 (+ 직접 지정). The five match the five arrow stickers,
  // so picking a colour is also how you pick which arrow gets placed.
  const COLORS = ['#ff2f2f', '#ffe600', '#00e676', '#2979ff', '#ff3d9a'];

  // Pre-drawn neon arrows, cropped to their content. tail/tip are where the
  // curl ends and where the head points, in 0..1 of the file — a drag from one
  // to the other is all the placement information an arrow needs, so the same
  // press-drag-release that draws a box also lays an arrow down at the right
  // size and angle.
  const ARROWS = [
    { file: 'img/arrow-red.webp',    tail: [0.9240, 0.9930], tip: [0.4680, 0.0060] },
    { file: 'img/arrow-yellow.webp', tail: [0.9076, 0.9899], tip: [0.4272, 0.0061] },
    { file: 'img/arrow-green.webp',  tail: [0.9006, 0.9929], tip: [0.4659, 0.0061] },
    { file: 'img/arrow-blue.webp',   tail: [0.8886, 0.9847], tip: [0.4629, 0.0066] },
    { file: 'img/arrow-pink.webp',   tail: [0.8543, 0.9874], tip: [0.5001, 0.0063] },
  ];

  const HIT_PX = 18;      // grab radius for dragging an existing point
  const DUP_PX = 7;       // clicks closer than this to the last point are ignored
  const AUTO_SNAP_PX = 5; // un-shifted clicks this close to level/plumb are straightened
  const TAIL_MS = 900;    // extra recorded time after the last stroke finishes
  const TAP_SLOP = 10;    // movement below this still counts as a tap, not a drag

  // Shown in the toolbar so it is possible to tell at a glance whether the
  // browser is showing the newest deploy or a cached copy. Bump this and the
  // ?v= query on the css/js tags together on every deploy.
  const BUILD = 'v14 · 08-24 화살표 스티커 · 60fps';

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

  // Background + everything already baked, flattened. During an animation the
  // only thing that changes from frame to frame is the one stroke still being
  // drawn, so rebuilding the chart photo and re-blitting the bake underneath it
  // sixty times a second is work thrown away — this collapses four full-canvas
  // operations per frame into one.
  const plate = document.createElement('canvas');
  const pctx = plate.getContext('2d');
  let plateDirty = true;

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
  let preroll = false;                  // showing the pre-animation frame
  let recFrames = 0, recT0 = 0;         // frames actually rendered while recording
  let RES = 1;                          // backing-store pixels per logical pixel
  let lastStatus = null;                // avoid redundant DOM writes

  const opt = { kind: 'line', color: COLORS[1], width: 9, glow: 1, speed: 1400, gap: 250, arrow: false, fps: 60 };

  // ------------------------------------------------------------ arrow assets
  // Loaded up front (about 90KB each): an arrow that pops in a frame or two
  // after it is placed would flicker in a recording.
  const arrowImgs = ARROWS.map((a) => {
    const im = new Image();
    im.onload = touch;
    im.src = a.file;
    return im;
  });

  // Any colour maps to an arrow — the nearest of the five presets. That keeps
  // the custom picker working instead of it silently doing nothing here.
  function arrowIdx(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    let best = 0, bd = Infinity;
    COLORS.forEach((c, i) => {
      const m = parseInt(c.slice(1), 16);
      const d = ((m >> 16 & 255) - r) ** 2 + ((m >> 8 & 255) - g) ** 2 + ((m & 255) - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  const arrowReady = (i) => { const im = arrowImgs[i]; return im.complete && im.naturalWidth ? im : null; };

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

  // Everything defined by exactly two taps: the shapes, plus an arrow sticker
  // (tail and tip). These close themselves on the second point.
  const isTwoPoint = (s) => isShape(s) || s.kind === 'img';

  // Straighten a segment: Shift locks to horizontal / vertical / 45°, and an
  // un-shifted point that is already within a few px of level is nudged flat —
  // a support line that is 2px off looks wrong on video.
  function snap(prev, x, y, shift, kind) {
    if (!prev) return { x, y };
    const a = px(prev);
    let dx = x - a.x, dy = y - a.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    // An arrow sticker is a free vector like a line: it may point anywhere, and
    // the same near-level nudge that flattens a support line is what makes a
    // near-vertical arrow come out actually vertical.
    if (kind && kind !== 'line' && kind !== 'img') {
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
  // Length is cached per stroke and invalidated by edits. Without it the
  // scheduler re-walked every point of every stroke on every frame, and a
  // circle is up to 320 of them.
  function strokeLen(s) {
    if (s.len == null || s.lenW !== CW || s.lenH !== CH) {
      s.len = polyLen(shapePts(s));
      s.lenW = CW; s.lenH = CH;
    }
    return s.len;
  }

  function editedStroke(s) { s.len = null; s.outKey = null; }

  function schedule() {
    const items = [];
    let t = 0;
    for (const s of strokes) {
      const dur = Math.max(90, (strokeLen(s) / opt.speed) * 1000);
      items.push({ start: t, dur: dur, end: t + dur });
      t += dur + opt.gap;
    }
    return { items: items, total: items.length ? items[items.length - 1].end : 0 };
  }

  // The pen runs at a constant rate: progress is the raw fraction of the
  // stroke's time slot.
  function progressAt(item, t) {
    if (!item.dur) return 1;
    return clamp((t - item.start) / item.dur, 0, 1);
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

  // `paint(b, cfg)` puts the thing to be bloomed into the small buffer, which
  // already carries the downscale transform. A line strokes a path into it; an
  // arrow sticker draws its image. `spread` is the drawn width, used only to
  // work out how far the smear can reach outside the given box.
  function bloom(g, paint, glow, light, box, spread) {
    for (let i = 0; i < BLOOM.length; i++) {
      const cfg = BLOOM[i], buf = bloomBufs[i];
      const s = 1 / cfg.div;
      const b = buf.getContext('2d');
      b.setTransform(s, 0, 0, s, 0, 0);
      b.clearRect(0, 0, CW, CH);
      b.globalAlpha = 1;
      b.globalCompositeOperation = 'source-over';
      paint(b, cfg);
      b.setTransform(1, 0, 0, 1, 0, 0);

      // Composite only the stroke's own neighbourhood. The upscale costs
      // destination pixels, and a support line spanning the frame still covers
      // a sliver of it — blooming all 1080x1440 for that is most of the work
      // thrown away. Padding covers the smear: about one destination pixel per
      // buffer pixel, plus the drawn width.
      const pad = spread * cfg.spread + cfg.div * 3;
      const dx0 = clamp(box.x0 - pad, 0, CW), dy0 = clamp(box.y0 - pad, 0, CH);
      const dx1 = clamp(box.x1 + pad, 0, CW), dy1 = clamp(box.y1 + pad, 0, CH);
      const dw = dx1 - dx0, dh = dy1 - dy0;
      if (dw <= 0 || dh <= 0) continue;

      g.globalCompositeOperation = light ? 'source-over' : 'lighter';
      g.globalAlpha = cfg.alpha * glow * (light ? 0.5 : 1);
      g.imageSmoothingEnabled = true;
      // Plain bilinear, deliberately. The source here is an already-blurred
      // thumbnail, so a bicubic resample has nothing left to recover — measured
      // side by side the two are the same picture (mean difference well under
      // one level per channel) while 'high' costs about four times as much, and
      // this upscale is the single most expensive thing in the frame.
      g.imageSmoothingQuality = 'low';
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

    if (glow > 0.01) {
      bloom(g, (b, cfg) => {
        b.lineCap = 'round';
        b.lineJoin = 'round';
        b.strokeStyle = color;
        // Widen with glow, but keep a floor so glow=0 is a clean line, not a blob.
        b.lineWidth = width * (1 + (cfg.spread - 1) * glow);
        b.stroke(path);
      }, glow, light, box, width);
    }

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

  // ---- arrow stickers ----
  // The two points are mapped onto the file's own tail and tip with a
  // similarity transform, so the arrow keeps its proportions at any angle and
  // any size — no squashing, whatever the drag.
  function arrowGeom(s, im, idx) {
    const meta = ARROWS[idx];
    const a = px(s.pts[0]), b = px(s.pts[1]);
    const ax = meta.tail[0] * im.width, ay = meta.tail[1] * im.height;
    const bx = meta.tip[0] * im.width,  by = meta.tip[1] * im.height;
    const ilen = Math.max(1, Math.hypot(bx - ax, by - ay));
    const dlen = Math.hypot(b.x - a.x, b.y - a.y);
    const k = dlen / ilen;
    const rot = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(by - ay, bx - ax);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const to = (x, y) => {
      const dx = (x - ax) * k, dy = (y - ay) * k;
      return { x: a.x + dx * cos - dy * sin, y: a.y + dx * sin + dy * cos };
    };
    // Real transformed bounds, so the bloom composite covers the arrow and not
    // just the line between the two handles — the curl swings well off it.
    const box = bboxOf([to(0, 0), to(im.width, 0), to(im.width, im.height), to(0, im.height)], 2);
    return { a, ax, ay, bx, by, ilen, k, cos, sin, box, dlen };
  }

  function arrowXform(g, m) {
    g.translate(m.a.x, m.a.y);
    g.rotate(Math.atan2(m.sin, m.cos));
    g.scale(m.k, m.k);
    g.translate(-m.ax, -m.ay);
  }

  // Reveal: a straight edge sweeping from tail to tip, clipped in the file's own
  // space so it travels along the arrow rather than across the screen. The arrow
  // grows out of its tail the same way a drawn line grows from its first point.
  function arrowClip(g, m, p) {
    if (p >= 1) return;
    const ux = (m.bx - m.ax) / m.ilen, uy = (m.by - m.ay) / m.ilen;
    const nx = -uy, ny = ux;
    const BIG = m.ilen * 4;
    const f = m.ilen * p;
    const at = (t, u) => [m.ax + ux * t + nx * u, m.ay + uy * t + ny * u];
    const c = [at(-BIG, BIG), at(f, BIG), at(f, -BIG), at(-BIG, -BIG)];
    g.beginPath();
    g.moveTo(c[0][0], c[0][1]);
    for (let i = 1; i < 4; i++) g.lineTo(c[i][0], c[i][1]);
    g.clip();
  }

  function paintArrow(g, s, p, alpha) {
    if (s.pts.length < 2 || p <= 0) return;
    const idx = arrowIdx(s.color);
    const im = arrowReady(idx);
    if (!im) return;
    const m = arrowGeom(s, im, idx);
    if (m.dlen < 2) return;
    const light = lightBg();

    const put = (h) => {
      h.save();
      arrowXform(h, m);
      arrowClip(h, m, p);
      h.imageSmoothingEnabled = true;
      h.imageSmoothingQuality = 'high';
      h.drawImage(im, 0, 0);
      h.restore();
    };

    // These files already carry their own glow, so the bloom on top is a light
    // touch — enough to sit them in the same light as the drawn strokes rather
    // than looking pasted onto the chart.
    // bloom() leaves its own alpha and composite op behind, so it is fenced off
    // here the way neon() fences it: without this the leftover alpha lands on
    // the bake context and every stroke baked after the first comes out dim.
    if (s.glow > 0.01 && alpha == null) {
      g.save();
      bloom(g, put, Math.min(1, s.glow * 0.55), light, m.box, 0);
      g.restore();
    }

    // Solid, unlike a drawn stroke: these are painted artwork with their own
    // highlights, and adding them to the chart made the candles read straight
    // through the arrow body. The bloom above is what carries the light.
    g.save();
    g.globalAlpha = alpha == null ? 1 : alpha;
    g.globalCompositeOperation = 'source-over';
    put(g);
    g.restore();
  }

  // Paint one stroke (whole or partially advanced) onto a context.
  function paintStroke(g, s, p) {
    if (s.kind === 'img') { paintArrow(g, s, p, null); return; }
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
    plateDirty = true;
    touch();
  }

  function bakeUpTo(n) {
    while (bakeIdx < n) { paintStroke(bctx, strokes[bakeIdx], 1); bakeIdx++; plateDirty = true; }
  }

  // Rebuilt only when the background moved or another stroke finished.
  function syncPlate() {
    if (!plateDirty) return;
    plateDirty = false;
    pctx.clearRect(0, 0, CW, CH);
    pctx.fillStyle = lightBg() ? '#ffffff' : '#000000';
    pctx.fillRect(0, 0, CW, CH);
    if (img && bgMode === 'photo') {
      pctx.drawImage(img, bg.ox, bg.oy, img.width * bg.scale, img.height * bg.scale);
    }
    // The bake is premultiplied, so source-over is dst*(1-a) + src: a solid
    // core replaces, a glow halo blends by its own alpha. Over pure black —
    // which is what gets recorded for a Screen blend — that is identical to
    // adding, and it also lets an opaque sticker cover what sits under it.
    pctx.save();
    pctx.globalCompositeOperation = 'source-over';
    pctx.drawImage(bake, 0, 0, bake.width, bake.height, 0, 0, CW, CH);
    pctx.restore();
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
    // For a sticker the dashed axis says almost nothing about where the arrow
    // will land, so the arrow itself is previewed, dimmed.
    if (kind === 'img') {
      paintArrow(ctx, { kind: 'img', pts: ghost.pts.slice(-2), color: opt.color }, 1, 0.45);
      return;
    }
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
    if (playing || recording || preroll) {
      let live = -1;
      let done = 0;
      for (let i = 0; i < strokes.length; i++) {
        const p = progressAt(sch.items[i], playT);
        if (p >= 1) done = i + 1;
        else { if (p > 0) live = i; break; }
      }
      bakeUpTo(done);
      blitPlate();
      // The live stroke is always the newest thing on screen, so painting it
      // straight over the plate puts it in the same z-order the bake will give
      // it a moment later — it does not shift when it finishes.
      if (live >= 0) paintStroke(ctx, strokes[live], progressAt(sch.items[live], playT));
    } else {
      // Editing: everything is shown finished. Only the stroke still being
      // clicked stays out of the bake, since it changes on every click.
      const open = openStroke();
      bakeUpTo(strokes.length - (open ? 1 : 0));
      blitPlate();
      if (open) paintStroke(ctx, open, 1);
      if (!clean) { drawPreview(open); drawHandles(); }
    }

    const total = sch.total / 1000;
    const now = playing ? Math.min(playT, sch.total) / 1000 : total;
    const pts = strokes.reduce((n, s) => n + s.pts.length, 0);
    const txt = strokes.length
      ? `획 ${strokes.length} · 점 ${pts} · ${now.toFixed(1)} / ${total.toFixed(1)}s`
      : '';
    // Writing textContent every frame is a layout invalidation for a string
    // that changes ten times a second at most.
    if (txt !== lastStatus) { statusEl.textContent = txt; lastStatus = txt; }
  }

  // The bake is already premultiplied, so source-over here is dst*(1-a) + src:
  // a full-alpha core replaces, a low-alpha glow halo blends. That is the same
  // result 'lighter' gave over a dark chart (and exactly the same over pure
  // black, which is what actually gets recorded), but it also lets an opaque
  // sticker cover what is under it instead of the chart adding through it.
  function blitPlate() {
    syncPlate();
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(plate, 0, 0, plate.width, plate.height, 0, 0, CW, CH);
    ctx.restore();
  }

  function frame(now) {
    // Nothing to compute on an idle frame; schedule() allocates per stroke.
    if (!(playing || recording || dirty)) { requestAnimationFrame(frame); return; }
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
    if (playing || recording || dirty) {
      render(sch);
      dirty = false;
      if (recording) recFrames++;
    }
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
      plate.width = bw; plate.height = bh;
    }
    // Setting .width resets context state, so the transform is re-applied here.
    const sx = bw / CW, sy = bh / CH;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    bctx.setTransform(sx, 0, 0, sy, 0, 0);
    pctx.setTransform(sx, 0, 0, sy, 0, 0);
    invalidateBake();
  }

  function syncDock() {
    document.documentElement.style.setProperty('--bar-h', $('dock').offsetHeight + 'px');
    layout();
  }

  function layout() {
    const pad = clean ? 0 : 28;
    const aw = Math.max(1, stage.clientWidth - pad);
    const ah = Math.max(1, stage.clientHeight - pad);
    const s = Math.min(aw / CW, ah / CH);
    const cssW = Math.floor(CW * s);
    cv.style.width = cssW + 'px';
    cv.style.height = Math.floor(CH * s) + 'px';
    cvRect = null;

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
    plateDirty = true;
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
  // Cached: reading getBoundingClientRect on every pointermove forces a layout
  // flush, and a drag fires it 60 times a second. Invalidated on resize.
  let cvRect = null;
  function canvasRect() {
    if (!cvRect) cvRect = cv.getBoundingClientRect();
    return cvRect;
  }

  function toCanvas(e) {
    const r = canvasRect();
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
      glow: opt.glow, arrow: opt.arrow, open: true,
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
    editedStroke(s);
    $('hint').hidden = true;   // drawing started; stop advertising the drop target
    // A box or circle is fully defined by two corners, so it closes itself and
    // the next tap starts a new one.
    if (isTwoPoint(s) && s.pts.length === 2) { s.open = false; hover = null; }
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

    if (gesture && pointers.size >= 2) { applyGesture(); plateDirty = true; touch(); return; }
    if (panning) { bg.ox = x - panning.x; bg.oy = y - panning.y; plateDirty = true; touch(); return; }

    if (drag) {
      const s = strokes[drag.si];
      const prev = drag.pi > 0 ? s.pts[drag.pi - 1] : null;
      const p = snap(prev, x, y, e.shiftKey, s.kind);
      s.pts[drag.pi] = { u: p.x / CW, v: p.y / CH };
      editedStroke(s);
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
    plateDirty = true;
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
    if (s.pts.length > 1) { s.pts.pop(); editedStroke(s); } else strokes.pop();
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
    preroll = false;
    setPlayingUI(true);
    $('btn-play').classList.add('on');
  }

  function startRec() {
    if (recording) return;
    endStroke();
    if (!strokes.length) return;
    if (!cv.captureStream || typeof MediaRecorder === 'undefined') {
      alert('이 브라우저는 캔버스 녹화를 지원하지 않습니다. 데스크톱 Chrome을 쓰거나 화면 녹화로 대신하세요.');
      return;
    }
    // Prefer mp4, but only when H.264 is named explicitly. iOS cannot play webm
    // — that is why a recording made here opened in neither Photos nor the
    // editor. The trap is that bare 'video/mp4' also reports as supported on
    // Chromium and yields VP9 inside an mp4 wrapper (ftyp brands isom/iso6/
    // iso2/vp09, no avcC box), which iOS rejects just the same while the .mp4
    // extension hides why. So: explicit H.264 mp4, else honest webm, and bare
    // mp4 only as a last resort for Safari, where it really is H.264.
    const types = [
      'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4;codecs=h264',
      'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
      'video/mp4',
    ];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) { alert('이 브라우저는 캔버스 녹화를 지원하지 않습니다. 화면 녹화를 사용하세요.'); return; }
    chunks = [];
    // The displayed size drives RES, so on a small window the backing store —
    // and therefore the recording — would sit below the authored 1080. Force it
    // up for the duration; layout() restores it when recording ends.
    if (RES < 1) { RES = 1; sizeCanvases(); }

    // captureStream grabs whatever is on the canvas the instant it is created,
    // and that is still the finished drawing from editing — which is how a
    // completed frame ended up at the head of every recording. Paint the t=0
    // frame first, synchronously, then attach.
    recording = true;
    preroll = true;
    playT = 0;
    invalidateBake();
    render(schedule());

    // Keep our own reference to the stream: if only the MediaRecorder holds it,
    // the capture track can be collected mid-recording and the file comes out
    // with zero frames.
    // The render loop is driven by requestAnimationFrame, so it already produces
    // a new frame every display refresh — asking the capture track for 60 is
    // what turns that into a 60fps file rather than the browser's 30fps default.
    // Bitrate scales with it: 16Mbps spread over twice the frames is where a
    // neon gradient starts to band.
    stream = cv.captureStream(opt.fps);
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: opt.fps >= 60 ? 26e6 : 16e6,
    });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      // recorder.mimeType is what was actually negotiated, which can differ
      // from the request — name the file after that, never after the guess.
      const actual = (recorder && recorder.mimeType) || mime;
      const ext = /mp4/.test(actual) ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: 'video/' + ext });
      if (blob.size < 2000) {
        // Header-only file: the encoder produced no frames (usually a machine
        // with no GPU video encoding). Better to say so than to hand over a
        // webm that opens as a black rectangle.
        alert('녹화된 프레임이 없습니다. 이 PC에서 캔버스 녹화가 동작하지 않는 것 같습니다 — 속도를 늦춰 다시 시도하거나 화면 녹화를 사용하세요.');
        recorder = null; chunks = null; releaseStream();
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName() + '.' + ext;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      recorder = null; chunks = null; releaseStream();
    };
    $('btn-rec').classList.add('on');
    recFrames = 0; recT0 = performance.now();
    $('recinfo').textContent = '녹화 중…';
    recorder.start(250);   // chunked: without a timeslice some builds emit an empty blob
    play();
  }

  // Every export used to be neon-<epoch>, which is unreadable once a dozen of
  // them sit in an editor's media bin. iOS has no save-as dialog (the File
  // System Access API is Chrome-desktop only), so the name is chosen here.
  function fileName() {
    const raw = ($('fname').value || '').trim().replace(/[\\/:*?"<>|]+/g, '').slice(0, 60);
    return raw || 'neon-' + Date.now();
  }

  // A canvas capture track stays live after the recorder stops and keeps the
  // compositor pulling frames; drop it explicitly.
  function releaseStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function stopRec() {
    if (!recording) return;
    recording = false;
    // What the canvas actually managed, not what was asked for. 60fps is a
    // request to the capture track; whether the device kept up is a different
    // question, and this is the only honest way to answer it on the device
    // rather than guessing from a desktop.
    const secs = (performance.now() - recT0) / 1000;
    if (secs > 0.3) {
      const got = recFrames / secs;
      $('recinfo').textContent = '실측 ' + got.toFixed(0) + 'fps / 요청 ' + opt.fps + 'fps'
        + (got < opt.fps * 0.8 ? ' — 굵기·글로우를 낮추거나 30fps로' : ' ✓');
    }
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
    // Clean mode is the capture view, so it shows the frame the animation
    // starts from — not the finished drawing left over from editing. That
    // leftover is what put a fully-drawn frame at the head of a recording.
    preroll = on;
    if (on) { playT = 0; invalidateBake(); }
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

  const SW_NAMES = ['빨강', '노랑', '초록', '파랑', '분홍'];

  function buildSwatches() {
    const wrap = $('swatches');
    COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'sw';
      b.style.color = c;
      b.dataset.color = c;
      b.title = SW_NAMES[i] + ' (' + (i + 1) + ') — 화살표 도구에서는 이 색 화살표';
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

    slider('width', 'width', (v) => String(v), invalidateBake);
    slider('glow', 'glow', (v) => v.toFixed(1), invalidateBake);
    slider('speed', 'speed', (v) => String(v));
    slider('gap', 'gap', (v) => String(v));

    $('ratio').addEventListener('change', (e) => setRatio(e.target.value));
    $('fps').addEventListener('change', (e) => { opt.fps = Number(e.target.value); });
    $('btn-img').onclick = () => $('file').click();
    $('file').onchange = (e) => loadFile(e.target.files[0]);
    $('btn-end').onclick = endStroke;
    $('btn-undo').onclick = undo;
    $('btn-clear').onclick = clearAll;
    $('btn-play').onclick = play;
    $('btn-rec').onclick = () => (recording ? stopRec() : startRec());
    $('btn-clean').onclick = () => setClean(!clean);
    $('btn-exit').onclick = () => setClean(false);
    $('btn-more').onclick = () => {
      const el = $('settings');
      el.hidden = !el.hidden;
      $('btn-more').classList.toggle('on', !el.hidden);
      // The ResizeObserver would catch this a frame later, and for that one
      // frame the canvas is still sized for the closed dock and overlaps it.
      syncDock();
    };
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
    if (window.ResizeObserver) new ResizeObserver(syncDock).observe($('dock'));

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
      if (k >= '1' && k <= String(COLORS.length)) { pickColor(Number(k) - 1); return; }
      switch (k) {
        case 'q': case 'Q': setKind('line'); break;
        case 'w': case 'W': setKind('circle'); break;
        case 'e': case 'E': setKind('ellipse'); break;
        case 'r': case 'R': setKind('rect'); break;
        case 't': case 'T': setKind('img'); break;
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
