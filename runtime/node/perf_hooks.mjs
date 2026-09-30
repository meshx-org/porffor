// node:perf_hooks: Node's performance object over the one Porffor builds in (now and timeOrigin
// from the platform's monotonic clock, User Timing's mark and measure: compiler/builtins), with
// Node's additions (timerify, eventLoopUtilization), and a PerformanceObserver that sees the marks
// and measures made through this module's performance. createHistogram records values;
// monitorEventLoopDelay's histogram is never fed (the loop's delay is not measured).
//
// The builtin is named as the bare `performance`, never through globalThis: this module's object
// may be put there in its place.

// observers by entry type ('mark', 'measure')
const observers = new Set();

// the entries one delivery hands an observer
class PerformanceObserverEntryList {
	constructor(entries) {
		this._entries = entries;
	}

	getEntries() {
		return this._entries.slice();
	}

	getEntriesByType(type) {
		return this._entries.filter((entry) => entry.entryType === type);
	}

	getEntriesByName(name, type) {
		return this._entries.filter(
			(entry) => entry.name === name && (type === undefined || entry.entryType === type)
		);
	}
}

// an entry made through performance.mark / measure, to each observer of its type: buffered,
// and delivered a microtask later, as Node queues them
const notify = (entry) => {
	for (const observer of observers) {
		if (!observer._types.has(entry.entryType)) continue;
		observer._buffer.push(entry);
		if (observer._buffer.length === 1)
			Promise.resolve().then(() => {
				const entries = observer._buffer.splice(0);
				if (entries.length > 0 && observers.has(observer))
					observer._callback(new PerformanceObserverEntryList(entries), observer);
			});
	}
};

/** Called with the marks and measures of the types it observes, as they are made. */
export class PerformanceObserver {
	constructor(callback) {
		if (typeof callback !== 'function') {
			const e = new TypeError(
				`The "callback" argument must be of type function. Received ${typeof callback}`
			);
			e.code = 'ERR_INVALID_ARG_TYPE';
			throw e;
		}
		this._callback = callback;
		this._types = new Set();
		this._buffer = [];
	}

	/** Observes { entryTypes: [...] } or { type }. */
	observe(options = {}) {
		const types = options.entryTypes ?? (options.type !== undefined ? [options.type] : []);
		for (const type of types) this._types.add(type);
		observers.add(this);
	}

	disconnect() {
		observers.delete(this);
		this._buffer = [];
	}

	takeRecords() {
		return this._buffer.splice(0);
	}

	static get supportedEntryTypes() {
		return ['mark', 'measure'];
	}
}

/**
 * Node's performance: now(), timeOrigin, mark and measure (seen by PerformanceObservers), the
 * entry getters and clears, timerify, eventLoopUtilization.
 */
const nodePerformance = {
	/** Milliseconds since timeOrigin, from the monotonic clock. */
	now: () => performance.now(),
	/** When the program started, in milliseconds since the epoch. */
	get timeOrigin() {
		return performance.timeOrigin;
	},
	mark(name, options) {
		const entry = performance.mark(name, options);
		notify(entry);
		return entry;
	},
	measure(name, startOrOptions, endMark) {
		const entry = performance.measure(name, startOrOptions, endMark);
		notify(entry);
		return entry;
	},
	getEntries: () => performance.getEntries(),
	getEntriesByType: (type) => performance.getEntriesByType(type),
	getEntriesByName: (name, type) => performance.getEntriesByName(name, type),
	clearMarks: (name) => performance.clearMarks(name),
	clearMeasures: (name) => performance.clearMeasures(name),
	clearResourceTimings: () => undefined,
	toJSON: () => performance.toJSON(),

	/** fn, unchanged: its calls are not recorded as 'function' entries. */
	timerify: (fn) => fn,

	/** The loop's utilization; not measured here, so all idle. */
	eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),

	/** Node's startup milestones: only when the program started is known. */
	get nodeTiming() {
		return { name: 'node', entryType: 'node', startTime: 0, duration: performance.now() };
	}
};

// ---- histograms ----

class Histogram {
	constructor() {
		this.reset();
	}

	reset() {
		this._values = [];
		this.min = 9223372036854776000;
		this.max = 0;
		this.mean = Number.NaN;
		this.stddev = Number.NaN;
		this.count = 0;
		this.exceeds = 0;
	}

	/** The value at a percentile (0 to 100) of those recorded. */
	percentile(p) {
		if (this._values.length === 0) return 0;
		const sorted = this._values.slice().sort((a, b) => a - b);
		const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
		return sorted[at];
	}

	get percentiles() {
		const out = new Map();
		for (const p of [0, 50, 75, 87.5, 93.75, 96.875, 98.4375, 99.21875, 100])
			if (this._values.length > 0) out.set(p, this.percentile(p));
		return out;
	}
}

class RecordableHistogram extends Histogram {
	/** Records a value (an integer >= 1). */
	record(value) {
		const n = Number(value);
		this._values.push(n);
		this.count++;
		if (n < this.min) this.min = n;
		if (n > this.max) this.max = n;
		let sum = 0;
		for (const v of this._values) sum += v;
		this.mean = sum / this.count;
		let squares = 0;
		for (const v of this._values) squares += (v - this.mean) ** 2;
		this.stddev = Math.sqrt(squares / this.count);
	}

	/** Records the time since the previous call, in nanoseconds. */
	recordDelta() {
		const now = performance.now();
		if (this._last !== undefined) this.record(Math.max(1, Math.round((now - this._last) * 1e6)));
		this._last = now;
	}
}

/** A histogram values can be recorded into. */
export const createHistogram = () => new RecordableHistogram();

/** A histogram of the loop's delay: enable() and disable() work, it is never fed. */
export const monitorEventLoopDelay = () => {
	const histogram = new Histogram();
	histogram.enable = () => true;
	histogram.disable = () => true;
	return histogram;
};

export const constants = {
	NODE_PERFORMANCE_GC_MAJOR: 4,
	NODE_PERFORMANCE_GC_MINOR: 1,
	NODE_PERFORMANCE_GC_INCREMENTAL: 8,
	NODE_PERFORMANCE_GC_WEAKCB: 16
};

export { nodePerformance as performance };

export default {
	performance: nodePerformance,
	PerformanceObserver,
	createHistogram,
	monitorEventLoopDelay,
	constants
};
