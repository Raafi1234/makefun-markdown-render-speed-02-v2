# markdown-render-speed-02 — fast Markdown renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Raafi1234/makefun-markdown-render-speed-02-v2/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Raafi1234/makefun-markdown-render-speed-02-v2/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown-to-HTML renderer written from scratch for the
make.fun **markdown-render-speed-02** bounty ("Make Markdown rendering
faster").

`parse.js` exports a single function, `parse(markdown)`, whose output is
byte-for-byte identical to marked 18.1.3 with default options
(GFM enabled, no line-break conversion, non-pedantic) — including tables,
task lists, strikethrough, extended autolinks, link reference definitions,
and marked's own departures from the CommonMark spec. The implementation
is a hand-written block scanner plus a recursive-descent inline parser
that favours sticky regular expressions, index-based scanning and minimal
string copying so large documents render quickly.

`main.ts` is the harness driver: it reads `/input/cases.json`, renders
every case with `parse`, and writes the HTML strings to
`/output/html.json`.

## Layout

- `parse.js` — the renderer (ES module, no dependencies)
- `main.ts` — the driver program run by the harness
- `LICENSE` — MIT
