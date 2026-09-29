// The random fixture: what one instance draws. Two runs must differ (Math.random is
// seeded per instance); each value must have the right shape.

export function run(checkErrors) {
	const words = crypto.getRandomValues(new Uint32Array(4));
	const view = new Uint8Array(new ArrayBuffer(24), 8, 8);

	crypto.getRandomValues(view);
	// a throw caught by try needs wasm exception handling, which P2 builds leave out
	const bad = checkErrors ? [new Float64Array(2), new Uint8Array(65_537)] : [];
	const errors = bad.map((array) => {
		try {
			crypto.getRandomValues(array);

			return 'none';
		} catch (error) {
			return error.name;
		}
	});

	return JSON.stringify({
		random: [Math.random(), Math.random()],
		uuids: [crypto.randomUUID(), crypto.randomUUID()],
		words: Array.from(words),
		// only the view's 8 bytes are filled
		outside: new Uint8Array(view.buffer, 0, 8).every((byte) => byte === 0),
		errors
	});
}
