// trading.js
// A minimal perpetual-futures style trading account with net positioning,
// leverage, unrealized/realized PnL, fees and liquidation. Everything is
// recomputed on each tick so the UI can reflect live P&L.
//
// Conventions:
//   position.qty  : signed base-asset quantity (+ long, - short), 0 = flat
//   margin        : USDT locked as collateral for the open position (isolated)
//   balance       : realized wallet balance (only changes on close / fee)
//   equity        : balance + unrealized PnL
//   markPrice     : latest tick price

(function (global) {
  'use strict';

  const MMR = 0.05;       // maintenance margin rate (for liq price calc)
  const FEE_RATE = 0.0004; // 0.04% taker fee on notional

  class Account {
    constructor(startBalance) {
      this.startBalance = startBalance || 10000;
      this.reset();
    }

    reset() {
      this.balance = this.startBalance;
      this.qty = 0;          // signed base units
      this.avgEntry = 0;     // average entry price
      this.margin = 0;       // locked collateral for current position
      this.leverage = 1;     // effective leverage of current position
      this.markPrice = 0;
      this.liquidated = false;
      this.trades = [];      // closed-trade log
      this.realizedTotal = 0;
      this.feesTotal = 0;
    }

    get side() {
      return this.qty > 0 ? 'long' : this.qty < 0 ? 'short' : 'flat';
    }

    get notional() {
      return Math.abs(this.qty) * this.markPrice;
    }

    get unrealizedPnl() {
      if (this.qty === 0) return 0;
      return this.qty * (this.markPrice - this.avgEntry);
    }

    get unrealizedPnlPct() {
      if (this.qty === 0 || this.margin === 0) return 0;
      return (this.unrealizedPnl / this.margin) * 100;
    }

    get equity() {
      return this.balance + this.unrealizedPnl;
    }

    get available() {
      return this.equity - this.margin;
    }

    // Estimated isolated-margin liquidation price for the current position.
    get liquidationPrice() {
      if (this.qty === 0) return null;
      const q = Math.abs(this.qty);
      const room = (this.margin * (1 - MMR)) / q;
      return this.qty > 0 ? this.avgEntry - room : this.avgEntry + room;
    }

    setMark(price) {
      this.markPrice = price;
    }

    // Open or increase a position. marginUSD is collateral committed;
    // notional = marginUSD * leverage; qty = notional / price.
    // side: 'long' | 'short'
    order(side, marginUSD, leverage, price, time) {
      if (this.liquidated) return { ok: false, msg: 'Account liquidated.' };
      marginUSD = Number(marginUSD);
      leverage = Math.max(1, Number(leverage) || 1);
      if (!(marginUSD > 0)) return { ok: false, msg: 'Invalid order size.' };
      if (marginUSD > this.available + 1e-9) {
        return { ok: false, msg: 'Insufficient available margin.' };
      }
      this.setMark(price);
      const notional = marginUSD * leverage;
      const orderQty = notional / price;
      const dQty = side === 'long' ? orderQty : -orderQty;

      const fee = notional * FEE_RATE;
      this.balance -= fee;
      this.feesTotal += fee;

      this._applyFill(dQty, price, marginUSD, leverage, time);
      return { ok: true };
    }

    // Reduce/close part or all of the position by a fraction (0..1) of qty.
    reduce(fraction, price, time) {
      if (this.qty === 0) return { ok: false, msg: 'No open position.' };
      fraction = Math.max(0, Math.min(1, fraction));
      const closeQty = this.qty * fraction; // signed
      this.setMark(price);
      const notional = Math.abs(closeQty) * price;
      const fee = notional * FEE_RATE;
      this.balance -= fee;
      this.feesTotal += fee;
      this._applyFill(-closeQty, price, 0, this.leverage, time);
      return { ok: true };
    }

    closeAll(price, time) {
      return this.reduce(1, price, time);
    }

    // Core fill logic with net positioning + realized PnL accounting.
    _applyFill(dQty, price, addMargin, leverage, time) {
      const oldQty = this.qty;
      const newQty = oldQty + dQty;
      const sameDir = oldQty !== 0 && Math.sign(oldQty) === Math.sign(dQty);

      if (oldQty === 0) {
        // Opening fresh.
        this.qty = newQty;
        this.avgEntry = price;
        this.margin = addMargin;
        this.leverage = leverage;
      } else if (sameDir) {
        // Adding to the position -> weighted average entry.
        const a = Math.abs(oldQty), b = Math.abs(dQty);
        this.avgEntry = (this.avgEntry * a + price * b) / (a + b);
        this.qty = newQty;
        this.margin += addMargin;
        // Blend leverage by notional weight.
        this.leverage = leverage;
      } else {
        // Reducing / closing / flipping.
        const closing = Math.min(Math.abs(dQty), Math.abs(oldQty));
        const dir = Math.sign(oldQty); // +1 long, -1 short
        const realized = dir * closing * (price - this.avgEntry);
        this.balance += realized;
        this.realizedTotal += realized;

        // Return collateral proportional to the closed fraction.
        const closedFrac = closing / Math.abs(oldQty);
        const releasedMargin = this.margin * closedFrac;
        this.margin -= releasedMargin;

        this.trades.push({
          time: time || 0,
          side: dir > 0 ? 'long' : 'short',
          qty: closing,
          entry: this.avgEntry,
          exit: price,
          pnl: realized,
          pnlPct: releasedMargin ? (realized / releasedMargin) * 100 : 0,
        });

        if (Math.abs(dQty) < Math.abs(oldQty)) {
          this.qty = newQty; // entry & remaining margin unchanged
        } else if (Math.abs(dQty) === Math.abs(oldQty)) {
          this.qty = 0; this.avgEntry = 0; this.margin = 0;
        } else {
          // Flip: open opposite side with the leftover.
          this.qty = newQty;
          this.avgEntry = price;
          this.margin = addMargin; // fresh collateral for the new side
          this.leverage = leverage;
        }
      }
    }

    // Check for liquidation against the current mark price. Returns true if
    // a liquidation happened this call.
    checkLiquidation(time) {
      if (this.qty === 0 || this.liquidated) return false;
      // Liquidate when equity drops to maintenance level of locked margin.
      if (this.equity <= this.margin * MMR) {
        this.reduce(1, this.markPrice, time);
        if (this.trades.length) this.trades[this.trades.length - 1].liquidated = true;
        this.liquidated = this.balance <= 0;
        return true;
      }
      return false;
    }
  }

  global.Trading = { Account, MMR, FEE_RATE };
})(window);
