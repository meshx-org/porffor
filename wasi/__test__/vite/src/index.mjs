import { greet } from './greeting.mjs';

/**
 * The world's export: a greeting, shouted, with the modules it came from.
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function run(name) {
	const { shout } = await import('./shout.mjs');

	return JSON.stringify({ text: shout(greet(name)), modules: 2 });
}
