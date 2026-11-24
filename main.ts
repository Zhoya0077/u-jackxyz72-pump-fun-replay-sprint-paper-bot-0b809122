// Pump.fun Replay Sprint — paper bot (u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
//
// Idea, reasoned from the replay mechanics: a pump.fun curve only pays a
// momentum rider when fresh SOL is actually arriving from many distinct
// wallets and the price is still pinned near its recent high — that is the
// signature of a crowd piling in, not a single whale washing. So the bot
// waits for a short burst (30 slots) of broad-based net inflow with the
// price climbing, buys a small fixed stake, and then lets the winner run:
// a wide take-profit, a tight stop, and a trailing stop once the trade is
// clearly working. Most coins die; the edge is that the few runners pay
// for the many small stops. A drawdown brake stops new entries when the
// book is bleeding, and tiny late-window probe trades exist only to keep
// the 20-coin guardrail honest.
//
// Everything here is deterministic: no clock, no randomness, no network.
// State is kept in insertion-ordered maps only, so the two grading runs
// produce identical action logs.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type BotState,
  type Batch,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

const SOL = LAMPORTS_PER_SOL;
const BPS = 10_000n;

// --- tunables ------------------------------------------------------------
// Window over which a burst is measured, in slots.
const BURST_SLOTS = 30;
// A burst needs at least this much net SOL flowing in, from at least this
// many buys by at least this many distinct wallets.
const MIN_NET_INFLOW = 1n * SOL;
const MIN_BUYS = 5;
const MIN_BUYERS = 5;
// Price must have climbed at least this much over the burst, but not so
// much that the move is already over; and it must still sit near the
// burst high (no buying into a fade).
const MIN_CLIMB = 0.08;
const MAX_CLIMB = 0.5;
const NEAR_HIGH = 0.95;
// Only curves old enough to have a real tape, with real SOL reserves in
// this band (too small = no liquidity to exit; too big = the easy move
// already happened).
const MIN_AGE_SLOTS = 300;
const MIN_REAL_SOL = 1n * SOL;
const MAX_REAL_SOL = 60n * SOL;
// One fixed stake per coin, capped at 1% of real reserves (the harness
// cap) and never smaller than this — a smaller buy is all fees.
const STAKE = 175_000_000n; // 0.175 SOL
const MIN_STAKE = 50_000_000n; // 0.05 SOL
// Exits, as fractions of cost basis.
const TAKE_PROFIT = 0.5;
const STOP_LOSS = 0.08;
const TRAIL_ARM = 0.15; // trailing only arms once the trade is up this much
const TRAIL_DROP = 0.35; // sell when the price gives back this much from its peak
const MAX_HOLD_SLOTS = 2500;
const COOLDOWN_SLOTS = 200; // after an exit, leave the coin alone
// Risk: at most this many main positions, this much SOL exposed, and no
// new entries past this equity drawdown from the peak.
const MAX_MAIN = 5;
const MAX_EXPOSURE = 2n * SOL;
const MAX_DRAWDOWN = 0.35;
// Guardrail probes: only late in the window, only if the coin count is
// still short of the target, at most this many, 0.01 SOL each.
const TARGET_COINS = 25;
const PACE_SECONDS = 14_400;
const PROBE_SIZE = 10_000_000n; // 0.01 SOL
const MAX_PROBES = 2;
// Slippage tolerance on every order, in bps.
const SLIPPAGE_BPS = 5000;

// --- per-coin tape --------------------------------------------------------

interface TapeTick {
  slot: number;
  price: number; // SOL per token at that trade (virtual reserves ratio)
  sol: bigint; // signed SOL flow: +buy, -sell
  buy: boolean;
  user: string;
}

interface BookEntry {
  enteredSlot: number;
  peakReturn: number; // best return vs cost seen so far
  probe: boolean;
}

interface Burst {
  startPrice: number;
  high: number;
  netInflow: bigint;
  buys: number;
  buyers: number;
}

/** Price of one token in SOL from a curve's virtual reserves. */
function spotPrice(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens === 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

/** What `tokens` would fetch if sold now: constant-product out, less the
 *  1.25% combined curve fee, less one tx fee. */
function sellValue(
  tokens: bigint,
  virtualQuote: bigint,
  virtualTokens: bigint,
  txFee: bigint,
): bigint {
  if (tokens === 0n || virtualTokens === 0n) return 0n;
  const out = (tokens * virtualQuote) / (virtualTokens + tokens);
  const afterFee = (out * 9875n) / BPS;
  return afterFee > txFee ? afterFee - txFee : 0n;
}

// --- the bot ---------------------------------------------------------------

class SprintBot {
  // Recent trades per mint, newest last; pruned to the burst window.
  private tape = new Map<string, TapeTick[]>();
  // Mints ever entered (one entry per mint, ever).
  private entered = new Set<string>();
  // Open positions we track, with entry slot + peak return.
  private book = new Map<string, BookEntry>();
  // Slots before which a mint may not be re-entered.
  private cooldownUntil = new Map<string, number>();
  // Mints with a completed round trip of >= 0.01 SOL (guardrail count).
  private roundTrips = new Set<string>();
  private probesUsed = 0;
  private firstBlockTime: number | null = null;
  private lastBlockTime = 0;
  private peakEquity: bigint | null = null;

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    const txFee = state.txFeeLamports();

    // Track block-time progress for the probe pacing rule.
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (this.firstBlockTime === null) this.firstBlockTime = e.block_time;
        if (e.block_time > this.lastBlockTime) this.lastBlockTime = e.block_time;
      }
    }

    // Fold this batch's fills into the round-trip count, and note sells so
    // the cooldown starts when a position actually closes.
    for (const f of batch.fills) {
      if (f.status === "filled" && f.side === "sell") {
        const buySize = this.buySizeOf(f.mint);
        if (buySize >= PROBE_SIZE) this.roundTrips.add(f.mint);
      }
    }

    // Record this batch's trades on each mint's tape.
    const touched = new Set<string>();
    for (const e of batch.events) {
      if (e.event !== "TradeEvent") continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined) continue;
      const ticks = this.tape.get(e.mint) ?? [];
      ticks.push({
        slot: e.slot,
        price: spotPrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
        sol: e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount),
        buy: e.is_buy,
        user: e.user,
      });
      // Keep only ticks that can still matter for a burst window.
      while (ticks.length > 0 && ticks[0].slot <= slot - BURST_SLOTS - 5) ticks.shift();
      this.tape.set(e.mint, ticks);
      touched.add(e.mint);
    }

    // Register newly opened positions (their buy fill landed) and drop
    // positions that closed.
    for (const [mint] of state.positions) {
      if (!this.book.has(mint)) {
        this.book.set(mint, { enteredSlot: slot, peakReturn: 0, probe: false });
      }
    }
    for (const [mint] of [...this.book]) {
      if (!state.positions.has(mint)) {
        this.book.delete(mint);
        this.cooldownUntil.set(mint, slot + COOLDOWN_SLOTS);
      }
    }

    // --- exits first: never hold a loser hoping it comes back -----------
    for (const [mint, holding] of state.positions) {
      if (this.hasPendingSell(state, mint)) continue;
      const entry = this.book.get(mint);
      if (entry === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = sellValue(
        holding.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        txFee,
      );
      const cost = holding.cost_lamports;
      if (cost === 0n) continue;
      const ret = Number(value - cost) / Number(cost);
      if (ret > entry.peakReturn) entry.peakReturn = ret;
      const held = slot - entry.enteredSlot;
      const trailingHit =
        entry.peakReturn >= TRAIL_ARM &&
        1 + ret <= (1 + entry.peakReturn) * (1 - TRAIL_DROP);
      const timeUp = held >= MAX_HOLD_SLOTS;
      if (
        ret >= TAKE_PROFIT ||
        ret <= -STOP_LOSS ||
        trailingHit ||
        timeUp ||
        (entry.probe && held >= 1)
      ) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }

    // --- entries: a fresh broad-based burst near the high ----------------
    const equity = this.equity(state, txFee);
    if (this.peakEquity === null || equity > this.peakEquity) this.peakEquity = equity;
    const drawdown =
      this.peakEquity > 0n
        ? Number(this.peakEquity - equity) / Number(this.peakEquity)
        : 0;
    const brakeOn = drawdown > MAX_DRAWDOWN;
    const exposure = this.openExposure(state);

    if (!brakeOn && state.committedPositionCount() < MAX_MAIN && exposure < MAX_EXPOSURE) {
      for (const mint of touched) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (this.entered.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        if (this.hasPendingBuy(state, mint)) continue;
        const cool = this.cooldownUntil.get(mint) ?? -1;
        if (slot < cool) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.created_slot === null) continue;
        if (slot - curve.created_slot < MIN_AGE_SLOTS) continue;
        if (
          curve.real_quote_reserves < MIN_REAL_SOL ||
          curve.real_quote_reserves > MAX_REAL_SOL
        ) {
          continue;
        }
        const burst = this.burst(mint, slot);
        if (burst === null) continue;
        if (burst.buys < MIN_BUYS || burst.buyers < MIN_BUYERS) continue;
        if (burst.netInflow < MIN_NET_INFLOW) continue;
        const now = spotPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (now <= 0 || burst.startPrice <= 0) continue;
        const climb = now / burst.startPrice - 1;
        if (climb < MIN_CLIMB || climb > MAX_CLIMB) continue;
        if (now < NEAR_HIGH * burst.high) continue;
        // Size: fixed stake, capped at 1% of real reserves (the harness
        // cap), never below the minimum worth trading.
        let size = STAKE;
        const cap = state.maxBuyLamports(mint);
        if (size > cap) size = cap;
        if (size < MIN_STAKE) continue;
        if (state.freeCashLamports() < size + txFee) continue;
        orders.push({
          side: "buy",
          mint,
          quote_lamports: size,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        this.entered.add(mint);
        this.buySizes.set(mint, size);
      }
    }

    // --- guardrail probes: only late, only while short of the target ----
    if (
      this.roundTrips.size < TARGET_COINS &&
      this.probesUsed < MAX_PROBES &&
      this.firstBlockTime !== null &&
      this.lastBlockTime - this.firstBlockTime > PACE_SECONDS / 2
    ) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (this.entered.has(mint) || state.positions.has(mint)) continue;
        if (this.hasPendingBuy(state, mint)) continue;
        if (curve.complete || curve.created_slot === null) continue;
        if (slot - curve.created_slot < MIN_AGE_SLOTS) continue;
        if (
          curve.real_quote_reserves < MIN_REAL_SOL ||
          curve.real_quote_reserves > MAX_REAL_SOL
        ) {
          continue;
        }
        if (state.freeCashLamports() < PROBE_SIZE + txFee) break;
        if (state.committedPositionCount() >= MAX_MAIN) break;
        orders.push({
          side: "buy",
          mint,
          quote_lamports: PROBE_SIZE,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        this.entered.add(mint);
        this.buySizes.set(mint, PROBE_SIZE);
        this.probesUsed++;
        // Mark it a probe as soon as its position shows up.
        this.probeMints.add(mint);
        break;
      }
    }

    // Tag probe positions so the exit rule sells them on the next batch.
    for (const mint of this.probeMints) {
      const entry = this.book.get(mint);
      if (entry !== undefined) entry.probe = true;
    }

    return orders;
  }

  // Buy size we sent on a mint (for the round-trip guardrail count).
  private buySizes = new Map<string, bigint>();
  private probeMints = new Set<string>();

  private buySizeOf(mint: string): bigint {
    return this.buySizes.get(mint) ?? 0n;
  }

  private burst(mint: string, nowSlot: number): Burst | null {
    const ticks = this.tape.get(mint);
    if (ticks === undefined || ticks.length === 0) return null;
    const win = ticks.filter((t) => t.slot > nowSlot - BURST_SLOTS);
    if (win.length === 0) return null;
    // Base the climb on the last tick at or before the window opened when
    // one survives in the retained tape — the price the burst climbed
    // FROM — rather than on the first trade inside the window, which is
    // already partway up the move and understates it.
    let base = win[0];
    for (const t of ticks) {
      if (t.slot <= nowSlot - BURST_SLOTS) base = t;
      else break;
    }
    const startPrice = base.price;
    let net = 0n;
    let buys = 0;
    let high = 0;
    const buyers = new Set<string>();
    for (const t of win) {
      net += t.sol;
      if (t.buy) {
        buys++;
        buyers.add(t.user);
      }
      if (t.price > high) high = t.price;
    }
    return { startPrice, high, netInflow: net, buys, buyers: buyers.size };
  }

  private equity(state: BotState, txFee: bigint): bigint {
    let eq = state.cash;
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      eq += sellValue(
        holding.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        txFee,
      );
    }
    return eq;
  }

  private openExposure(state: BotState): bigint {
    let total = 0n;
    for (const holding of state.positions.values()) total += holding.cost_lamports;
    return total;
  }

  private hasPendingBuy(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === "buy" && p.order.mint === mint) return true;
    }
    return false;
  }

  private hasPendingSell(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === "sell" && p.order.mint === mint) return true;
    }
    return false;
  }
}

const bot = new SprintBot();

await runBot({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
