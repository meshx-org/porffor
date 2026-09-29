// The Vite plugin, end to end: `vite build` of a guest in modules (vite/src, one imported
// dynamically) with wasiPorffor(), the component it emits run in wasmtime.
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, test } from 'vitest';
import { wasiPorffor } from '../src/vite.mjs';
import { invoke, missing } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), 'vite');
const unavailable = missing();

if (unavailable !== null) console.warn(`vite test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'vite: wasiPorffor() builds the bundle into a component',
	{ timeout: 300_000 },
	async () => {
		const outDir = mkdtempSync(join(tmpdir(), 'wasi-porffor-vite-'));

		await build({
			root,
			configFile: false,
			logLevel: 'silent',
			build: {
				outDir,
				lib: { entry: join(root, 'src/index.mjs'), formats: ['es'], fileName: 'guest' }
			},
			plugins: [
				wasiPorffor({ wit: 'wit', world: 'vite', target: 'p3', work: join(outDir, '.work') })
			]
		});

		// the component in place of the JavaScript
		expect(readdirSync(outDir).filter((name) => !name.startsWith('.'))).toEqual(['vite.wasm']);
		expect(existsSync(join(outDir, 'guest.js'))).toBe(false);

		const result = JSON.parse(await invoke(join(outDir, 'vite.wasm'), 'run("porffor")'));

		expect(result).toEqual({ text: 'HELLO, PORFFOR', modules: 2 });
	}
);
