// Steady Trend Rider II — a tiny trend bot for "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".
//
// v2 rebuilds the v1 "Steady Trend Rider" around the house ema-cross baseline's insight and
// two measured fixes. The house baseline (EMA 8/21, plain cross in/out) scores -173.04 on the
// dev window while our v1 (EMA 5/13 + 24h gate + trailing stop) scored -251.26: the slower
// pair whipsaws far less in a drifting-down market, and the gate alone was not enough. v2
// therefore runs the house pair as its main trend, keeps a looser 24h gate (enter unless the
// symbol is down more than 2% on the day), and exits a leg the moment its fast EMA ticks down
// a single bar instead of waiting for the slow cross back — in this market the cross-down
// exit gives back most of the leg. Two smaller additions: a fast 5/13 "leg" overlay that
// re-enters inside an already-positive slow trend when the day is up at least 1% (it buys
// trade count, which the 8/21 pair alone leaves at exactly 8 per 68-bar window), and
// tenth-of-equity stakes instead of sevenths, so one bad name costs less of the book.
//
//   Main trend: EMA(8) above EMA(21), enterable for 3 bars after the cross, gated by the
//     24-bar return being at or above -2%.
//   Leg overlay: EMA(5) crossing above EMA(13) while the main trend is already positive
//     and the 24-bar return is at or above +1%.
//   Exit: main trend crosses back down, or the fast EMA falls for one bar, or a 6%
//     trailing stop from the peak close since entry, or a 10% hard stop under cost.
//   Sizing: equity / 10 per new position (under the 25% weight cap), sells first, then
//     buys; max slippage 100 bps.
//
// Deterministic by construction: float64 EMAs only, no clock, no environment, no
// randomness, so the two grading runs produce byte-identical action logs.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- Tuned configuration (swept on the dev window + both 68-bar halves — see HANDOFF-v2.md) ---
const CONFIG = {
  fastSpan: 8, // main trend: fast EMA span, in bars
  slowSpan: 21, // main trend: slow EMA span, in bars
  legFastSpan: 5, // leg overlay: fast EMA span, in bars
  legSlowSpan: 13, // leg overlay: slow EMA span, in bars
  gateBars: 24, // regime gate: return over the last 24 bars (one day)
  minDayReturn: -0.02, // main entries: skip a symbol down more than 2% on the day
  legMinDayReturn: 0.01, // leg entries: only when the symbol is up at least 1% on the day
  crossFreshBars: 3, // a main-trend cross stays enterable this many bars (retries a refused buy)
  trailPct: 0.06, // trailing stop: exit 6% below the peak close since entry
  hardStopPct: 0.1, // hard stop: exit at 10% under cost
  slots: 10, // stake denominator: each new position is about a tenth of equity
  maxSlippageBps: 100, // 1% past the close the order was decided on
} as const;

// --- One EMA: the closes it has seen until it starts, then its value. ----------------
class Ema {
  private readonly alpha: number;
  private readonly warm: number[] = [];
  private current: number | null = null;
  private previous: number | null = null;
  readonly span: number;

  constructor(span: number) {
    this.span = span;
    this.alpha = 2 / (span + 1);
  }

  push(close: number): void {
    this.previous = this.current;
    if (this.current !== null) {
      this.current += this.alpha * (close - this.current);
      return;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.current = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
  }

  get value(): number | null {
    return this.current;
  }

  /** True when this bar's step moved the EMA down — the leg is stalling. */
  get fell(): boolean {
    return this.current !== null && this.previous !== null && this.current < this.previous;
  }
}

// --- Per-symbol state: two EMA pairs, a close ring, and the exit bookkeeping. --------
class SymbolBook {
  readonly trendFast = new Ema(CONFIG.fastSpan);
  readonly trendSlow = new Ema(CONFIG.slowSpan);
  readonly legFast = new Ema(CONFIG.legFastSpan);
  readonly legSlow = new Ema(CONFIG.legSlowSpan);
  /** Seq of the last bar where the main fast EMA sat at or below the slow one. */
  private lastDownSeq = -1;
  /** Highest close seen while a position is held; null when flat. */
  peak: number | null = null;
  private gap = { prev: null as number | null, now: null as number | null };
  private legGap = { prev: null as number | null, now: null as number | null };
  /** Closes, oldest first, capped at gateBars + 1. */
  private readonly closes: number[] = [];

  ingest(bar: Bar, seq: number): void {
    const close = Number(bar.c);
    this.trendFast.push(close);
    this.trendSlow.push(close);
    this.legFast.push(close);
    this.legSlow.push(close);
    this.gap.prev = this.gap.now;
    this.gap.now = this.trendFast.value !== null && this.trendSlow.value !== null ? this.trendFast.value - this.trendSlow.value : null;
    this.legGap.prev = this.legGap.now;
    this.legGap.now = this.legFast.value !== null && this.legSlow.value !== null ? this.legFast.value - this.legSlow.value : null;
    if (this.gap.now !== null && this.gap.now <= 0) this.lastDownSeq = seq;
    this.closes.push(close);
    if (this.closes.length > CONFIG.gateBars + 1) this.closes.shift();
  }

  /** Main-trend gap (fast − slow) after this bar, or null before both EMAs seed. */
  get trend(): number | null {
    return this.gap.now;
  }

  /** The symbol's return over the last gateBars bars, or null before that history exists. */
  get dayReturn(): number | null {
    if (this.closes.length < CONFIG.gateBars + 1) return null;
    const then = this.closes[0];
    const now = this.closes[this.closes.length - 1];
    return then === 0 ? null : now / then - 1;
  }

  /** Which entry signal, if any, is live on this bar: a fresh main cross, or a fresh leg. */
  entrySignal(seq: number): 'trend' | 'leg' | null {
    if (this.trend === null || this.trend <= 0) return null;
    if (seq - this.lastDownSeq <= CONFIG.crossFreshBars) return 'trend';
    const legCrossed = this.legGap.now !== null && this.legGap.now > 0 && this.legGap.prev !== null && this.legGap.prev <= 0;
    const day = this.dayReturn;
    if (legCrossed && day !== null && day >= CONFIG.legMinDayReturn) return 'leg';
    return null;
  }

  /** Track the peak close while a position is held, for the trailing stop. */
  noteHeldClose(state: BarsState, symbol: string): void {
    const close = state.close(symbol);
    if (close === null) return;
    const c = Number(close);
    if (this.peak === null || c > this.peak) this.peak = c;
  }

  /** Why a held position exits on this close, or null to keep holding. */
  exitReason(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }): string | null {
    if (this.trend !== null && this.trend < 0) return 'trend-broken';
    if (this.trendFast.fell) return 'fast-rolling-over';
    const close = state.close(symbol);
    if (this.peak !== null && close !== null && Number(close) < this.peak * (1 - CONFIG.trailPct)) return 'trailing-stop';
    const value = state.value(symbol, held.qty);
    const stopAt = BigInt(Math.round((1 - CONFIG.hardStopPct) * 100));
    if (value * 100n < held.cost * stopAt) return 'hard-stop';
    return null;
  }
}

const books = new Map<string, SymbolBook>();

function bookFor(symbol: string): SymbolBook {
  let book = books.get(symbol);
  if (book === undefined) {
    book = new SymbolBook();
    books.set(symbol, book);
  }
  return book;
}

// --- Order assembly: sells first, then buys sized off the remaining cash. -----------
interface Scan {
  sells: SellInput[];
  entries: string[];
}

/** Walk the symbols of one batch and decide sells and entries from their books. */
function scanBatch(state: BarsState, batch: { seq: number }, fresh: Set<string>): Scan {
  const sells: SellInput[] = [];
  const entries: string[] = [];
  for (const { symbol } of state.hello.symbols) {
    if (!fresh.has(symbol)) continue;
    const book = books.get(symbol)!;
    const held = state.positions.get(symbol);
    if (held !== undefined) {
      book.noteHeldClose(state, symbol);
      if (book.exitReason(state, symbol, held) !== null) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: CONFIG.maxSlippageBps });
      }
    } else {
      book.peak = null;
      if (book.entrySignal(batch.seq) === null) continue;
      const day = book.dayReturn;
      if (day === null || day < CONFIG.minDayReturn) continue;
      entries.push(symbol);
    }
  }
  return { sells, entries };
}

/** Size the entries: equity split over CONFIG.slots, capped by the weight cap and cash. */
function buildOrders(state: BarsState, scan: Scan): (SellInput | BuyInput)[] {
  const { caps, fees } = state.hello;
  const orders: (SellInput | BuyInput)[] = scan.sells.slice(0, caps.max_orders_per_bar);
  // A sell's proceeds land at the next open and never fund this reply's buys.
  const stake = state.equity / BigInt(CONFIG.slots);
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  let room = CONFIG.slots - state.positions.size;
  let cash = state.cash;
  for (const symbol of scan.entries) {
    if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
    let slice = stake < byWeight ? stake : byWeight;
    if (cash < slice) slice = cash;
    if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
    orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: CONFIG.maxSlippageBps });
    cash -= slice;
    room--;
  }
  return orders;
}

await runBars({
  onBatch(state, batch) {
    // Fold every bar of this batch into its symbol's book first, warm-up included:
    // the warm-up bars seed the EMAs so the first tradable batch already has a trend read.
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      bookFor(bar.symbol).ingest(bar, batch.seq);
      fresh.add(bar.symbol);
    }
    // While warming up every order would be rejected: watch, do not trade.
    if (state.warmingUp) return [];
    return buildOrders(state, scanBatch(state, batch, fresh));
  },
});
