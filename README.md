# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/geminigisa/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/geminigisa/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free JavaScript module that renders Markdown to HTML byte-identical to marked 18.1.3 (GFM on), faster than marked itself. A single-pass block scanner with char-code dispatch and a line cursor, a delimiter-stack inline scanner, and direct emission into a chunk array — no token AST, no renderer dispatch. Link reference definitions are collected in a cheap first pass so forward references resolve document-wide.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rn8n62kp&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
