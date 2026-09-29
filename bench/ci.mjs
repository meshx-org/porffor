// The benchmarks, for CI: every program in bench/ compiled to C and built natively, the builds
// in parallel, then each run RUNS times one after another (median wall ms, and the scores it
// prints, the V8 suite's). Writes a Markdown table (to $GITHUB_STEP_SUMMARY when set, and to
// stdout) and the results as JSON (bench-results.json, or the path given).
// node bench/ci.mjs [out.json]
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.join(import.meta.dirname, '..');
const benchDir = path.join(root, 'bench');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'porffor-bench-'));
const jsonOut = process.argv[2] ?? 'bench-results.json';
const cc = process.env.CC ?? 'clang';
const RUNS = +(process.env.BENCH_RUNS ?? 3);
const SKIP = new Set([ 'avg.js' ]); // compiles with neither

const files = fs.readdirSync(benchDir).filter(x => x.endsWith('.js') && !SKIP.has(x)).sort();
const median = xs => [ ...xs ].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// builds, a pool the size of the machine
const built = {};
let next = 0;
await Promise.all(Array.from({ length: os.cpus().length }, async () => {
  while (next < files.length) {
    const file = files[next++];
    const base = path.join(outDir, file.replace(/\W/g, '_'));
    try {
      const t0 = performance.now();
      await run(process.execPath, [ '--stack-size=65500', path.join(root, 'cli/index.js'), 'c', path.join(benchDir, file), '-o', base + '.c' ], { maxBuffer: 1 << 26 });
      const compileMs = performance.now() - t0;
      await run(cc, [ '-O3', '-w', base + '.c', '-o', base, '-lm' ], { maxBuffer: 1 << 26 });
      built[file] = { compileMs, cSize: fs.statSync(base + '.c').size, binSize: fs.statSync(base).size, bin: base };
    } catch (e) {
      built[file] = { error: String(e.stderr ?? e.message).split('\n').find(x => /rror/.test(x))?.slice(0, 160) ?? 'build failed' };
    }
  }
}));

// timed runs, one at a time
const results = {};
for (const file of files) {
  const b = built[file];
  if (b.error) {
    results[file] = { error: b.error };
    continue;
  }

  const times = [];
  let text = '', status = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = spawnSync(b.bin, [], { encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 26 });
    times.push(performance.now() - t0);
    text = (r.stdout ?? '') + (r.stderr ?? '');
    status = r.status ?? -1;
    if (status !== 0) break;
  }

  const scores = Object.fromEntries([ ...text.matchAll(/^(?:RESULT )?(\w+)[: ] ?(\d+(?:\.\d+)?)$/gm) ]
    .filter(m => /RESULT|SCORE/.test(m[0])).map(m => [ m[1], +m[2] ]));
  results[file] = { ms: Math.round(median(times)), status, scores, compileMs: Math.round(b.compileMs), cSize: b.cSize, binSize: b.binSize };
}

const kb = n => (n / 1024).toFixed(1) + ' KB';
let md = `## Benchmarks\n\n${RUNS} runs each, median. Native build: \`${cc} -O3\` on ${os.cpus()[0]?.model ?? 'unknown CPU'} (${os.cpus().length} cores).\n\n`;
md += '| program | time | exit | compile | C | binary |\n|---|--:|--:|--:|--:|--:|\n';
for (const file of files) {
  const r = results[file];
  if (r.error) md += `| ${file} | build failed: ${r.error.replace(/\|/g, '\\|')} | | | | |\n`;
  else md += `| ${file} | ${r.ms} ms | ${r.status} | ${r.compileMs} ms | ${kb(r.cSize)} | ${kb(r.binSize)} |\n`;
}

const suite = Object.entries(results).find(([ , r ]) => r.scores?.SCORE != null);
if (suite) {
  md += `\n### V8 suite (${suite[0]}): ${suite[1].scores.SCORE}\n\n| benchmark | score |\n|---|--:|\n`;
  for (const [ k, v ] of Object.entries(suite[1].scores)) if (k !== 'SCORE') md += `| ${k} | ${v} |\n`;
}

// (the run's Summary page shows the step summary; the log gets it too)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
fs.writeFileSync(jsonOut, JSON.stringify({ commit: process.env.GITHUB_SHA ?? null, date: new Date().toISOString(), runs: RUNS, results }, null, 2));
fs.rmSync(outDir, { recursive: true, force: true });

const failed = Object.entries(results).filter(([ , r ]) => r.error || r.status !== 0).map(([ f ]) => f);
if (failed.length) {
  console.error(`failed: ${failed.join(', ')}`);
  process.exitCode = 1;
}
