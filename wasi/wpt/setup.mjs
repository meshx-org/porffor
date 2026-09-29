#!/usr/bin/env node
// Checks out web-platform-tests into wpt/wpt for the runner (wpt/index.mjs): a shallow, sparse
// clone of just the directories it runs (read.mjs's CHECKOUT), about 60 MB of the suite's
// several GB. Run again to update it to WPT's latest, or after CHECKOUT changes.
//
//   node wpt/setup.mjs

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKOUT } from './read.mjs';

const REPOSITORY = 'https://github.com/web-platform-tests/wpt';
const checkout = join(import.meta.dirname, 'wpt');
const git = (...args) => execFileSync('git', args, { stdio: 'inherit' });

if (existsSync(join(checkout, '.git'))) {
	git('-C', checkout, 'fetch', '--depth=1', 'origin', 'HEAD');
	git('-C', checkout, 'reset', '--hard', 'FETCH_HEAD');
} else {
	git('clone', '--depth=1', '--filter=blob:none', '--sparse', REPOSITORY, checkout);
}
git('-C', checkout, 'sparse-checkout', 'set', ...CHECKOUT);
git('-C', checkout, 'log', '--oneline', '-1');
