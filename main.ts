// Steady Trend Rider — a tiny trend bot for "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".
//
// The idea, in one paragraph: the dev window (and the final window it stands in for) is a
// basket of seven Solana assets that mostly drift down with sharp up-legs. Buy-and-hold eats
// every down-leg. This bot does the opposite: it sits in USDC by default, enters only when a
// symbol shows a real trend, and exits fast when the trend breaks. Three rules do all the work:
//
//   1. Entry on an EMA(5) cross above EMA(13), gated by a 24-bar (one-day) return at or
//      above 0%, so the bot only buys a trend that is not already down on the day — never a
//      one-bar wiggle, never a falling knife.
//   2. Exit on EMA(5) crossing back below EMA(13), or a 6% trailing stop from the peak close
//      since entry, or a 10% hard stop under cost — whichever comes first.
//   3. At most 7 concurrent positions (the whole universe), each about a seventh of equity
//      (under the 25% weight cap), so one bad name can never sink the book and a failed
//      market-wide bounce costs a seventh per name, not a fifth.
//
// The lessons from the earlier trading races are built in: a hard position cap instead of
// chop-trading (the bot waits for the one real move per symbol), a regime gate (the 24h return
// filter) so it does not buy noise, a max-drawdown discipline (trailing + hard stop), and
// validation on more than one window of the kit's data before anything is submitted.
//
// Deterministic by construction: float64 EMAs only, no clock, no environment, no randomness,
// so the two grading runs produce byte-identical action logs.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- Parameters (chosen from principle, checked on two windows — see HANDOFF.md) ---
const FAST_BARS = 5; // fast EMA span, in bars — short enough to catch hourly turns
const SLOW_BARS = 13; // slow EMA span, in bars
const TREND_BARS = 24; // regime gate: return over the last 24 bars (one day)
const ENTER_MIN_24H = 0.0; // enter only if the symbol is not down over the last day
const CROSS_FRESH_BARS = 3; // a cross stays enterable this many bars (retries a refused buy)
const TRAIL_PCT = 0.06; // trailing stop: exit 6% below the peak close since entry
const HARD_STOP_PCT = 0.1; // hard stop: exit at 10% under cost
const MAX_POSITIONS = 7; // at most this many symbols held at once (the whole universe)
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// --- Per-symbol indicator state ---------------------------------------------
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the previous bar, once both EMAs are seeded. */
  gapPrev: number | null;
  /** fast - slow after this bar. */
  gap: number | null;
  /** Seq of the last bar where fast sat at or below slow (the cross is fresh after it). */
  lastDownSeq: number;
  /** Closes, oldest first, capped at TREND_BARS + 1. */
  closes: number[];
  /** Highest close seen while a position is held; null when flat. */
  peak: number | null;
}

const series = new Map<string, Series>();

function newSeries(): Series {
  return {
    fast: { span: FAST_BARS, warm: [], value: null },
    slow: { span: SLOW_BARS, warm: [], value: null },
    gapPrev: null,
    gap: null,
    lastDownSeq: -1,
    closes: [],
    peak: null,
  };
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

/** Fold one bar into its symbol's indicators. Never throws on a gap: a missing bar adds nothing. */
function pushBar(bar: Bar, seq: number): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = newSeries();
    series.set(bar.symbol, s);
  }
  const close = Number(bar.c);
  stepEma(s.fast, close);
  stepEma(s.slow, close);
  s.gapPrev = s.gap;
  s.gap = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.gap !== null && s.gap <= 0) s.lastDownSeq = seq;
  s.closes.push(close);
  if (s.closes.length > TREND_BARS + 1) s.closes.shift();
  return s;
}

/** The symbol's return over the last TREND_BARS bars, or null before that history exists. */
function trendReturn(s: Series): number | null {
  if (s.closes.length < TREND_BARS + 1) return null;
  const then = s.closes[0];
  const now = s.closes[s.closes.length - 1];
  return then === 0 ? null : now / then - 1;
}

/** True when the symbol's trend cross is fresh enough to enter on (this bar or a recent retry). */
function crossFresh(s: Series, seq: number): boolean {
  return s.gap !== null && s.gap > 0 && seq - s.lastDownSeq <= CROSS_FRESH_BARS;
}

// --- Strategy ----------------------------------------------------------------

/** Whether a held position exits on this close: trend broken, trailing stop, or hard stop. */
function shouldExit(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series): boolean {
  // Trend broken: the fast EMA is back under the slow one (persistent, so a refused sell retries).
  if (s.gap !== null && s.gap < 0) return true;
  const close = state.close(symbol);
  if (close === null) return false;
  // Trailing stop: 6% below the peak close since entry.
  if (s.peak !== null && Number(close) < s.peak * (1 - TRAIL_PCT)) return true;
  // Hard stop: the position is worth HARD_STOP_PCT under what it cost.
  const value = state.value(symbol, held.qty);
  const stopAt = BigInt(Math.round((1 - HARD_STOP_PCT) * 100));
  return value * 100n < held.cost * stopAt;
}

/** Whether a symbol we do not hold is worth entering on this close. */
function shouldEnter(state: BarsState, symbol: string, s: Series, seq: number): boolean {
  if (state.positions.has(symbol)) return false;
  if (!crossFresh(s, seq)) return false;
  const ret = trendReturn(s);
  if (ret === null || ret <= ENTER_MIN_24H) return false;
  return true;
}

await runBars({
  onBatch(state, batch) {
    // Fold every bar of this batch into its symbol's indicators first, warm-up included:
    // the warm-up bars seed the EMAs so the first tradable batch already has a trend read.
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      pushBar(bar, batch.seq);
      fresh.add(bar.symbol);
    }
    // While warming up every order would be rejected: watch, do not trade.
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        // Track the peak close while held, for the trailing stop.
        const close = state.close(symbol);
        if (close !== null) {
          const c = Number(close);
          if (s.peak === null || c > s.peak) s.peak = c;
        }
        if (shouldExit(state, symbol, held, s)) sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else {
        s.peak = null;
        if (shouldEnter(state, symbol, s, batch.seq)) entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    // Size: equity split over MAX_POSITIONS slots, capped by the weight cap and the cash left.
    // A sell's proceeds land at the next open and never fund this reply's buys.
    const stake = state.equity / BigInt(MAX_POSITIONS);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = MAX_POSITIONS - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});

