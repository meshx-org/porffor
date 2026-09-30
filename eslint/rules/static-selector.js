// porffor/static-selector: a selector passed a value Porffor cannot see at compile time. A
// selector (runtime/globals.json) is an argument that chooses which of the runtime's modules a
// program needs: a compression format, a Web Crypto algorithm, a TextDecoder label. Porffor
// compiles in the variants a program's values name; a value it cannot see (a parameter, a string
// built at run time) brings every variant, so the program still works but carries all of them.
// This is the compiler's own analysis (compiler/selectors.js), run on one file: a const imported
// from another file is not seen here, though the compiler, which sees the whole program, may.
import manifest from '../../runtime/globals.json' with { type: 'json' };
import { analyzeSelectors } from '../../compiler/selectors.js';

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'suggestion',
		docs: {
			description:
				'Pass selector values (compression formats, Web Crypto algorithms, text encodings) Porffor can see at compile time'
		},
		schema: [],
		messages: {
			dynamic:
				"Porffor cannot see this {{selector}} at compile time, so {{variants}} is compiled in. Pass a string literal, an object literal's name, or a const of one."
		}
	},
	create(context) {
		return {
			'Program:exit'(program) {
				const { dynamic } = analyzeSelectors([program], manifest, { receivers: true });

				for (const [name, nodes] of dynamic) {
					const selector = manifest.selectors[name];

					for (const node of nodes)
						context.report({
							node,
							messageId: 'dynamic',
							data: {
								selector: name.replace(/-/g, ' '),
								variants: selector.variants ?? 'every variant'
							}
						});
				}
			}
		};
	}
};
