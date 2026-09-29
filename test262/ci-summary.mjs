// The nightly test262 run's summary, for CI: the runner's result line, the tests won and lost
// against the previous run's results, and where the failures are (by directory and message).
// Written to $GITHUB_STEP_SUMMARY when set, and to stdout.
// node test262/ci-summary.mjs <runner log> <previous results.json|-> <results.json> [failures.tsv]
import fs from 'node:fs';

const [ logPath, prevPath, resultsPath, errorsPath ] = process.argv.slice(2);
const stripAnsi = x => x.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const readJson = path => path && path !== '-' && fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
const LIST_MAX = 100;

const line = stripAnsi(fs.readFileSync(logPath, 'utf8')).split(/[\r\n]/).filter(x => x.startsWith('test262: ')).at(-1) ?? 'test262: no result line (the run did not finish)';
let md = `## test262\n\n\`${line}\`\n`;

const results = readJson(resultsPath);
const prev = readJson(prevPath);
if (results && prev) {
  const now = new Set(results.passes ?? []);
  const before = new Set(prev.passes ?? []);
  const won = [ ...now ].filter(x => !before.has(x)).sort();
  const lost = [ ...before ].filter(x => !now.has(x)).sort();
  md += `\nAgainst the previous run: **${won.length} won, ${lost.length} lost**\n`;
  const list = (title, xs) => {
    if (xs.length === 0) return;
    md += `\n<details${title === 'lost' && xs.length <= 30 ? ' open' : ''}><summary>${title} (${xs.length})</summary>\n\n`;
    for (const x of xs.slice(0, LIST_MAX)) md += `- \`${x}\`\n`;
    if (xs.length > LIST_MAX) md += `- …and ${xs.length - LIST_MAX} more\n`;
    md += '\n</details>\n';
  };
  list('lost', lost);
  list('won', won);
} else if (results) {
  md += '\nNo previous run to compare against.\n';
}

// the failures (the runner's per-worker log: file, tab, message)
if (errorsPath && fs.existsSync(errorsPath)) {
  const rows = fs.readFileSync(errorsPath, 'utf8').split('\n').filter(Boolean).map(x => x.split('\t'));
  const count = key => {
    const map = new Map();
    for (const row of rows) {
      const k = key(row);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [ ...map ].sort((a, b) => b[1] - a[1]).slice(0, 25);
  };
  const table = (title, head, entries) => {
    md += `\n<details><summary>${title}</summary>\n\n| ${head} | tests |\n|---|--:|\n`;
    for (const [ k, n ] of entries) md += `| ${k.replace(/\|/g, '\\|')} | ${n} |\n`;
    md += '\n</details>\n';
  };
  table(`failures by directory (${rows.length})`, 'directory', count(([ file ]) => file.split('/').slice(0, 3).join('/')));
  table('failures by message', 'message', count(([ , msg = '' ]) => '`' + msg.slice(0, 90).replace(/\d+/g, 'N').replace(/`/g, "'") + '`'));
}

// (the run's Summary page shows the step summary; the log gets it too)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
