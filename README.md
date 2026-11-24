# repo-pumpfun-paper-bot-20261124-v2

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Zhoya0077/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Zhoya0077/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the Pump.fun Replay Sprint: it rides short bursts of broad-based buying on pump.fun bonding curves, then lets winners run with a wide take-profit and a trailing stop. 10 SOL of paper money, no real funds involved.

## Strategy

- **Entry:** a coin qualifies when, over the last 30 slots, net inflow is at least 1 SOL from at least 5 buys by at least 5 distinct wallets, the price has climbed 8–50% from the burst's base and still sits within 5% of the burst high, the curve is at least 300 slots old, and real SOL reserves are 1–60 SOL. One fixed buy of 0.175 SOL (capped at 1% of real reserves, never below 0.05 SOL), one entry per coin ever.
- **Exits:** take-profit +50%, stop-loss −8%, trailing stop −35% once up +15%, 2500-slot time limit. Whole position sold on exit.
- **Risk:** at most 5 open positions, 2 SOL exposed, no new entries past a 35% equity drawdown from peak. Late-window 0.01 SOL probe trades only if the 20-coin guardrail is still short.
- **Deterministic:** no clock, no randomness, no network — the two grading runs reproduce byte for byte.

Dev grade (kit `grade-local`, frozen dev window): net PnL **+0.414 SOL**, 120 coins / 120 round trips, win rate 0.217, max drawdown 0.028.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wrbbpgtj&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
