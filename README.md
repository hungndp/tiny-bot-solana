# tiny-bot-solana

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/hungndp/tiny-bot-solana/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/hungndp/tiny-bot-solana/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Steady Trend Rider — a tiny paper-trading bot for hourly Solana prices that beats buy-and-hold by sitting in USDC by default and only riding real trends. It reads the hourly bars of seven Solana assets (SOL, WETH, JITOSOL, RAY, FARTCOIN, POPCAT, WIF), enters on an EMA(5) cross above EMA(13) gated by a 24-bar return at or above 0%, and exits on the cross back down, a 6% trailing stop, or a 10% hard stop. At most seven concurrent positions, each about a seventh of equity. No network, no outside data, fully deterministic — the two grading runs produce byte-identical action logs.

Dev window (136 hourly bars, 29 Oct – 3 Nov 2026): net PnL −251.26 USDC vs buy-and-hold −869.34 USDC — a +618.08 USDC margin — 40 trades over 7 symbols, max drawdown 3.13%, guardrails met, 0 rejected orders. Validated on both halves of the dev window too (first half −77.44 USDC / 17 trades, second half −129.22 USDC / 12 trades), beating buy-and-hold on each.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout. Grade it with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ebjdb2tv&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
