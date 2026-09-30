// alert, confirm and prompt, as Bun and Deno have them for a program on a terminal: the message
// on standard output, the answer a line of standard input (porffor:process). With no input left
// (end of file), confirm is false and prompt null.
import { readLine, write } from 'porffor:process';

// a line of input without its line ending; undefined at the end of the input
function answer() {
	const line = readLine();

	return line === undefined ? undefined : line.replace(/\r?\n$/, '');
}

/** Shows `message` and waits for Enter. */
export function alert(message = 'Alert') {
	write(`${message} [Enter] `);
	answer();
}

/** Shows `message` and asks yes or no: true for y or yes. */
export function confirm(message = 'Confirm') {
	write(`${message} [y/N] `);
	const line = answer();

	return line !== undefined && /^y(es)?$/i.test(line.trim());
}

/** Shows `message` and returns the line typed, `defaultValue` for an empty one, null at the end of the input. */
export function prompt(message = 'Prompt', defaultValue = null) {
	write(defaultValue === null ? `${message} ` : `${message} [${defaultValue}] `);
	const line = answer();

	if (line === undefined) return null;

	return line === '' ? defaultValue : line;
}
