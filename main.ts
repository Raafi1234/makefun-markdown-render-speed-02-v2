// Entry point for the markdown-render-speed-02 bot.
//
// The harness mounts the case set at /input/cases.json and expects the
// rendered HTML at /output/html.json. Each case is an object with an
// `id` and a `markdown` string; the output is a plain JSON array holding
// one HTML string per case, in the same order as the input.
//
// Two environment variables let the same file run outside the sandbox
// during development: MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR replace
// the fixed /input and /output locations when set.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inDir, 'cases.json'), 'utf8');
const cases: Case[] = JSON.parse(raw) as Case[];

const out: string[] = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}

writeFileSync(join(outDir, 'html.json'), JSON.stringify(out));
