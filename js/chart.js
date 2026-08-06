// chart.js
// Thin wrapper around lightweight-charts: a candlestick series whose last
// candle "forms" live as ticks arrive, plus entry / liquidation price lines.

(function (global) {
  'use strict';

  // ---- Fill primitive: shades the area between two price series (used for the
  // Bollinger band fill and the Ichimoku cloud). Colour can differ per segment
  // based on whether a >= b (green cloud) or a < b (red cloud). ----
  class FillRenderer {
    constructor(points, colUp, colDn) { this._p = points; this._cu = colUp; this._cd = colDn; }
    draw(target) {
      const pts = this._p;
      if (!pts || pts.length < 2) return;
      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i], p1 = pts[i + 1];
          ctx.beginPath();
          ctx.moveTo(p0.x * hr, p0.ya * vr);
          ctx.lineTo(p1.x * hr, p1.ya * vr);
          ctx.lineTo(p1.x * hr, p1.yb * vr);
          ctx.lineTo(p0.x * hr, p0.yb * vr);
          ctx.closePath();
          ctx.fillStyle = p0.up ? this._cu : this._cd;
          ctx.fill();
        }
      });
    }
  }
  class FillPaneView {
    constructor(src) { this._src = src; this._points = []; }
    update() {
      const s = this._src;
      const ts = s._chart && s._chart.timeScale();
      const series = s._series;
      if (!ts || !series) { this._points = []; return; }
      this._points = [];
      for (const d of s._data) {
        const x = ts.timeToCoordinate(d.time);
        const ya = series.priceToCoordinate(d.a);
        const yb = series.priceToCoordinate(d.b);
        if (x == null || ya == null || yb == null) continue;
        this._points.push({ x, ya, yb, up: d.a >= d.b });
      }
    }
    renderer() { return new FillRenderer(this._points, this._src._colUp, this._src._colDn); }
    zOrder() { return 'bottom'; }
  }
  class FillPrimitive {
    constructor(colUp, colDn) {
      this._data = []; this._chart = null; this._series = null; this._requestUpdate = null;
      this._colUp = colUp; this._colDn = colDn;
      this._pv = new FillPaneView(this);
    }
    attached(p) { this._chart = p.chart; this._series = p.series; this._requestUpdate = p.requestUpdate; }
    detached() { this._chart = null; this._series = null; }
    setData(d) { this._data = d || []; if (this._requestUpdate) this._requestUpdate(); }
    updateAllViews() { this._pv.update(); }
    paneViews() { return [this._pv]; }
  }

  // ---- Horizontal dotted line at a price (TP / SL). Bybit's dotted line is a
  // sparse run of short dashes — measured ~3px dash + 4px gap — which the
  // lightweight-charts built-in LineStyle can't reproduce, so we draw it
  // ourselves and let a line-less price line supply the coloured axis tag. ----
  class HLineRenderer {
    constructor(y, color, width, dash) { this._y = y; this._c = color; this._w = width; this._dash = dash; }
    draw(target) {
      if (this._y == null) return;
      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        const y = Math.round(this._y * vr) + 0.5;
        ctx.save();
        ctx.strokeStyle = this._c;
        ctx.lineWidth = Math.max(1, this._w * vr);
        ctx.lineCap = 'butt';
        ctx.setLineDash([this._dash[0] * hr, this._dash[1] * hr]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(scope.bitmapSize.width, y);
        ctx.stroke();
        ctx.restore();
      });
    }
  }
  class HLinePaneView {
    constructor(src) { this._src = src; this._y = null; }
    update() {
      const s = this._src;
      this._y = (s._series && s._price != null) ? s._series.priceToCoordinate(s._price) : null;
    }
    renderer() { return new HLineRenderer(this._y, this._src._color, this._src._w, this._src._dash); }
    zOrder() { return 'top'; }
  }
  class HLinePrimitive {
    constructor(color, width, dash) {
      this._price = null; this._color = color; this._w = width; this._dash = dash;
      this._series = null; this._requestUpdate = null; this._pv = new HLinePaneView(this);
    }
    attached(p) { this._series = p.series; this._requestUpdate = p.requestUpdate; }
    detached() { this._series = null; }
    set(price, color) { this._price = price; if (color) this._color = color; if (this._requestUpdate) this._requestUpdate(); }
    updateAllViews() { this._pv.update(); }
    paneViews() { return [this._pv]; }
  }

  class Chart {
    constructor(container) {
      this.chart = LightweightCharts.createChart(container, {
        layout: {
          background: { color: '#101014' }, // Bybit chart background (sampled)
          textColor: '#8a8e99',
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
          fontSize: 12,
        },
        grid: {
          vertLines: { color: '#202124' },
          horzLines: { color: '#202124' },
        },
        rightPriceScale: {
          borderColor: '#2a2d35',
          scaleMargins: { top: 0.1, bottom: 0.1 },
        },
        timeScale: {
          borderColor: '#2a2d35',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4,
          barSpacing: 8,
          // Render axis ticks in the viewer's LOCAL timezone so bars line up
          // with TradingView (which shows local time), instead of UTC.
          tickMarkFormatter: (t, type) => {
            const d = new Date(t * 1000);
            const p = (n) => String(n).padStart(2, '0');
            // type: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds
            if (type === 0) return String(d.getFullYear());
            if (type === 1) return d.toLocaleString(undefined, { month: 'short' });
            if (type === 2) return (d.getMonth() + 1) + '/' + d.getDate();
            if (type === 4) return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
            return p(d.getHours()) + ':' + p(d.getMinutes());
          },
        },
        localization: {
          // Thousand-separated prices on the axis / labels, like Bybit.
          priceFormatter: (p) => {
            const a = Math.abs(p);
            const d = a >= 1 ? 2 : a >= 0.1 ? 4 : 6;
            return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
          },
          // Crosshair time label, also local time.
          timeFormatter: (t) => {
            const d = new Date(t * 1000);
            const p = (n) => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
              ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
          },
        },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: { color: '#9598a1', width: 1, style: 3, labelBackgroundColor: '#363a45' },
          horzLine: { color: '#9598a1', width: 1, style: 3, labelBackgroundColor: '#363a45' },
        },
        // Bybit's chart has no big symbol watermark.
        watermark: { visible: false, text: '' },
        autoSize: true,
      });

      // A provider lets the app override the autoscale price range (used for
      // smooth, eased vertical zoom when "Focus" is on). Returns null = default.
      this.priceRangeProvider = null;

      this.series = this.chart.addCandlestickSeries({
        upColor: '#20b26c',       // Bybit green (sampled from real chart)
        downColor: '#ef454a',     // Bybit red (sampled)
        borderUpColor: '#20b26c',
        borderDownColor: '#ef454a',
        wickUpColor: '#20b26c',
        wickDownColor: '#ef454a',
        // Bybit-style dotted current-price line + colored axis label.
        priceLineVisible: true,
        priceLineWidth: 1,
        priceLineStyle: LightweightCharts.LineStyle.Dotted,
        lastValueVisible: true,
        autoscaleInfoProvider: (original) => {
          const r = this.priceRangeProvider && this.priceRangeProvider();
          if (r && isFinite(r.min) && isFinite(r.max) && r.max > r.min) {
            return { priceRange: { minValue: r.min, maxValue: r.max } };
          }
          return original();
        },
      });

      this.entryLine = null;
      this.liqLine = null;

      // Custom dotted TP/SL lines (drawn by us for the exact Bybit dash rhythm).
      // Colour is set per position side when a line is shown.
      this.tpPrim = new HLinePrimitive('#ef454a', 1.4, [3, 4]);
      this.slPrim = new HLinePrimitive('#ef454a', 1.4, [3, 4]);
      this.series.attachPrimitive(this.tpPrim);
      this.series.attachPrimitive(this.slPrim);
    }

    // Render already-completed candles (the "past" before the playhead).
    setHistory(candles) {
      this.series.setData(candles.map(c => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
      })));
    }

    // Update (or create) the currently forming candle.
    updateCandle(c) {
      this.series.update({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
      });
    }

    // Bybit-style position line: solid line in the side colour (green long /
    // red short), with a left tag showing side + size and the entry price on
    // the axis.
    setEntryLine(price, side, size) {
      if (this.entryLine) { this.series.removePriceLine(this.entryLine); this.entryLine = null; }
      if (price == null) return;
      const isLong = side === 'long';
      // No left title — the HTML position label (P&L/size/×) sits on the line.
      // Bybit's position line uses a DARKER shade than the current-price line
      // (green #00944f / red #cc3939, sampled), distinct from candle/price color.
      this.entryLine = this.series.createPriceLine({
        price,
        color: isLong ? '#00944f' : '#cc3939',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: '',
      });
    }

    // TP/SL lines — Bybit tints them by the CLOSING order side, which is the
    // OPPOSITE of the position: a long is closed by selling (red), a short is
    // closed by buying (green). So a long's TP/SL are red, a short's are green.
    // The dotted line is our canvas primitive; a line-less price line supplies
    // the matching coloured axis tag.
    _tpslColor(side) { return side === 'long' ? '#ef454a' : '#20b26c'; }
    setTpLine(price, side) {
      const col = this._tpslColor(side);
      this.tpPrim.set(price, col);
      if (this.tpLine) { this.series.removePriceLine(this.tpLine); this.tpLine = null; }
      if (price == null) return;
      this.tpLine = this.series.createPriceLine({
        price, color: col, lineWidth: 1, lineVisible: false,
        axisLabelVisible: true, title: '',
      });
    }
    setSlLine(price, side) {
      const col = this._tpslColor(side);
      this.slPrim.set(price, col);
      if (this.slLine) { this.series.removePriceLine(this.slLine); this.slLine = null; }
      if (price == null) return;
      this.slLine = this.series.createPriceLine({
        price, color: col, lineWidth: 1, lineVisible: false,
        axisLabelVisible: true, title: '',
      });
    }

    // Resting limit order: a thin dashed line in the order side's colour
    // (buy/long green, sell/short red) with the price on the axis, like a
    // Bybit open order.
    setPendingLine(price, side) {
      if (this.pendingLine) { this.series.removePriceLine(this.pendingLine); this.pendingLine = null; }
      if (price == null) return;
      this.pendingLine = this.series.createPriceLine({
        price, color: side === 'long' ? '#20b26c' : '#ef454a', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'Limit',
      });
    }

    setLiqLine(price) {
      if (this.liqLine) { this.series.removePriceLine(this.liqLine); this.liqLine = null; }
      if (price == null) return;
      this.liqLine = this.series.createPriceLine({
        price,
        color: '#f7a600', // Bybit amber for liquidation
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Liq',
      });
    }

    // ---- Indicators ----
    _mkLine(color, width) {
      return this.chart.addLineSeries({
        color, lineWidth: width || 1,
        priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    }

    renderBollinger(data) {
      if (!this.bb) {
        this.bb = {
          upper: this._mkLine('#ef454a', 2), // Bybit/TV upper = red
          lower: this._mkLine('#22ab94', 2), // lower = green
          mid: this._mkLine('#2962ff', 2),   // basis = blue
          fill: new FillPrimitive('rgba(120,130,150,0.05)', 'rgba(120,130,150,0.05)'),
        };
        this.series.attachPrimitive(this.bb.fill);
      }
      this.bb.upper.setData(data.upper);
      this.bb.lower.setData(data.lower);
      this.bb.mid.setData(data.mid);
      this.bb.fill.setData(data.band);
    }
    clearBollinger() {
      if (!this.bb) return;
      this.series.detachPrimitive(this.bb.fill);
      this.chart.removeSeries(this.bb.upper);
      this.chart.removeSeries(this.bb.lower);
      this.chart.removeSeries(this.bb.mid);
      this.bb = null;
    }

    // Only the two leading spans (Senkou A/B) + the cloud between them.
    renderIchimoku(data) {
      if (!this.ichi) {
        this.ichi = {
          spanA: this._mkLine('#a5d6a7', 1),    // leading A (light green)
          spanB: this._mkLine('#ef9a9a', 1),    // leading B (light pink)
          cloud: new FillPrimitive('rgba(67,160,71,0.12)', 'rgba(244,67,54,0.12)'),
        };
        this.series.attachPrimitive(this.ichi.cloud);
      }
      this.ichi.spanA.setData(data.spanA);
      this.ichi.spanB.setData(data.spanB);
      this.ichi.cloud.setData(data.cloud);
    }
    clearIchimoku() {
      if (!this.ichi) return;
      this.series.detachPrimitive(this.ichi.cloud);
      ['spanA', 'spanB'].forEach((k) => this.chart.removeSeries(this.ichi[k]));
      this.ichi = null;
    }

    // Enable/disable mouse pan+zoom so the chart can be locked to the forming
    // candle (no drift when the mouse touches it — important for recording).
    setInteraction(enabled) {
      this.chart.applyOptions({ handleScroll: enabled, handleScale: enabled });
    }

    fitContent() { this.chart.timeScale().fitContent(); }
    scrollToRealTime() { this.chart.timeScale().scrollToRealTime(); }

    // Zoom/track: restrict the visible logical range to a few bars. With the
    // price axis on autoScale, this fits those bars' price range too, so the
    // forming candle appears large and the view "follows" it (motion-tracking).
    setVisibleLogicalRange(from, to) {
      this.chart.timeScale().setVisibleLogicalRange({ from, to });
    }

    // Register a callback returning { min, max } to drive the price-axis zoom,
    // or null to fall back to the default autoscale.
    setPriceRangeProvider(fn) { this.priceRangeProvider = fn; }

    setWatermark(_text) {
      // Bybit's chart shows no watermark — intentionally a no-op.
    }

    // Pixel helpers for HTML overlays (legend / countdown) and the draw layer.
    priceToY(price) { return this.series.priceToCoordinate(price); }
    yToPrice(y) { return this.series.coordinateToPrice(y); }
    timeToX(time) { return this.chart.timeScale().timeToCoordinate(time); }
    xToTime(x) { return this.chart.timeScale().coordinateToTime(x); }
    xToLogical(x) { return this.chart.timeScale().coordinateToLogical(x); }
    logicalToX(l) { return this.chart.timeScale().logicalToCoordinate(l); }
    subscribeRange(fn) { this.chart.timeScale().subscribeVisibleLogicalRangeChange(fn); }
    subscribeCrosshair(fn) { this.chart.subscribeCrosshairMove(fn); }
    priceScaleWidth() { return this.chart.priceScale('right').width(); }
    resize() { /* autoSize handles it; kept for explicit calls */ }
  }

  global.ChartWrap = Chart;
})(window);
