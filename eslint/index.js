// @meshx-org/porffor/eslint: lint rules for code Porffor compiles. Porffor compiles in only what a
// program uses, and some of that it decides from values: these rules point out where a program
// keeps it from deciding (and so carries more than it needs).
//
//   import porffor from '@meshx-org/porffor/eslint';
//   export default [...porffor.configs.recommended];
//
// configs.runtime is what Porffor's own runtime (runtime/) is held to: nothing that hides from the
// compiler which of its modules a program reaches.
import staticSelector from './rules/static-selector.js';

const plugin = {
	meta: { name: '@meshx-org/porffor' },
	rules: { 'static-selector': staticSelector }
};

/** For a program Porffor compiles: selector values it can see. */
const recommended = [
	{
		name: 'porffor/recommended',
		plugins: { porffor: plugin },
		rules: { 'porffor/static-selector': 'warn' }
	}
];

/** For Porffor's runtime: no module reached by a name built at run time. */
const runtime = [
	{
		name: 'porffor/runtime',
		plugins: { porffor: plugin },
		rules: {
			'no-eval': 'error',
			'no-implied-eval': 'error',
			'no-new-func': 'error',
			'no-restricted-syntax': [
				'error',
				{
					selector: 'ImportExpression[source.type!="Literal"]',
					message:
						'import() of a computed specifier hides the module from the compiler: import it by name (a variant registers itself; runtime/globals.json declares when it is needed).'
				},
				{
					selector:
						'MemberExpression[computed=true][object.name=/^(globalThis|self|window)$/][property.type!="Literal"]',
					message:
						'A global read by a computed name hides it from the compiler: name it (globalThis.X), or import its module.'
				}
			]
		}
	}
];

export default { plugin, configs: { recommended, runtime } };
