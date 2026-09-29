// The coroutines fixture's guest: runs one case of cases.mjs, the same code the test runs
// in Node for the expected value.

import { cases } from './cases.mjs';

export async function run(name) {
	const found = cases[name];

	if (found === undefined) return 'no case ' + name;

	return await found();
}
