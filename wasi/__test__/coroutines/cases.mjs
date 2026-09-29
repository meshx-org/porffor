// The coroutines fixture's cases: async functions, generators and async generators, as
// Porffor runs them, stackless step functions over heap frames. Each case returns what it
// saw as one string; the test runs it in Node for the expected value and in the component
// for the actual one.

const tick = (value) => new Promise((resolve) => Promise.resolve().then(() => resolve(value)));
const fail = (message) =>
	new Promise((_resolve, reject) => Promise.resolve().then(() => reject(new Error(message))));

// awaits in every expression position: operands, arguments, branches, lazy operands
async function asyncBasics() {
	const log = [];
	const sum = async (left, right) => (await tick(left)) + (await tick(right));
	const args = async (base) => {
		const join = (first, second, third) => `${first}|${second}|${third}`;
		let count = 1;

		return join(count++, await tick(base + count), count);
	};
	const cond = async (flag) => (flag ? await tick('yes') : 'no');
	const logic = async (value) =>
		[value && (await tick(value * 2)), !value || (await tick('or'))].join(',');
	const choose = async (key) => {
		switch (await tick(key)) {
			case 1:
				return 'one';
			case 2: {
				const two = await tick('two');

				return two + '!';
			}
			default:
				return 'other';
		}
	};
	const early = async (reason) => {
		if (reason) throw new Error('sync ' + reason);
		await tick(0);

		return 'late';
	};
	const nested = async (depth) => (depth === 0 ? 0 : 1 + (await nested(depth - 1)));

	log.push(await sum(2, 3), await args(5), await cond(true), await cond(false));
	log.push(await logic(3), await logic(0), await choose(1), await choose(2), await choose(9));

	try {
		await early('x');
	} catch (error) {
		log.push('caught ' + error.message);
	}
	log.push(await early(''));

	try {
		await fail('boom');
	} catch (error) {
		log.push('rejected ' + error.message);
	}
	log.push(await nested(50));
	log.push(JSON.stringify({ one: await tick(1), rest: [await tick(2), await tick(3)] }));
	log.push((await Promise.all([sum(1, 1), sum(2, 2), nested(5)])).join('/'));

	return log.join('\n');
}

// an await suspends even on a value that is not a promise: the caller runs on first
async function awaitOrder() {
	const order = [];
	const started = (async () => {
		order.push('a1');
		await null;
		order.push('a2');
		await tick();
		order.push('a3');
	})();

	order.push('sync');
	await started;

	return order.join(' ');
}

// many suspended calls holding live objects while garbage piles up around them
async function asyncGc() {
	const build = async (id) => {
		const keep = { id, name: 'item-' + id, parts: [] };

		for (let part = 0; part < 40; part++) {
			const junk = [];

			for (let bit = 0; bit < 50; bit++) junk.push({ bit, text: 'x'.repeat(bit) + part });
			keep.parts.push((await tick('p' + part)) + ':' + junk.length);
		}

		return keep;
	};
	let total = 0;
	let bad = 0;

	for (let round = 0; round < 10; round++) {
		const items = await Promise.all(
			Array.from({ length: 10 }, (_value, slot) => build(round * 10 + slot))
		);

		for (const item of items) {
			total += item.parts.length;

			if (item.name !== 'item-' + item.id || item.parts[39] !== 'p39:50') bad++;
		}
	}

	return total + ' parts, bad ' + bad;
}

// which locals must outlive a suspension (the step's frame), and which need not
async function frameLiveness() {
	const sibling = async (awaits) => {
		let seen = 'before';

		if (awaits) await tick();
		else seen = 'else';

		return seen;
	};
	const scratch = async (start) => {
		let doubled = start * 2;

		doubled = await tick(doubled);
		let next = doubled + 1;

		await tick();
		next *= 10;

		return next;
	};
	const deep = async (outer, inner) => {
		let value = 5;

		if (outer) {
			await tick();

			if (inner) value = 1;
		}

		return value;
	};

	return [
		await sibling(true),
		await sibling(false),
		await scratch(3),
		await deep(true, true),
		await deep(true, false),
		await deep(false, true)
	].join(' ');
}

// awaits in loops: conditions, carried values, continue, break, nesting
async function asyncLoops() {
	const carry = async (count) => {
		let previous = 'start';
		const out = [];

		for (let index = 0; index < count; index++) {
			out.push(previous);
			previous = await tick('v' + index);
		}

		return out.join(',');
	};
	const skip = async (count) => {
		let last = 'none';

		for (let index = 0; index < count; index++) {
			if (index % 2) continue;
			await tick();
			last = 'i' + index;
		}

		return last;
	};
	const whileAwait = async (count) => {
		let index = 0;
		const seen = [];

		while ((await tick(index)) < count) seen.push(index++);

		return seen.join('');
	};
	const nestedLoop = async () => {
		let text = '';

		for (let row = 0; row < 3; row++)
			for (let column = 0; column < 2; column++) text += (await tick(row)) + '' + column + ' ';

		return text;
	};
	const stop = async (count) => {
		for (let index = 0; index < count; index++) if ((await tick(index * index)) > 10) return index;

		return -1;
	};

	return [
		await carry(4),
		await skip(5),
		await whileAwait(4),
		await nestedLoop(),
		await stop(10)
	].join(' | ');
}

// awaits inside try, catch and finally, and exits through them
async function asyncTry() {
	const log = [];
	const nested = async () => {
		const seen = [];

		try {
			try {
				await fail('inner');
			} catch (error) {
				seen.push(error.message);
				await tick();
				throw new Error('re', { cause: error });
			}
		} catch (error) {
			seen.push(error.message);
		}

		return seen.join(',');
	};
	const inLoop = async (count) => {
		let sum = 0;

		for (let index = 0; index < count; index++) {
			try {
				if (index % 2) await fail('odd');
				sum += await tick(index);
			} catch {
				sum += 100;
			}
		}

		return sum;
	};
	const withFinally = async (throws) => {
		const seen = [];

		try {
			try {
				seen.push('t');

				if (throws) await fail('x');
				await tick();
			} finally {
				seen.push('f');
				await tick();
				seen.push('f2');
			}
		} catch (error) {
			seen.push('outer ' + error.message);
		}

		return seen.join(',');
	};
	const exits = async () => {
		let total = 0;

		for (let index = 0; index < 4; index++) {
			try {
				await tick();

				if (index % 2) continue;

				if (index === 2) break;
				total += 10;
			} finally {
				total += 1;
			}
		}

		try {
			await fail('after');
		} catch (error) {
			return total + ' ' + error.message;
		}

		return 'unreachable';
	};
	let before = 1;

	try {
		before = await tick(2);
		throw new Error('late');
	} catch (error) {
		log.push(error.message + ' x=' + before);
	}
	log.push(await nested(), await inLoop(5), await withFinally(false), await withFinally(true));
	log.push(await exits());

	try {
		await (async () => {
			try {
				await tick();
			} catch {
				log.push('wrong');
			}
			await tick();
			throw new TypeError('escapes');
		})();
	} catch (error) {
		log.push(error.name + ' ' + error.message);
	}

	return log.join('\n');
}

// for await with object rest in its head
async function forAwaitRest() {
	let reads = 0;
	const seen = [];
	const source = {
		get value() {
			reads++;

			return 2;
		}
	};

	for await (const { ...rest } of [source]) seen.push(rest.value, reads);

	return seen.join(',');
}

// generators: two-way next, yield* (generators, arrays, recursion), throw() in, errors out
async function generators() {
	const log = [];

	function* count(limit) {
		for (let index = 0; index < limit; index++) yield index;

		return 'end';
	}
	function* echo() {
		const got = [];
		let sent = yield 'start';

		while (sent !== 'stop') {
			got.push(sent);
			sent = yield sent * 2;
		}

		return got.join('+');
	}
	function* inner() {
		yield 1;
		yield 2;

		return 'inner-done';
	}
	function* outer() {
		const result = yield* inner();

		yield result;
		yield* [3, 4];
	}
	function* tree(node) {
		if (!node) return;
		yield* tree(node.left);
		yield node.value;
		yield* tree(node.right);
	}
	function* thrownInto() {
		try {
			yield 'a';
		} catch (error) {
			yield 'got ' + error;
		}
		yield 'after';
	}
	function* uncaught() {
		yield 1;
		throw new Error('out');
	}
	function* params(first = 5, { second } = { second: 6 }) {
		yield first + second;
	}
	function* sum() {
		return (yield 'q1') + (yield 'q2');
	}

	const counter = count(2);

	log.push(
		[...count(4)].join(','),
		JSON.stringify([counter.next(), counter.next(), counter.next()])
	);
	const echoing = echo();

	log.push(
		[
			echoing.next().value,
			echoing.next(1).value,
			echoing.next(2).value,
			echoing.next('stop').value
		].join(' ')
	);
	const root = { value: 2, left: { value: 1 }, right: { value: 3, right: { value: 4 } } };

	log.push([...outer()].join(','), [...tree(root)].join(','));
	const thrown = thrownInto();

	log.push(
		[thrown.next().value, thrown.throw('boom').value, thrown.next().value, thrown.next().done].join(
			' '
		)
	);
	const failing = uncaught();

	failing.next();

	try {
		failing.next();
	} catch (error) {
		log.push('rethrown ' + error.message + ' ' + JSON.stringify(failing.next()));
	}
	log.push([...params()].join(','), [...params(1, { second: 2 })].join(','));
	const summing = sum();

	summing.next();
	summing.next(10);
	log.push(JSON.stringify(summing.next(32)));

	return log.join('\n');
}

// return() runs finally blocks: at a yield, through yield*, and one that yields again;
// not yet started, it runs nothing
async function generatorReturn() {
	const log = [];

	function* closes() {
		try {
			yield 1;
			yield 2;
		} finally {
			log.push('fin');
		}
	}
	function* yieldsInFinally() {
		try {
			yield 1;
		} finally {
			yield 'cleanup';
			log.push('after-cleanup');
		}
	}
	function* innerGenerator() {
		try {
			yield 'i1';
			yield 'i2';
		} finally {
			log.push('inner-fin');
		}
	}
	function* outerGenerator() {
		try {
			yield* innerGenerator();
		} finally {
			log.push('outer-fin');
		}
	}

	let generator = closes();

	generator.next();
	log.push(JSON.stringify(generator.return('r')) + ' ' + JSON.stringify(generator.next()));
	generator = yieldsInFinally();
	generator.next();
	log.push(JSON.stringify(generator.return('r2')) + ' ' + JSON.stringify(generator.next()));
	generator = closes();
	log.push(JSON.stringify(generator.return('early')));
	generator = outerGenerator();
	generator.next();
	log.push(JSON.stringify(generator.return('x')));

	return log.join('\n');
}

// async generators: awaits between yields, try/catch/finally, yield* over one, return()
async function asyncGenerators() {
	const log = [];

	async function* numbers(count) {
		for (let index = 0; index < count; index++) {
			await tick();
			yield index * 10;
		}

		return 'done';
	}
	async function* guarded() {
		try {
			yield await tick('t');
			throw new Error('err');
		} catch (error) {
			yield error.message;
		} finally {
			await tick();
			log.push('fin');
		}
	}
	async function* delegating() {
		yield* numbers(2);
		yield 'own';
	}

	const out = [];

	for await (const value of numbers(3)) out.push(value);
	log.push(out.join(','));
	const iterator = numbers(2);

	log.push(JSON.stringify([await iterator.next(), await iterator.next(), await iterator.next()]));
	const guardedOut = [];

	for await (const value of guarded()) guardedOut.push(value);
	log.push(guardedOut.join(','));
	const delegated = [];

	for await (const value of delegating()) delegated.push(value);
	log.push(delegated.join(','));
	const returning = guarded();

	await returning.next();
	log.push(JSON.stringify(await returning.return('r')));

	return log.join('\n');
}

// a generator is closed when break, continue to an outer loop or return leaves its for...of
async function generatorClose() {
	const log = [];

	function* numbers(name) {
		try {
			for (let index = 0; index < 5; index++) yield index;
		} finally {
			log.push(name + ':fin');
		}
	}
	function* looping() {
		for (const value of numbers('gl')) yield value;
	}
	const broken = () => {
		for (const value of numbers('brk')) if (value === 1) break;
	};
	const returned = () => {
		for (const value of numbers('ret'))
			if (value === 2) return 'ret ' + value + ' ' + log.includes('ret:fin');

		return 'unreachable';
	};
	const labelled = () => {
		outer: for (const first of numbers('A'))
			for (const second of numbers('B')) {
				if (second === 1) continue outer;

				if (first === 2) break outer;
			}
	};
	const finished = () => {
		let sum = 0;

		for (const value of numbers('done')) sum += value;

		return sum;
	};
	const crossesFinally = () => {
		for (const value of numbers('x'))
			try {
				return 'x' + value;
			} finally {
				log.push('inner-fin');
			}

		return 'unreachable';
	};

	broken();
	log.push(returned());
	labelled();
	log.push(finished(), crossesFinally());
	const generator = looping();

	generator.next();
	log.push(JSON.stringify(generator.return('glr')));

	return log.join(',');
}

// an async generator is closed (awaited, its finally may await) when a loop is left early
async function asyncGeneratorClose() {
	const log = [];

	async function* numbers(name) {
		try {
			for (let index = 0; index < 5; index++) {
				await tick();
				yield index;
			}
		} finally {
			log.push(name + ':fin1');
			await tick();
			log.push(name + ':fin2');
		}
	}
	async function* looping() {
		for await (const value of numbers('gl')) yield value;
	}
	const returned = async () => {
		for await (const value of numbers('ret'))
			if (value === 2) return 'ret ' + value + ' ' + log.includes('ret:fin2');

		return 'unreachable';
	};

	for await (const value of numbers('brk')) if (value === 1) break;
	log.push(await returned());

	outer: for await (const first of numbers('A'))
		for await (const second of numbers('B')) {
			if (first === 1) break outer;

			if (second === 1) continue outer;
		}
	const iterator = looping();

	await iterator.next();
	log.push(JSON.stringify(await iterator.return('r')));

	return log.join(',');
}

// Known gap, both modes: an await of a settled promise takes no tick, and awaiting does
// not look the promise's constructor up
async function promiseTicks() {
	const actual = [];
	const iterable = {
		[Symbol.asyncIterator]() {
			const values = [Promise.resolve(0)][Symbol.iterator]();

			return { next: () => Promise.resolve(values.next()) };
		}
	};
	const loop = async () => {
		actual.push('pre');

		for await (const value of iterable) actual.push('loop ' + value);
		actual.push('post');
	};
	const ticks = Promise.resolve(0)
		.then(() => actual.push('tick 1'))
		.then(() => actual.push('tick 2'));

	await Promise.all([loop(), ticks]);

	return actual.join(',');
}

// Known gap, both modes (a choice): a throw out of for...of does not close a generator on
// the fast path, where break and return do
async function closeOnThrow() {
	const log = [];

	function* numbers() {
		try {
			yield 1;
			yield 2;
		} finally {
			log.push('fin');
		}
	}

	try {
		for (const value of numbers()) throw new Error('t' + value);
	} catch (error) {
		log.push(error.message);
	}

	return log.join(',');
}

export const cases = {
	asyncBasics,
	awaitOrder,
	asyncGc,
	frameLiveness,
	asyncLoops,
	asyncTry,
	forAwaitRest,
	generators,
	generatorReturn,
	asyncGenerators,
	generatorClose,
	asyncGeneratorClose,
	promiseTicks,
	closeOnThrow
};
