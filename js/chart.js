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

  class Chart {
    constructor(container) {
      this.chart = LightweightCharts.createChart(container, {
        layout: {
          background: { color: '#17181e' },
          textColor: '#b7bdc6',
          fontFamily: "'Trebuchet MS', Roboto, Ubuntu, sans-serif",
          fontSize: 12,
        },
        grid: {
          vertLines: { color: '#20232b' },
          horzLines: { color: '#20232b' },
        },
        rightPriceScale: {
          borderColor: '#2a2d35',
          scaleMargins: { top: 0.12, bottom: 0.12 },
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
        // TradingView-style faint symbol watermark in the background.
        watermark: {
          visible: true,
          text: '',
          color: 'rgba(120, 123, 134, 0.10)',
          fontSize: 44,
          fontFamily: "'Trebuchet MS', Roboto, sans-serif",
          horzAlign: 'center',
          vertAlign: 'center',
        },
        autoSize: true,
      });

      // A provider lets the app override the autoscale price range (used for
      // smooth, eased vertical zoom when "Focus" is on). Returns null = default.
      this.priceRangeProvider = null;

      this.series = this.chart.addCandlestickSeries({
        upColor: '#20b26c',
        downColor: '#ef454a',
        borderUpColor: '#20b26c',
        borderDownColor: '#ef454a',
        wickUpColor: '#20b26c',
        wickDownColor: '#ef454a',
        // Dashed current-price line + axis label.
        priceLineVisible: true,
        priceLineWidth: 1,
        priceLineStyle: LightweightCharts.LineStyle.Dashed,
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
      const label = (isLong ? 'Long' : 'Short') +
        (size != null ? ' ' + (Math.abs(size) >= 1 ? size.toFixed(2) : size.toFixed(3)) : '');
      this.entryLine = this.series.createPriceLine({
        price,
        color: isLong ? '#20b26c' : '#ef454a',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: label,
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
          upper: this._mkLine('#5a9cf8', 1),
          lower: this._mkLine('#5a9cf8', 1),
          mid: this._mkLine('#e3b341', 1),
          fill: new FillPrimitive('rgba(90,156,248,0.06)', 'rgba(90,156,248,0.06)'),
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

    renderIchimoku(data) {
      if (!this.ichi) {
        this.ichi = {
          tenkan: this._mkLine('#2962ff', 1),   // conversion
          kijun: this._mkLine('#d13d47', 1),    // base
          spanA: this._mkLine('#43a047', 1),    // leading A
          spanB: this._mkLine('#ef5350', 1),    // leading B
          chikou: this._mkLine('#8e6fd8', 1),   // lagging
          cloud: new FillPrimitive('rgba(76,175,80,0.13)', 'rgba(239,83,80,0.13)'),
        };
        this.series.attachPrimitive(this.ichi.cloud);
      }
      this.ichi.tenkan.setData(data.tenkan);
      this.ichi.kijun.setData(data.kijun);
      this.ichi.spanA.setData(data.spanA);
      this.ichi.spanB.setData(data.spanB);
      this.ichi.chikou.setData(data.chikou);
      this.ichi.cloud.setData(data.cloud);
    }
    clearIchimoku() {
      if (!this.ichi) return;
      this.series.detachPrimitive(this.ichi.cloud);
      ['tenkan', 'kijun', 'spanA', 'spanB', 'chikou'].forEach((k) => this.chart.removeSeries(this.ichi[k]));
      this.ichi = null;
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

    setWatermark(text) {
      this.chart.applyOptions({ watermark: { visible: !!text, text: text || '' } });
    }

    // Pixel helpers for HTML overlays (legend / candle-close countdown).
    priceToY(price) { return this.series.priceToCoordinate(price); }
    priceScaleWidth() { return this.chart.priceScale('right').width(); }
    resize() { /* autoSize handles it; kept for explicit calls */ }
  }

  global.ChartWrap = Chart;
})(window);
