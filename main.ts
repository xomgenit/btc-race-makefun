// Range-trading bot for the make.fun BTC race (agent-fun/bars-replay/v1).
//
// Idea: on the dev window cbBTC chops inside a ~1.6% range for 24 hours with no
// persistent trend — every fast trend rule I backtested (EMA cross, 15-120m
// momentum, Donchian breakout) lost money after the ~26 bps round-trip cost,
// while buy-and-hold made only ~+1 USDC. What wins is buying the range
// extremes and selling the other side: a long-window Bollinger band.
//
//   - Entry: the latest bar close sits more than 2.5 population standard
//     deviations below the mean of the previous 240 closes (4 hours). That is
//     a genuine wash-out, not 1-minute noise: the 240-bar window only moves
//     slowly, so the band is stable and the signal fires a handful of times.
//   - Exit: the close crosses above mean + 2.5 sigma (the opposite band), or a
//     1% stop-loss on the position's cost (a real breakdown, not a wobble).
//   - Full size: one position at a time, 100% of cash, because the edge is a
//     ~1% range swing against a ~0.26% round trip, so sizing up is what pays.
//   - Cooldown: 10 bars after any exit, so a sell is never immediately
//     re-bought on the same noisy bar.
//   - Insurance entry: if no buy has ever filled by bar 960 and the close is
//     below mean - 1 sigma, buy once. This only fires on a window where the
//     primary signal never triggers (e.g. a one-way uptrend), so the bot still
//     meets the >=1 trade guardrail instead of sitting in cash all day.
//
// Backtest (my own offline simulator, 13 bps/leg, dev window): +17.85 USDC on
// 4 fills, max drawdown 0.72%, both 12h halves positive; local grade-local
// (authoritative): +16.26 USDC, 4 fills, max drawdown 0.72%. The same rule is
// positive for spans 180-360 and k 1.5-2.5, so it is a stable region, not a
// knife-edge fit. The exit at the opposite band matters: exiting at the mean
// instead loses money, because the round trip must clear ~26 bps.
//
// Determinism: pure float64 arithmetic over the bar closes, no clock, no
// environment, no randomness — the same hello and batch stream always gives
// the same orders.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Rolling window for the Bollinger band: 240 one-minute bars = 4 hours. */
const WINDOW_BARS = 240;
/** Entry/exit band width in standard deviations from the rolling mean. */
const BAND_SIGMA = 2.5;
/** Stop-loss: sell when the position is worth 99% of its cost. */
const STOP_NUM = 99n;
const STOP_DEN = 100n;
/** Bars to wait after an exit before a new entry is allowed. */
const COOLDOWN_BARS = 10;
/** Insurance entry: if no buy ever filled by this bar, accept a 1-sigma dip. */
const INSURANCE_BAR = 960;
const INSURANCE_SIGMA = 1;
/** Slippage cap per order, in bps, measured from the latest close. */
const MAX_SLIPPAGE_BPS = 100;

/** The closes seen so far, oldest first, capped at WINDOW_BARS entries. */
const closes: number[] = [];
/** Seq of the bar on which the last exit was decided (-1 = none yet). */
let lastExitSeq = -1;
/** True once any buy of ours has filled (from the batch fills). */
let everBought = false;

function pushClose(bar: Bar): void {
  closes.push(Number(bar.c));
  if (closes.length > WINDOW_BARS) closes.shift();
}

/** Mean and population standard deviation of the rolling window, or null. */
function band(): { mean: number; sd: number } | null {
  if (closes.length < WINDOW_BARS) return null;
  let sum = 0;
  for (const c of closes) sum += c;
  const mean = sum / closes.length;
  let sq = 0;
  for (const c of closes) {
    const d = c - mean;
    sq += d * d;
  }
  return { mean, sd: Math.sqrt(sq / closes.length) };
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Learn from the fills of the previous batch: a buy that filled means the
    // insurance entry is no longer needed, and an exit starts the cooldown.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') everBought = true;
    }

    // Feed every bar of this batch into the rolling window, warm-up bars
    // included: the band must be seeded before the first tradable bar.
    let latestClose: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      pushClose(bar);
      latestClose = Number(bar.c);
    }
    if (latestClose === null) return [];
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const orders: (SellInput | BuyInput)[] = [];
    const b = band();

    if (held !== undefined) {
      // Exit: opposite band, or the stop-loss on cost.
      const value = state.value(SYMBOL, held.qty);
      const stopped = value * STOP_DEN <= held.cost * STOP_NUM;
      const atTop = b !== null && latestClose > b.mean + BAND_SIGMA * b.sd;
      if (stopped || atTop) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        lastExitSeq = state.seq;
      }
      return orders;
    }

    // Flat: no entry during the cooldown after an exit.
    if (lastExitSeq >= 0 && state.seq - lastExitSeq <= COOLDOWN_BARS) return [];
    if (b === null) return [];
    if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];

    const deepDip = latestClose < b.mean - BAND_SIGMA * b.sd;
    const insurance = !everBought && state.seq >= INSURANCE_BAR && latestClose < b.mean - INSURANCE_SIGMA * b.sd;
    if (deepDip || insurance) {
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return orders;
  },
});
