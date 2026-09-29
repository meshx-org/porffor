// Clones a corpus with structuredClone and describes every clone (its kind, contents and
// which references it shares), or the error the clone threw. The test compares this with
// Node's own structuredClone on the same corpus.

/** A JSON-able description of a value; `seen` numbers objects, so sharing shows as #n. */
function describe(value, seen) {
	const type = typeof value;

	if (value === null) return 'null';

	if (type === 'undefined') return 'undefined';

	if (type === 'number') return Object.is(value, -0) ? '-0' : String(value);

	if (type === 'bigint') return `${String(value)}n`;

	if (type !== 'object') return `${type}:${String(value)}`;

	if (seen.has(value)) return `#${seen.get(value)}`;
	seen.set(value, seen.size);
	const props = () => Object.keys(value).map((key) => [key, describe(value[key], seen)]);

	if (value instanceof Date) return `Date:${value.getTime()}`;

	if (value instanceof RegExp) return `RegExp:${value.source}/${value.flags}:${value.lastIndex}`;

	if (value instanceof Map)
		return [
			'Map',
			...[...value].map(([key, entry]) => [describe(key, seen), describe(entry, seen)])
		];

	if (value instanceof Set) return ['Set', ...[...value].map((entry) => describe(entry, seen))];

	if (value instanceof ArrayBuffer)
		return `ArrayBuffer:${value.byteLength}:${[...new Uint8Array(value)].join(',')}`;

	if (value instanceof DataView)
		return ['DataView', value.byteOffset, value.byteLength, describe(value.buffer, seen)];

	if (ArrayBuffer.isView(value))
		return [
			'TypedArray',
			value instanceof Uint8Array,
			value.byteOffset,
			value.length,
			describe(value.buffer, seen)
		];

	if (value instanceof Error)
		return ['Error', value.name, value.message, describe(value.cause, seen)];

	if (value instanceof Boolean || value instanceof Number || value instanceof String)
		return ['Wrapper', typeof value.valueOf(), String(value.valueOf())];

	if (Array.isArray(value)) return ['Array', value.length, ...props()];

	return ['Object', Object.getPrototypeOf(value) === Object.prototype, ...props()];
}

/** The clone of `value` described, or the name of what cloning it threw. */
function attempt(value, options) {
	try {
		const out = structuredClone(value, options);

		return [
			out === value && typeof value === 'object' && value !== null ? 'same' : 'copy',
			describe(out, new Map())
		];
	} catch (error) {
		return ['threw', error.name];
	}
}

export function run() {
	const cyclic = { name: 'loop' };

	cyclic.self = cyclic;
	const shared = { n: 1 };
	const holes = [1, 2, 3];

	delete holes[1];
	holes.extra = 'x';
	const buffer = new ArrayBuffer(8);
	const bytes = new Uint8Array(buffer, 2, 4);

	bytes.set([1, 2, 3, 4]);
	const regex = /a+b/gi;

	regex.lastIndex = 3;
	// an object with a prototype of its own: its clone is a plain object
	const point = Object.create({ inherited: true });

	point.x = 1;
	point.y = 2;
	// an error of a kind structuredClone does not know: an Error
	const mine = new Error('mine');

	mine.name = 'MyError';
	const moved = new ArrayBuffer(4);

	new Uint8Array(moved).set([9, 8, 7, 6]);
	const corpus = [
		1,
		'text',
		true,
		null,
		undefined,
		-0,
		Number.NaN,
		12345678901234567890n,
		{ a: 1, b: { c: [1, 2, 3] } },
		holes,
		new Date(1_000_000),
		regex,
		new Map([
			[{ k: 1 }, 'object key'],
			['s', shared]
		]),
		new Set([1, 'two', shared]),
		cyclic,
		{ x: shared, y: shared },
		[buffer, bytes, new DataView(buffer, 1, 4)],
		new TypeError('bad type', { cause: shared }),
		mine,
		point,
		{
			get computed() {
				return 42;
			}
		},
		[new Boolean(false), new Number(3), new String('s')],
		() => 1,
		Symbol('s'),
		new WeakMap(),
		Promise.resolve(1),
		{
			method() {
				return 1;
			}
		}
	];
	const out = corpus.map((value) => attempt(value));

	out.push(attempt({ moved }, { transfer: [moved] }), [moved.byteLength]);

	return JSON.stringify(out);
}
