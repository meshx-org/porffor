// The caller: a resource's async methods, called in turn and at once, then sync ones.

import { Counter } from 'meshx:async-methods-test/counter@0.1.0';

export async function run() {
	const counter = new Counter(5);
	const first = await counter.add(2);
	const second = await counter.add(3);
	const value = counter.value();
	Counter.shout(200_000);
	const both = await Promise.all([counter.add(1), Counter.twice(21)]);

	return JSON.stringify({ first, second, both, value, fired: Counter.fired() });
}
