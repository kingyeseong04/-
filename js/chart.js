// chart.js
// Thin wrapper around lightweight-charts: a candlestick series whose last
// candle "forms" live as ticks arrive, plus entry / liquidation price lines.

(function (global) {
  'use strict';

  class Chart {
    constructor(container) {
      this.chart = LightweightCharts.createChart(container, {
        layout: {
          background: { color: '#131722' },
          textColor: '#d1d4dc',
          fontFamily: "'Trebuchet MS', Roboto, Ubuntu, sans-serif",
        },
        grid: {
          vertLines: { color: '#1e222d' },
          horzLines: { color: '#1e222d' },
        },
        rightPriceScale: { borderColor: '#2a2e39' },
        timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: { color: '#9598a1', width: 1, style: 3, labelBackgroundColor: '#363a45' },
          horzLine: { color: '#9598a1', width: 1, style: 3, labelBackgroundColor: '#363a45' },
        },
        autoSize: true,
      });

      // A provider lets the app override the autoscale price range (used for
      // smooth, eased vertical zoom when "Focus" is on). Returns null = default.
      this.priceRangeProvider = null;

      this.series = this.chart.addCandlestickSeries({
        upColor: '#089981',
        downColor: '#f23645',
        borderUpColor: '#089981',
        borderDownColor: '#f23645',
        wickUpColor: '#089981',
        wickDownColor: '#f23645',
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

    setEntryLine(price, side) {
      if (this.entryLine) { this.series.removePriceLine(this.entryLine); this.entryLine = null; }
      if (price == null) return;
      this.entryLine = this.series.createPriceLine({
        price,
        color: '#2962ff',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: (side || '') + ' entry',
      });
    }

    setLiqLine(price) {
      if (this.liqLine) { this.series.removePriceLine(this.liqLine); this.liqLine = null; }
      if (price == null) return;
      this.liqLine = this.series.createPriceLine({
        price,
        color: '#ff4d4f',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true,
        title: 'liq',
      });
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
  }

  global.ChartWrap = Chart;
})(window);
