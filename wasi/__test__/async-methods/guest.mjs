// The provider: a resource whose async methods wait on a timer, so each call suspends
// through the callback ABI before it returns. Its top level sets a timer and `value` prints,
// both inside sync exports (the constructor is the first call in): the timer starts with the
// first async export, and the output waits for one too, since a sync export cannot block.

let fired = 0;

setTimeout(() => {
	fired++;
}, 1);

/** Settles after a millisecond on the host's clock. */
const tick = () => new Promise((settle) => setTimeout(settle, 1));

class Counter {
	constructor(start) {
		this.total = start;
	}

	async add(amount) {
		await tick();
		this.total += amount;
		return this.total;
	}

	value() {
		console.error(`value ${this.total}`);
		return this.total;
	}

	static async twice(amount) {
		await tick();
		return amount * 2;
	}

	static fired() {
		return fired;
	}

	static shout(bytes) {
		console.error('!'.repeat(bytes));
	}
}

export const counter = { Counter };
