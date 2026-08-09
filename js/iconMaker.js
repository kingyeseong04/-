/* Circle Icon Maker — 원형 아이콘 PNG 생성기
 *
 * 이미지(또는 텍스트/이모지)를 원형으로 마스킹하고, 깔끔한 배경을 깔아
 * 1080×1080 같은 정사각 PNG로 내보낸다.
 *
 * 렌더링은 크기(S)에 대해 완전히 비례하도록 작성해서, 미리보기와 내보내기가
 * 같은 함수 하나(render)를 공유한다.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- state
  const DEFAULTS = {
    source: 'image',        // 'image' | 'text'
    // text
    text: '⚗️',
    textFont: 'system',
    textColor: '#ffffff',
    textWeight: '700',
    textScale: 55,
    // background
    bgType: 'solid',        // 'none' | 'solid' | 'gradient'
    bgColor: '#2962ff',
    gradA: '#2962ff',
    gradB: '#00c2a8',
    gradAngle: 135,
    scope: 'circle',        // 'circle' | 'square'
    cornerRadius: 0,
    // background removal
    removeBg: false,
    tolerance: 18,
    feather: 2,
    keyColor: null,         // [r,g,b] | null(자동)
    // circle / placement
    padding: 0,
    zoom: 100,
    inset: 0,
    rotate: 0,
    offX: 0,
    offY: 0,
    fit: 'cover',           // 'cover' | 'contain'
    // ring / shadow
    ringWidth: 0,
    ringColor: '#ffffff',
    ringOpacity: 100,
    shadow: false,
    shadowStrength: 50,
  };

  const state = Object.assign({}, DEFAULTS, {
    img: null,          // 원본 HTMLImageElement / ImageBitmap 대용 캔버스
    processed: null,    // 배경 제거 결과 캔버스
    processedKey: '',   // 캐시 키
    pickMode: false,
    fileName: '',
  });

  const FONTS = {
    system: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif`,
    serif: `Georgia, 'Times New Roman', 'Noto Serif KR', serif`,
    mono: `'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace`,
    rounded: `'Trebuchet MS', 'Segoe UI', Verdana, sans-serif`,
  };

  const PRESETS = [
    { type: 'solid', color: '#2962ff' },
    { type: 'solid', color: '#111827' },
    { type: 'solid', color: '#ffffff' },
    { type: 'solid', color: '#f23645' },
    { type: 'solid', color: '#089981' },
    { type: 'solid', color: '#ffb020' },
    { type: 'solid', color: '#7c3aed' },
    { type: 'solid', color: '#f5f0e6' },
    { type: 'gradient', a: '#2962ff', b: '#00c2a8', angle: 135 },
    { type: 'gradient', a: '#7c3aed', b: '#ec4899', angle: 135 },
    { type: 'gradient', a: '#f97316', b: '#facc15', angle: 135 },
    { type: 'gradient', a: '#0ea5e9', b: '#1e3a8a', angle: 160 },
    { type: 'gradient', a: '#10b981', b: '#064e3b', angle: 135 },
    { type: 'gradient', a: '#f43f5e', b: '#7f1d1d', angle: 135 },
    { type: 'gradient', a: '#e5e7eb', b: '#9ca3af', angle: 135 },
    { type: 'gradient', a: '#1f2937', b: '#4b5563', angle: 135 },
  ];

  // ---------------------------------------------------------------- color utils
  function hexToRgb(hex) {
    const m = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  function withAlpha(hex, alpha) {
    const c = hexToRgb(hex) || [255, 255, 255];
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
  }

  // ================================================================ 배경 제거
  //
  // 가장자리에서 시작하는 flood fill 로, "테두리와 이어져 있으면서 기준 색과
  // 비슷한" 픽셀만 지운다. 로고 안쪽의 같은 색(예: 흰 글자)은 살아남는다.

  const MAX_SIDE = 1600; // 처리 비용 상한

  function toCanvas(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /** 네 모서리 패치 색 중 서로 가장 비슷한 것을 기준 색으로 고른다. */
  function autoKeyColor(data, w, h) {
    const patch = (px, py) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = py; y < py + 6 && y < h; y++) {
        for (let x = px; x < px + 6 && x < w; x++) {
          const i = (y * w + x) * 4;
          if (data[i + 3] < 8) continue;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      return n ? [r / n, g / n, b / n] : null;
    };
    const corners = [
      patch(0, 0), patch(w - 6, 0), patch(0, h - 6), patch(w - 6, h - 6),
    ].filter(Boolean);
    if (!corners.length) return [255, 255, 255];

    let best = corners[0], bestScore = -1;
    for (const c of corners) {
      let score = 0;
      for (const o of corners) if (dist(c, o) < 40) score++;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best.map(Math.round);
  }

  function dist(a, b) {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function removeBackground(srcCanvas, keyColor, tolerance, feather) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const ctx = srcCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    const key = keyColor || autoKeyColor(data, w, h);
    // 슬라이더 1~70 → 색 거리 임계값
    const tolHi = (tolerance / 70) * 220;
    const tolLo = tolHi * 0.6;

    const visited = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;

    const push = (idx) => {
      if (visited[idx]) return;
      const p = idx * 4;
      if (data[p + 3] === 0) { visited[idx] = 1; return; } // 이미 투명
      const d = dist([data[p], data[p + 1], data[p + 2]], key);
      if (d > tolHi) return;
      visited[idx] = 1;
      // 거리 비율에 따라 부드러운 알파
      const a = d <= tolLo ? 0 : (d - tolLo) / (tolHi - tolLo);
      data[p + 3] = Math.round(data[p + 3] * a);
      stack[sp++] = idx;
    };

    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w, y = (idx / w) | 0;
      if (x > 0) push(idx - 1);
      if (x < w - 1) push(idx + 1);
      if (y > 0) push(idx - w);
      if (y < h - 1) push(idx + w);
    }

    bleedEdgeColor(data, w, h, Math.max(1, feather + 1));
    if (feather > 0) blurAlpha(data, w, h, feather);

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').putImageData(imgData, 0, 0);
    return cropToContent(out);
  }

  /**
   * 반투명/투명해진 가장자리 픽셀의 RGB 를 이웃한 불투명 픽셀 색으로 채운다.
   * (알파만 깎으면 지워진 배경색이 테두리에 남아 후광처럼 보인다)
   */
  function bleedEdgeColor(data, w, h, passes) {
    const filled = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] >= 250) filled[i] = 1;

    for (let pass = 0; pass < passes; pass++) {
      const added = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (filled[idx]) continue;
          let r = 0, g = 0, b = 0, n = 0;
          if (x > 0 && filled[idx - 1]) { const p = (idx - 1) * 4; r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
          if (x < w - 1 && filled[idx + 1]) { const p = (idx + 1) * 4; r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
          if (y > 0 && filled[idx - w]) { const p = (idx - w) * 4; r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
          if (y < h - 1 && filled[idx + w]) { const p = (idx + w) * 4; r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
          if (!n) continue;
          const p = idx * 4;
          data[p] = r / n; data[p + 1] = g / n; data[p + 2] = b / n;
          added.push(idx);
        }
      }
      if (!added.length) break;
      for (const idx of added) filled[idx] = 1;
    }
  }

  /** 알파 채널만 박스 블러 (경계 부드럽게) */
  function blurAlpha(data, w, h, radius) {
    const n = w * h;
    const src = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) src[i] = data[i * 4 + 3];
    const tmp = new Uint8ClampedArray(n);

    // 가로
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          sum += src[row + xx]; cnt++;
        }
        tmp[row + x] = sum / cnt;
      }
    }
    // 세로
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let sum = 0, cnt = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= h) continue;
          sum += tmp[yy * w + x]; cnt++;
        }
        data[(y * w + x) * 4 + 3] = sum / cnt;
      }
    }
  }

  /** 불투명 영역의 바운딩 박스로 잘라내 피사체를 가운데 맞춘다. */
  function cropToContent(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return canvas; // 전부 지워졌으면 원본 유지
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    if (cw === w && ch === h) return canvas;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return out;
  }

  /**
   * 배경 제거는 큰 이미지에서 수십~수백 ms 가 걸리므로 슬라이더를 끄는 동안
   * 매 프레임 다시 계산하지 않는다. 직전 결과로 계속 그리다가, 입력이 멎으면
   * 새로 계산하고 한 번 더 렌더한다. (결과가 아직 없으면 즉시 계산)
   */
  let processTimer = 0;

  function processKey() {
    return [state.imgId, state.tolerance, state.feather, (state.keyColor || []).join(',')].join('|');
  }

  function runProcess() {
    const key = processKey();
    state.processed = removeBackground(toCanvas(state.img), state.keyColor, state.tolerance, state.feather);
    state.processedKey = key;
  }

  function ensureProcessed() {
    if (!state.img || !state.removeBg) return;
    if (state.processedKey === processKey() && state.processed) return;

    if (!state.processed) { runProcess(); return; } // 첫 계산은 바로
    clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      if (!state.img || !state.removeBg) return;
      runProcess();
      scheduleRender();
    }, 140);
  }

  function currentSource() {
    if (state.source !== 'image' || !state.img) return null;
    if (state.removeBg && !state.pickMode) {
      ensureProcessed();
      return state.processed || state.img;
    }
    return state.img;
  }

  // ================================================================ 렌더링
  function makePaint(ctx, S) {
    if (state.bgType === 'solid') return state.bgColor;
    if (state.bgType === 'gradient') {
      const rad = (state.gradAngle - 90) * Math.PI / 180;
      const cx = S / 2, cy = S / 2, half = S / 2 * Math.SQRT2;
      const g = ctx.createLinearGradient(
        cx - Math.cos(rad) * half, cy - Math.sin(rad) * half,
        cx + Math.cos(rad) * half, cy + Math.sin(rad) * half
      );
      g.addColorStop(0, state.gradA);
      g.addColorStop(1, state.gradB);
      return g;
    }
    return null;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render(ctx, S) {
    const hidePaint = state.pickMode; // 색 고르기 중엔 이미지만 보여준다
    const c = S / 2;
    const r = c * (1 - state.padding / 100);
    const paint = hidePaint ? null : makePaint(ctx, S);

    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // --- 배경 (전체 사각형)
    if (paint && state.scope === 'square') {
      ctx.save();
      ctx.fillStyle = paint;
      roundRectPath(ctx, 0, 0, S, S, S * state.cornerRadius / 100);
      ctx.fill();
      ctx.restore();
    }

    // --- 그림자 (원 실루엣)
    if (paint && state.shadow && state.scope === 'circle') {
      const k = state.shadowStrength / 100;
      ctx.save();
      ctx.shadowColor = `rgba(0, 0, 0, ${0.45 * k + 0.1})`;
      ctx.shadowBlur = S * 0.06 * k;
      ctx.shadowOffsetY = S * 0.022 * k;
      ctx.fillStyle = paint;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // --- 원 안쪽: 배경 + 내용
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.clip();

    if (paint && state.scope === 'circle') {
      ctx.fillStyle = paint;
      ctx.fillRect(0, 0, S, S);
    }

    if (state.source === 'text') {
      drawText(ctx, S, r);
    } else {
      drawImage(ctx, S, r);
    }
    ctx.restore();

    // --- 테두리
    if (state.ringWidth > 0 && state.ringOpacity > 0) {
      const lw = S * state.ringWidth / 100;
      ctx.save();
      ctx.strokeStyle = withAlpha(state.ringColor, state.ringOpacity / 100);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(c, c, Math.max(0.5, r - lw / 2), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawImage(ctx, S, r) {
    const src = currentSource();
    if (!src) return;
    const iw = src.naturalWidth || src.width;
    const ih = src.naturalHeight || src.height;
    if (!iw || !ih) return;

    const d = 2 * r * (1 - state.inset / 100);
    const base = state.fit === 'cover' ? d / Math.min(iw, ih) : d / Math.max(iw, ih);
    const s = base * (state.zoom / 100);

    ctx.save();
    ctx.translate(S / 2 + state.offX * S, S / 2 + state.offY * S);
    ctx.rotate(state.rotate * Math.PI / 180);
    ctx.drawImage(src, -iw * s / 2, -ih * s / 2, iw * s, ih * s);
    ctx.restore();
  }

  function drawText(ctx, S, r) {
    const t = state.text;
    if (!t) return;
    const d = 2 * r;
    const px = d * (state.textScale / 100);

    ctx.save();
    ctx.translate(S / 2 + state.offX * S, S / 2 + state.offY * S);
    ctx.rotate(state.rotate * Math.PI / 180);
    ctx.font = `${state.textWeight} ${px}px ${FONTS[state.textFont] || FONTS.system}`;
    ctx.fillStyle = state.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // 글자 실제 높이 기준으로 세로 중앙 정렬 (이모지 포함)
    const m = ctx.measureText(t);
    const asc = m.actualBoundingBoxAscent;
    const desc = m.actualBoundingBoxDescent;
    const dy = (Number.isFinite(asc) && Number.isFinite(desc)) ? (asc - desc) / 2 : px * 0.35;
    ctx.fillText(t, 0, dy);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 미리보기
  const preview = $('preview');
  const pctx = preview.getContext('2d');
  let rafId = 0;

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render(pctx, preview.width);
    });
  }

  function renderToCanvas(size) {
    // 내보내기는 항상 최신 배경 제거 결과로 (디바운스 대기 중이어도)
    if (state.img && state.removeBg && state.processedKey !== processKey()) {
      clearTimeout(processTimer);
      runProcess();
    }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    render(c.getContext('2d'), size);
    return c;
  }

  // ================================================================ UI 바인딩
  const els = {
    dropHint: $('drop-hint'),
    pickOverlay: $('pick-overlay'),
    canvasWrap: $('canvas-wrap'),
    fileName: $('file-name'),
    keySwatch: $('key-swatch'),
    sizeBadge: $('size-badge'),
    toast: $('toast'),
  };

  function syncVisibility() {
    document.querySelectorAll('[data-when]').forEach((el) => {
      el.hidden = el.dataset.when !== state.source;
    });
    document.querySelectorAll('[data-bgwhen]').forEach((el) => {
      el.hidden = !el.dataset.bgwhen.split(' ').includes(state.bgType);
    });
    document.querySelectorAll('[data-scopewhen]').forEach((el) => {
      el.hidden = el.dataset.scopewhen !== state.scope || state.bgType === 'none';
    });
    $('remove-opts').hidden = !state.removeBg;
    $('shadow-opts').hidden = !state.shadow;
    els.dropHint.hidden = !(state.source === 'image' && !state.img);
    els.pickOverlay.hidden = !state.pickMode;
    preview.classList.toggle('picking', state.pickMode);
  }

  function setSeg(container, attr, value) {
    container.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset[attr] === value);
    });
  }

  function bindSeg(id, attr, apply) {
    const box = $(id);
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      apply(btn.dataset[attr]);
      setSeg(box, attr, btn.dataset[attr]);
      syncVisibility();
      scheduleRender();
    });
  }

  /** range/number 입력 → state + 라벨 */
  function bindRange(id, key, roId, fmt) {
    const el = $(id);
    const ro = roId ? $(roId) : null;
    const update = () => {
      state[key] = parseFloat(el.value);
      if (ro) ro.textContent = fmt(state[key]);
      scheduleRender();
    };
    el.addEventListener('input', update);
    update();
  }

  function bindColor(id, key) {
    const el = $(id);
    el.addEventListener('input', () => {
      state[key] = el.value;
      if (id === 'bg-color') $('bg-hex').value = el.value.toUpperCase();
      scheduleRender();
    });
  }

  // --- 소스 전환
  bindSeg('seg-source', 'source', (v) => { state.source = v; });

  // --- 텍스트
  $('text-value').addEventListener('input', (e) => { state.text = e.target.value; scheduleRender(); });
  $('text-font').addEventListener('change', (e) => { state.textFont = e.target.value; scheduleRender(); });
  $('text-weight').addEventListener('change', (e) => { state.textWeight = e.target.value; scheduleRender(); });
  bindColor('text-color', 'textColor');
  bindRange('text-scale', 'textScale', 'text-scale-ro', (v) => `${v}%`);

  // --- 배경
  bindSeg('seg-bg', 'bg', (v) => { state.bgType = v; });
  bindSeg('seg-scope', 'scope', (v) => { state.scope = v; });
  bindColor('bg-color', 'bgColor');
  bindColor('grad-a', 'gradA');
  bindColor('grad-b', 'gradB');
  bindRange('grad-angle', 'gradAngle', 'grad-angle-ro', (v) => `${v}°`);
  bindRange('corner-radius', 'cornerRadius', 'corner-ro', (v) => `${v}%`);

  $('bg-hex').addEventListener('input', (e) => {
    const rgb = hexToRgb(e.target.value);
    if (!rgb) return;
    const hex = rgbToHex(...rgb);
    state.bgColor = hex;
    $('bg-color').value = hex.toLowerCase();
    scheduleRender();
  });

  // 프리셋 스와치
  (function buildPresets() {
    const box = $('bg-presets');
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = p.type === 'solid'
        ? p.color
        : `linear-gradient(${p.angle}deg, ${p.a}, ${p.b})`;
      b.title = p.type === 'solid' ? p.color.toUpperCase() : `${p.a} → ${p.b}`;
      b.addEventListener('click', () => {
        if (p.type === 'solid') {
          state.bgType = 'solid';
          state.bgColor = p.color;
          $('bg-color').value = p.color;
          $('bg-hex').value = p.color.toUpperCase();
        } else {
          state.bgType = 'gradient';
          state.gradA = p.a; state.gradB = p.b; state.gradAngle = p.angle;
          $('grad-a').value = p.a;
          $('grad-b').value = p.b;
          $('grad-angle').value = p.angle;
          $('grad-angle-ro').textContent = `${p.angle}°`;
        }
        setSeg($('seg-bg'), 'bg', state.bgType);
        syncVisibility();
        scheduleRender();
      });
      box.appendChild(b);
    });
  })();

  // --- 배경 제거
  $('remove-bg').addEventListener('change', (e) => {
    state.removeBg = e.target.checked;
    syncVisibility();
    scheduleRender();
  });
  bindRange('remove-tol', 'tolerance', 'remove-tol-ro', (v) => String(v));
  bindRange('remove-feather', 'feather', 'remove-feather-ro', (v) => `${v}px`);

  $('btn-auto-key').addEventListener('click', () => {
    state.keyColor = null;
    updateKeySwatch();
    scheduleRender();
  });
  $('btn-pick-key').addEventListener('click', () => {
    if (!state.img) return toast('먼저 이미지를 불러오세요.', true);
    state.pickMode = true;
    syncVisibility();
    scheduleRender();
  });

  function updateKeySwatch() {
    els.keySwatch.style.background = state.keyColor
      ? rgbToHex(...state.keyColor)
      : 'repeating-linear-gradient(45deg, #444 0 6px, #666 6px 12px)';
    els.keySwatch.title = state.keyColor ? rgbToHex(...state.keyColor) : '자동';
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.pickMode) {
      state.pickMode = false;
      syncVisibility();
      scheduleRender();
    }
  });

  // --- 원/배치
  bindRange('padding', 'padding', 'padding-ro', (v) => `${v}%`);
  bindRange('zoom', 'zoom', 'zoom-ro', (v) => `${v}%`);
  bindRange('inset', 'inset', 'inset-ro', (v) => `${v}%`);
  bindRange('rotate', 'rotate', 'rotate-ro', (v) => `${v}°`);

  $('btn-cover').addEventListener('click', () => { state.fit = 'cover'; resetTransform(); });
  $('btn-contain').addEventListener('click', () => { state.fit = 'contain'; resetTransform(); });
  $('btn-center').addEventListener('click', () => { state.offX = 0; state.offY = 0; scheduleRender(); });

  function resetTransform() {
    state.offX = 0; state.offY = 0; state.zoom = 100;
    $('zoom').value = 100;
    $('zoom-ro').textContent = '100%';
    scheduleRender();
  }

  // --- 테두리/그림자
  bindRange('ring-width', 'ringWidth', 'ring-ro', (v) => `${v}%`);
  bindRange('ring-opacity', 'ringOpacity', 'ring-op-ro', (v) => `${v}%`);
  bindColor('ring-color', 'ringColor');
  $('shadow').addEventListener('change', (e) => {
    state.shadow = e.target.checked;
    syncVisibility();
    scheduleRender();
  });
  bindRange('shadow-strength', 'shadowStrength', 'shadow-ro', (v) => `${v}%`);

  // ---------------------------------------------------------------- 파일 입력
  const fileInput = $('file-input');
  $('btn-file').addEventListener('click', () => fileInput.click());
  els.dropHint.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
  });

  function loadFile(file) {
    if (!file.type.startsWith('image/')) return toast('이미지 파일만 불러올 수 있어요.', true);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.img = img;
      state.imgId = (state.imgId || 0) + 1;
      state.processed = null;
      state.processedKey = '';
      state.keyColor = null;
      state.source = 'image';
      setSeg($('seg-source'), 'source', 'image');
      state.fileName = file.name;
      els.fileName.textContent = `${file.name} · ${img.naturalWidth}×${img.naturalHeight}`;
      const base = file.name.replace(/\.[^.]+$/, '').replace(/[^\w가-힣ㄱ-ㅎ.\-]+/g, '-').slice(0, 40);
      if (base) $('file-base').value = base;
      resetTransform();
      updateKeySwatch();
      syncVisibility();
      scheduleRender();
    };
    img.onerror = () => toast('이미지를 읽지 못했습니다.', true);
    img.src = url;
  }

  // 드래그 앤 드롭
  const stage = $('stage');
  ['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => {
    e.preventDefault();
    els.canvasWrap.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && stage.contains(e.relatedTarget)) return;
    els.canvasWrap.classList.remove('dragover');
  }));
  stage.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // 붙여넣기
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { loadFile(f); e.preventDefault(); }
        return;
      }
    }
  });

  // ---------------------------------------------------------------- 캔버스 조작
  let dragging = false, lastX = 0, lastY = 0, pid = null;

  preview.addEventListener('pointerdown', (e) => {
    if (state.pickMode) { pickColorAt(e); return; }
    dragging = true; pid = e.pointerId;
    lastX = e.clientX; lastY = e.clientY;
    preview.setPointerCapture(pid);
    preview.classList.add('grabbing');
  });
  preview.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = preview.getBoundingClientRect();
    state.offX = clamp(state.offX + (e.clientX - lastX) / rect.width, -1, 1);
    state.offY = clamp(state.offY + (e.clientY - lastY) / rect.height, -1, 1);
    lastX = e.clientX; lastY = e.clientY;
    scheduleRender();
  });
  ['pointerup', 'pointercancel'].forEach((ev) => preview.addEventListener(ev, () => {
    dragging = false;
    preview.classList.remove('grabbing');
  }));

  preview.addEventListener('wheel', (e) => {
    if (state.source !== 'image' && state.source !== 'text') return;
    e.preventDefault();
    const key = state.source === 'text' ? 'textScale' : 'zoom';
    const el = state.source === 'text' ? $('text-scale') : $('zoom');
    const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    const min = parseFloat(el.min), max = parseFloat(el.max);
    state[key] = clamp(state[key] * factor, min, max);
    el.value = state[key];
    $(state.source === 'text' ? 'text-scale-ro' : 'zoom-ro').textContent = `${Math.round(state[key])}%`;
    scheduleRender();
  }, { passive: false });

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function pickColorAt(e) {
    const rect = preview.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) / rect.width * preview.width);
    const y = Math.round((e.clientY - rect.top) / rect.height * preview.height);
    const d = pctx.getImageData(clamp(x, 0, preview.width - 1), clamp(y, 0, preview.height - 1), 1, 1).data;
    if (d[3] < 8) return toast('그 위치엔 이미지가 없어요.', true);
    state.keyColor = [d[0], d[1], d[2]];
    state.processedKey = '';
    state.pickMode = false;
    if (!state.removeBg) {
      state.removeBg = true;
      $('remove-bg').checked = true;
    }
    updateKeySwatch();
    syncVisibility();
    scheduleRender();
  }

  // ---------------------------------------------------------------- 내보내기
  const sizeSel = $('export-size');
  const sizeCustom = $('export-custom');

  function exportSize() {
    if (sizeSel.value === 'custom') {
      return clamp(Math.round(parseInt(sizeCustom.value, 10) || 1080), 16, 4096);
    }
    return parseInt(sizeSel.value, 10);
  }
  function syncSizeBadge() {
    const s = exportSize();
    els.sizeBadge.textContent = `${s} × ${s} px`;
  }
  sizeSel.addEventListener('change', () => {
    sizeCustom.disabled = sizeSel.value !== 'custom';
    if (sizeSel.value !== 'custom') sizeCustom.value = sizeSel.value;
    syncSizeBadge();
  });
  sizeCustom.addEventListener('input', syncSizeBadge);

  function baseName() {
    const v = $('file-base').value.trim();
    return v || 'icon';
  }

  function download(canvas, name) {
    canvas.toBlob((blob) => {
      if (!blob) return toast('PNG 생성에 실패했습니다.', true);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  }

  $('btn-download').addEventListener('click', () => {
    const s = exportSize();
    download(renderToCanvas(s), `${baseName()}-${s}.png`);
    toast(`${s}×${s} PNG 저장됨`);
  });

  $('btn-pack').addEventListener('click', () => {
    const sizes = [1080, 512, 256, 192];
    sizes.forEach((s, i) => {
      setTimeout(() => download(renderToCanvas(s), `${baseName()}-${s}.png`), i * 350);
    });
    toast(`${sizes.join(' · ')} px 4개 저장 중…`);
  });

  $('btn-copy').addEventListener('click', async () => {
    const s = exportSize();
    const canvas = renderToCanvas(s);
    try {
      if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
        throw new Error('unsupported');
      }
      const blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('클립보드에 복사됨');
    } catch (err) {
      toast('이 브라우저에선 복사가 안 돼요. 다운로드를 쓰세요.', true);
    }
  });

  let toastTimer = 0;
  function toast(msg, isErr) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('err', !!isErr);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------------- 초기화
  $('btn-reset').addEventListener('click', () => {
    Object.assign(state, DEFAULTS, { img: null, processed: null, processedKey: '', pickMode: false });
    // 컨트롤 값 복원
    $('text-value').value = DEFAULTS.text;
    $('text-font').value = DEFAULTS.textFont;
    $('text-weight').value = DEFAULTS.textWeight;
    $('text-color').value = DEFAULTS.textColor;
    $('bg-color').value = DEFAULTS.bgColor;
    $('bg-hex').value = DEFAULTS.bgColor.toUpperCase();
    $('grad-a').value = DEFAULTS.gradA;
    $('grad-b').value = DEFAULTS.gradB;
    $('ring-color').value = DEFAULTS.ringColor;
    $('remove-bg').checked = false;
    $('shadow').checked = false;
    $('file-base').value = 'icon';
    els.fileName.textContent = '선택된 파일 없음';
    fileInput.value = '';
    sizeSel.value = '1080';
    sizeCustom.value = '1080';
    sizeCustom.disabled = true;
    syncSizeBadge();
    [['text-scale', 'textScale'], ['grad-angle', 'gradAngle'], ['corner-radius', 'cornerRadius'],
     ['remove-tol', 'tolerance'], ['remove-feather', 'feather'], ['padding', 'padding'],
     ['zoom', 'zoom'], ['inset', 'inset'], ['rotate', 'rotate'], ['ring-width', 'ringWidth'],
     ['ring-opacity', 'ringOpacity'], ['shadow-strength', 'shadowStrength']
    ].forEach(([id, key]) => {
      const el = $(id);
      el.value = DEFAULTS[key];
      el.dispatchEvent(new Event('input'));
    });
    setSeg($('seg-source'), 'source', DEFAULTS.source);
    setSeg($('seg-bg'), 'bg', DEFAULTS.bgType);
    setSeg($('seg-scope'), 'scope', DEFAULTS.scope);
    updateKeySwatch();
    syncVisibility();
    scheduleRender();
  });

  updateKeySwatch();
  syncSizeBadge();
  syncVisibility();
  scheduleRender();
})();
