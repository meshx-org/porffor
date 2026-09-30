// Porffor's own lint config: ESLint's recommended rules and the globals each part runs with,
// nothing from outside this repository (it has to install on its own). The runtime and the
// WASI build are checked; the compiler, whose builtins are Porffor's TypeScript dialect,
// gets its own rules later.
import js from '@eslint/js';
import globals from 'globals';
import porfforRules from './eslint-rules/porffor.js';

// what a program compiled by Porffor has without the runtime: the language, Porffor's own
// intrinsics, and the Web APIs its compiler builds in (compiler/builtins)
const porffor = {
	...globals.es2025,
	Porffor: 'readonly',
	console: 'readonly',
	crypto: 'readonly',
	performance: 'readonly',
	TextEncoder: 'readonly',
	TextDecoder: 'readonly',
	atob: 'readonly',
	btoa: 'readonly'
};

export default [
	{
		ignores: [
			// not yet: upstream code and Porffor's dialect (compiler/builtins/*.ts)
			'compiler/**',
			'cli/**',
			'selfhosted/**',
			'selfhost',
			'bench/**',
			'test262/**',
			// build output, the per-build work directories, the web-platform-tests checkout
			'**/node_modules/**',
			'build/**',
			'**/.wasi-porffor/**',
			'wasi/wpt/wpt/**',
			'wasi/wpt/.work/**'
		]
	},
	js.configs.recommended,
	{
		// Porffor's own rules (eslint-rules/porffor.js)
		files: ['runtime/**/*.mjs', 'wasi/**/*.mjs'],
		plugins: { porffor: porfforRules },
		rules: { 'porffor/c-uses': 'error' }
	},
	{
		// the runtime: guest code, compiled by Porffor (its own Porffor.* intrinsics included)
		files: ['runtime/**/*.mjs'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: porffor
		}
	},
	{
		// the WASI build and its tests: Node
		files: ['wasi/**/*.mjs'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: { ...globals.node, ...globals.es2025 }
		}
	},
	{
		// guests (the tests' and the WPT runner's event loop): Porffor programs, with the Web
		// APIs the build injects from runtime/
		files: ['wasi/__test__/**/guest*.mjs', 'wasi/wpt/native-loop.mjs'],
		languageOptions: {
			globals: { ...globals.browser, ...porffor }
		}
	}
];
