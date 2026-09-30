// node:fs, node:path, node:os and node:child_process (Porffor's runtime/node) in a WASI
// component: the guest (node-fs/guest.mjs) is built for P3 (its errors are caught: wasm exception
// handling, which P2 builds leave out) and run in wasmtime with a directory preopened, the file
// system reached through wasi-libc (wasi:filesystem).
// Needs wasmtime 49+ (WASMTIME, or wasmtime on PATH) and the build toolchain.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildFixture, invoke, missing } from './harness.mjs';

const unavailable = missing();

if (unavailable !== null) console.warn(`node-fs test skipped: ${unavailable}`);

// needs wasmtime 49+ and the build toolchain; skipped, with the reason printed, without them
test.skipIf(unavailable !== null)(
	'node-fs: node:fs in a preopened directory (p3)',
	{ timeout: 300_000 },
	async () => {
		const out = buildFixture('node-fs', 'node-fs', 'p3');
		const dir = mkdtempSync(join(tmpdir(), 'wasi-porffor-node-fs-'));

		try {
			writeFileSync(join(dir, 'input.txt'), 'from the host ✓');
			const seen = JSON.parse(
				await invoke(out, 'run("/work")', 'p3=y', ['--dir', `${dir}::/work`])
			);

			expect(seen).toEqual({
				input: 'from the host ✓',
				exists: [true, false],
				made: '/work/a',
				size: 17,
				isDirectory: true,
				list: ['b', 'y.txt'],
				copied: 'héllo from wasi\n',
				missing: 'ENOENT',
				rmDirectory: 'ERR_FS_EISDIR',
				removed: false,
				temp: true,
				platform: 'wasi',
				spawn: 'ENOSYS'
			});
			// what the guest left, as the host sees it: UTF-8, as it wrote
			expect(readFileSync(join(dir, 'a/b/c/x.txt'), 'utf8')).toBe('héllo from wasi\n');
			expect(readdirSync(join(dir, 'a')).sort()).toEqual(['b', 'z.txt']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
);
