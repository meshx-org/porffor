/**
 * wasi-porffor as a Vite plugin: `vite build` bundles the guest as usual, then the plugin
 * compiles the bundle into a WebAssembly component with Porffor (src/build.mjs) and emits
 * it as an asset in place of the JavaScript.
 *
 *   // vite.config.js
 *   import { wasiPorffor } from '@meshx-org/porffor/wasi/vite';
 *
 *   export default {
 *     build: { lib: { entry: 'src/index.js', formats: ['es'] } },
 *     plugins: [wasiPorffor({ wit: 'wit', world: 'cloud' })]
 *   };
 *
 * Only `vite build`: a component is a native compile (clang, LTO, wasm-opt), seconds to
 * minutes, so `vite dev` serves the guest as JavaScript, untouched.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildComponent } from './build.mjs';

/**
 * A WIT interface import (`wasi:http/types@0.2.0`, `yel:ui/dom@0.1.0`): the component's
 * imports, bound by the glue, so never bundled.
 * @param {string} id
 * @returns {boolean}
 */
export const witImport = (id) => /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*\//.test(id);

/**
 * @typedef {Omit<import('./build.mjs').BuildOptions, 'guest' | 'out' | 'log'> & {
 *   fileName?: string,
 *   keepJs?: boolean,
 *   external?: (id: string) => boolean
 * }} WasiPorfforOptions
 * `fileName` is the component's name in the output (default `<world>.wasm`); `keepJs` keeps
 * the JavaScript bundle beside it; `external` says which imports are the world's (default
 * witImport). `work` defaults to node_modules/.wasi-porffor/<world>, so rebuilds reuse its
 * cached C objects (with units > 1).
 */

/**
 * The Vite plugin that builds the bundle into a WebAssembly component.
 * @param {WasiPorfforOptions} options
 * @returns {import('vite').Plugin}
 */
export function wasiPorffor(options) {
	const {
		fileName = `${options.world}.wasm`,
		keepJs = false,
		external = witImport,
		...build
	} = options;
	let root = process.cwd();

	return {
		name: 'wasi-porffor',
		apply: 'build',

		// one ES module with every import inlined but the world's: what the glue binds
		config: (config) => ({
			build: {
				minify: config.build?.minify ?? false,
				rollupOptions: {
					external,
					output: { format: 'es', codeSplitting: false }
				}
			}
		}),

		configResolved(config) {
			root = config.root;
		},

		async generateBundle(_output, bundle) {
			const entries = Object.values(bundle).filter((file) => file.type === 'chunk' && file.isEntry);

			if (entries.length !== 1)
				this.error(`wasi-porffor: the guest must build to one entry chunk, not ${entries.length}`);

			const [chunk] = entries;
			const work = resolve(root, build.work ?? join('node_modules/.wasi-porffor', build.world));
			const guest = join(work, 'guest.mjs');

			mkdirSync(work, { recursive: true });
			writeFileSync(guest, chunk.code);

			const { out } = await buildComponent({
				...build,
				guest,
				wit: resolve(root, build.wit),
				out: join(work, fileName),
				work,
				log: (message) => this.info(message)
			});

			this.emitFile({ type: 'asset', fileName, source: readFileSync(out) });

			if (!keepJs) delete bundle[chunk.fileName];
		}
	};
}
