// paint.js — neon line annotation over a chart screenshot (paint.html).
//
// You drop in a chart capture, click points, and the points are joined in the
// order you clicked with a glowing neon line that draws itself on playback.
// Straight segments only — no curve fitting — which is what chart mark-up
// (support / resistance / breakout arrows) actually needs.
//
// The neon look is ADDITIVE, not a translucent marker: several blurred passes
// of the colour composited with 'lighter', then a near-white core on top. That
// is why a stroke reads as light emitted over the chart rather than ink laid on
// top of it, and why '배경끄기' + a Screen blend in an editor drops the black
// and keeps only the glow.
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
  let playing = false, playT = 0, playStart = 0;
  let recorder = null, chunks = null, stream = null, recording = false;
  let clean = false;

  const opt = { color: COLORS[1], width: 9, glow: 1, speed: 1400, gap: 250, arrow: false, ease: 'cubicOut' };

  // ---------------------------------------------------------------- geometry
  const px = (p) => ({ x: p.u * CW, y: p.v * CH });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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

  // Straighten a segment: Shift locks to horizontal / vertical / 45°, and an
  // un-shifted point that is already within a few px of level is nudged flat —
  // a support line that is 2px off looks wrong on video.
  function snap(prev, x, y, shift) {
    if (!prev) return { x, y };
    const a = px(prev);
    let dx = x - a.x, dy = y - a.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (shift) {
      if (ay < ax * 0.4142) dy = 0;              // within 22.5° of horizontal
      else if (ax < ay * 0.4142) dx = 0;         // within 22.5° of vertical
      else { const m = (ax + ay) / 2; dx = Math.sign(dx) * m; dy = Math.sign(dy) * m; }
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
      const dur = Math.max(90, (polyLen(s.pts) / opt.speed) * 1000);
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
  // Bloom is built from stacked strokes of the SAME path at increasing widths
  // and low alpha, composited additively — deliberately not shadowBlur/filter.
  // A halo this wide costs a ~100px blur kernel per pass, which stalls the
  // frame loop badly enough that MediaRecorder captures nothing; stacked
  // strokes give the same falloff for a fraction of the cost.
  // [width multiplier, alpha] — widest and faintest first.
  const HALO = [[7.0, 0.045], [5.0, 0.06], [3.4, 0.085], [2.3, 0.12], [1.6, 0.18], [1.0, 0.55]];

  function neon(g, path, color, width, glow) {
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = color;
    for (const [mul, alpha] of HALO) {
      // glow=0 collapses every pass onto the core width → a flat, solid line.
      g.lineWidth = width * (1 + (mul - 1) * glow);
      g.globalAlpha = alpha;
      g.stroke(path);
    }
    // One small blur softens the stepped edges of the stack; kept tight so it
    // stays cheap.
    g.shadowColor = color;
    g.shadowBlur = width * 1.6 * glow;
    g.lineWidth = width;
    g.globalAlpha = 0.5;
    g.stroke(path);

    g.shadowBlur = 0;
    g.globalAlpha = 1;
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1, width * 0.34);
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
    const pts = partial(s.pts, p);
    if (pts.length < 2) return;
    neon(g, linePath(pts), s.color, s.width, s.glow);
    if (s.arrow && p >= 1 && pts.length >= 2) {
      const n = pts.length;
      neon(g, arrowPath(pts[n - 2], pts[n - 1], Math.max(34, s.width * 5.5)), s.color, s.width, s.glow);
    }
  }

  function invalidateBake() {
    bakeIdx = 0;
    bctx.clearRect(0, 0, CW, CH);
  }

  function bakeUpTo(n) {
    while (bakeIdx < n) { paintStroke(bctx, strokes[bakeIdx], 1); bakeIdx++; }
  }

  function drawBackground() {
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CW, CH);
    if (img && !document.body.classList.contains('nobg')) {
      ctx.drawImage(img, bg.ox, bg.oy, img.width * bg.scale, img.height * bg.scale);
    }
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
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = s.open ? '#ffffff' : 'rgba(255,255,255,.55)';
        ctx.stroke();
        if (s.open) {
          ctx.fillStyle = 'rgba(255,255,255,.85)';
          ctx.fillText(String(i + 1), p.x, p.y - 20);
        }
      }
    }
    ctx.restore();
  }

  function render() {
    drawBackground();
    const sch = schedule();

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
      if (!clean) drawHandles();
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
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(bake, 0, 0);
    ctx.restore();
  }

  function frame(now) {
    if (playing) {
      playT = now - playStart;
      const total = schedule().total;
      if (playT >= total + (recording ? TAIL_MS : 500)) {
        playing = false;
        playT = total;
        if (recording) stopRec();
        $('btn-play').classList.remove('on');
      }
    }
    render();
    requestAnimationFrame(frame);
  }

  // ----------------------------------------------------------------- canvas
  function setRatio(key) {
    const [w, h] = RATIOS[key] || RATIOS['3:4'];
    CW = w; CH = h;
    cv.width = CW; cv.height = CH;
    bake.width = CW; bake.height = CH;
    invalidateBake();
    fitBg();
    layout();
  }

  function layout() {
    const pad = clean ? 0 : 28;
    const aw = Math.max(1, stage.clientWidth - pad);
    const ah = Math.max(1, stage.clientHeight - pad);
    const s = Math.min(aw / CW, ah / CH);
    cv.style.width = Math.floor(CW * s) + 'px';
    cv.style.height = Math.floor(CH * s) + 'px';
  }

  function fitBg() {
    if (!img) return;
    const s = Math.min(CW / img.width, CH / img.height);
    bg = { scale: s, ox: (CW - img.width * s) / 2, oy: (CH - img.height * s) / 2 };
  }

  function loadImage(src) {
    const im = new Image();
    im.onload = () => { img = im; fitBg(); $('hint').hidden = true; };
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

  function onDown(e) {
    if (playing) return;
    cv.setPointerCapture(e.pointerId);
    const { x, y } = toCanvas(e);

    if (e.altKey && img) { panning = { x: x - bg.ox, y: y - bg.oy }; return; }

    const hit = hitPoint(x, y);
    if (hit) { drag = hit; return; }

    let s = openStroke();
    if (!s) {
      s = { pts: [], color: opt.color, width: opt.width, glow: opt.glow, arrow: opt.arrow, ease: opt.ease, open: true };
      strokes.push(s);
    }
    const prev = s.pts[s.pts.length - 1];
    const p = snap(prev, x, y, e.shiftKey);
    // Swallow the second click of a double-click (and stray double taps).
    if (prev && Math.hypot(p.x - px(prev).x, p.y - px(prev).y) < DUP_PX) return;
    s.pts.push({ u: p.x / CW, v: p.y / CH });
    $('hint').hidden = true;   // drawing started; stop advertising the drop target
  }

  function onMove(e) {
    const { x, y } = toCanvas(e);
    if (panning) { bg.ox = x - panning.x; bg.oy = y - panning.y; return; }
    if (!drag) return;
    const s = strokes[drag.si];
    const prev = drag.pi > 0 ? s.pts[drag.pi - 1] : null;
    const p = snap(prev, x, y, e.shiftKey);
    s.pts[drag.pi] = { u: p.x / CW, v: p.y / CH };
    if (!s.open) invalidateBake();   // a baked stroke changed shape
  }

  function onUp(e) {
    try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null; panning = null;
  }

  function onWheel(e) {
    if (!img) return;
    e.preventDefault();
    const { x, y } = toCanvas(e);
    const ns = clamp(bg.scale * Math.exp(-e.deltaY * 0.0015), 0.05, 12);
    bg.ox = x - (x - bg.ox) * (ns / bg.scale);
    bg.oy = y - (y - bg.oy) * (ns / bg.scale);
    bg.scale = ns;
  }

  // ---------------------------------------------------------------- actions
  function endStroke() {
    const s = openStroke();
    if (!s) return;
    if (s.pts.length < 2) { strokes.pop(); return; }
    s.open = false;
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
    $('btn-play').classList.add('on');
  }

  function startRec() {
    if (recording || !strokes.length) return;
    if (!cv.captureStream || typeof MediaRecorder === 'undefined') {
      alert('이 브라우저는 캔버스 녹화를 지원하지 않습니다. 데스크톱 Chrome을 쓰거나 화면 녹화로 대신하세요.');
      return;
    }
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) { alert('이 브라우저에서 webm 녹화를 지원하지 않습니다.'); return; }
    chunks = [];
    // Keep our own reference to the stream: if only the MediaRecorder holds it,
    // the capture track can be collected mid-recording and the file comes out
    // with zero frames.
    stream = cv.captureStream(60);
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
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
      a.download = 'neon-' + Date.now() + '.webm';
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
    if (!fromFs) {
      const el = document.documentElement;
      if (on && el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
    layout();
    if (on) pokeExit();
  }

  // Bring the exit button back to full opacity, then let it fade again once
  // the pointer has been still for a moment.
  let exitTimer = 0;
  function pokeExit() {
    const b = $('btn-exit');
    b.classList.remove('idle');
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => { if (clean) b.classList.add('idle'); }, 2500);
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
      if (after) after();
    };
    el.addEventListener('input', sync);
    sync();
  }

  function init() {
    buildSwatches();
    selectColor(opt.color);
    setRatio('3:4');

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
    $('btn-bg').onclick = () => {
      document.body.classList.toggle('nobg');
      $('btn-bg').classList.toggle('on', document.body.classList.contains('nobg'));
    };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', endStroke);
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('resize', layout);

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
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const k = e.key;
      if (k >= '1' && k <= '3') { pickColor(Number(k) - 1); return; }
      switch (k) {
        case 'Enter': endStroke(); break;
        case 'Backspace': e.preventDefault(); undo(); break;
        case ' ': e.preventDefault(); play(); break;
        case '[': $('width').value = Math.max(2, opt.width - 1); $('width').dispatchEvent(new Event('input')); break;
        case ']': $('width').value = Math.min(28, opt.width + 1); $('width').dispatchEvent(new Event('input')); break;
        case '0': fitBg(); break;
        case 'r': case 'R': recording ? stopRec() : startRec(); break;
        case 'b': case 'B': $('btn-bg').click(); break;
        case 'f': case 'F': setClean(!clean); break;
        case 'Escape':
          if (!$('help').hidden) $('help').hidden = true;
          else if (clean) setClean(false);
          else if (playing) { playing = false; $('btn-play').classList.remove('on'); }
          else endStroke();
          break;
      }
    });

    requestAnimationFrame(frame);
  }

  init();
})();
