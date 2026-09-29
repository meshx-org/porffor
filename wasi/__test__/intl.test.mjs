// Intl over meshx:intl, end to end: the guest (intl/guest.mjs) is built for P2, transpiled
// by jco with meshx:intl mapped to intl/host/ (the host a browser or Node gives, over the
// engine's own Intl), and run in Node. Its output must equal the same guest run on Node's
// Intl directly: runtime/intl.mjs and the host between them add nothing and lose nothing.
// Needs the build toolchain (and wasmtime, which the harness checks for with it).

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { buildFixture, missing } from './harness.mjs';
import { run as native } from './intl/guest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const INTERFACES = ['locale', 'time-zone', 'date-time', 'number', 'plural', 'list', 'text'];

const unavailable = missing();

if (unavailable !== null) console.warn(`intl test skipped: ${unavailable}`);

// needs the build toolchain; skipped, with the reason printed, without it
test.skipIf(unavailable !== null)(
	'intl: Intl through meshx:intl formats as the engine does',
	{ timeout: 300_000 },
	async () => {
		const component = buildFixture('intl', 'intl', 'p2');
		// inside the package, so the transpiled module resolves preview2-shim
		const out = join(here, '../../node_modules/.cache/intl-test');

		rmSync(out, { recursive: true, force: true });
		mkdirSync(out, { recursive: true });
		execFileSync(
			process.execPath,
			[
				join(here, '../../node_modules/@bytecodealliance/jco/dist/jco.js'),
				'transpile',
				component,
				'-o',
				out,
				'--name',
				'intl',
				...INTERFACES.flatMap((name) => [
					'--map',
					`meshx:intl/${name}@0.1.0=${join(here, 'intl/host', `${name}.mjs`)}`
				])
			],
			{ stdio: 'pipe' }
		);
		const { run } = await import(pathToFileURL(join(out, 'intl.js')).href);
		const guest = JSON.parse(run());
		const expected = JSON.parse(native());

		expect(guest).toEqual(expected);
		// key order too: resolvedOptions() lists its fields in ECMA-402's order
		expect(JSON.stringify(guest)).toBe(JSON.stringify(expected));
	}
);
