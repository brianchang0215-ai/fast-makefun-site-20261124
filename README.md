[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/brianchang0215-ai/fast-makefun-site-20261124/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/brianchang0215-ai/fast-makefun-site-20261124/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# fast-makefun-site

A faster drop-in for makefun-site 1.0.0: `solve.js` answers every case
exactly as makefun-site 1.0.0 does — the same output tree, byte for
byte — and `main.ts` is the program the harness runs. One fused pass per
source renders its Markdown, resolves its links and counts its words;
templates are expanded once per case and rendered into one shared
output array; nothing is shared between cases.

## Run it

```sh
node main.ts
```

It reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`)
and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`), one
answer per case in the cases' order. Node 22, no dependencies, no
build step.

Built for the make.fun bounty "Build a static site faster, 22 November 2026".
Licence: MIT.
