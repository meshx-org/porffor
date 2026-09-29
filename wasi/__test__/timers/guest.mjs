// The timers fixture: setTimeout ordering, a cleared timeout, an interval cleared from its
// own callback, AbortController / AbortSignal, the scheduler, and User Timing marks and measures around the waits.

const sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export async function run() {
	const order = [];
	const start = performance.now();

	performance.mark('start');
	const done = new Promise((resolve) => {
		setTimeout(() => order.push('late'), 120);
		setTimeout(() => order.push('early'), 30);
		setTimeout((word) => order.push(word), 60, 'middle');
		const never = setTimeout(() => order.push('cleared'), 40);

		clearTimeout(never);
		setTimeout(resolve, 150);
	});

	await done;

	let ticks = 0;

	await new Promise((resolve) => {
		const id = setInterval(() => {
			ticks++;

			if (ticks === 3) {
				clearInterval(id);
				resolve();
			}
		}, 20);
	});
	// a timer cleared long before it ends must not keep run() waiting
	clearTimeout(setTimeout(() => order.push('abandoned'), 5000));
	// AbortController and AbortSignal: listeners, reasons, timeout, any
	const controller = new AbortController();
	const heard = [];

	controller.signal.addEventListener('abort', () => heard.push('listener'));
	controller.signal.onabort = () => heard.push('onabort');
	controller.abort();
	controller.abort('again');
	const timeout = AbortSignal.timeout(30);
	const either = AbortSignal.any([new AbortController().signal, timeout]);

	await sleep(60);
	// the scheduler: microtasks first, then yields in the order asked; a cleared immediate
	// never runs; an idle callback gets a budget
	const steps = [];
	const skipped = setImmediate(() => steps.push('cleared'));

	clearImmediate(skipped);
	setImmediate((word) => steps.push(word), 'immediate');
	scheduler.yield().then(() => steps.push('yield'));
	Promise.resolve().then(() => steps.push('micro'));
	const budget = await new Promise((resolve) => {
		requestIdleCallback((deadline) => resolve(deadline.timeRemaining()));
	});

	// a busy loop that yields lets the host run: a timer set before it fires during it
	let firedAt = -1;
	let spins = 0;

	setTimeout(() => {
		firedAt = spins;
	}, 20);
	const until = performance.now() + 150;

	while (performance.now() < until) {
		spins++;
		await scheduler.yield();
	}

	performance.mark('end');
	const measure = performance.measure('run', 'start', 'end');

	return JSON.stringify({
		order: order.join(','),
		ticks,
		elapsed: performance.now() - start,
		measured: measure.duration,
		entries: performance
			.getEntries()
			.map((entry) => entry.entryType + ':' + entry.name)
			.join(','),
		marks: performance.getEntriesByType('mark').length,
		scheduler: { steps: steps.join(','), budget, firedAt, spins },
		abort: {
			heard: heard.join(','),
			reason: controller.signal.reason.name,
			timeout: timeout.aborted && timeout.reason.name,
			any: either.aborted && either.reason.name,
			thrown: (() => {
				try {
					AbortSignal.abort('why').throwIfAborted();
				} catch (error) {
					return error;
				}

				return 'nothing';
			})()
		}
	});
}
