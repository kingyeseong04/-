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

      this.series = this.chart.addCandlestickSeries({
        upColor: '#089981',
        downColor: '#f23645',
        borderUpColor: '#089981',
        borderDownColor: '#f23645',
        wickUpColor: '#089981',
        wickDownColor: '#f23645',
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
  }

  global.ChartWrap = Chart;
})(window);
