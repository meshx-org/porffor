// The classes that are WebIDL interfaces, as each declares itself: defineInterface records the
// class, its interface name and options, and ./webidl-shape.mjs gives them WebIDL's shape
// (enumerable members, the interface's name, @@toStringTag, `this` and argument-count checks)
// when a program is built with it. That one is loaded only for a program whose text looks at
// shapes (runtime/globals.json's load pattern: property descriptors, @@toStringTag,
// Object.prototype.toString), so a program that only calls the APIs carries a push per class.

/** @typedef {{ promises?: string[], iterable?: boolean }} InterfaceOptions */

/**
 * The interfaces declared so far, and the shaper once ./webidl-shape.mjs is loaded. Kept on
 * this function, not in a module binding: a bundle may run a class's module (and so its
 * defineInterface call) before this one's top-level code, but never before its functions exist.
 * @returns {{ declared: [Function, string, InterfaceOptions][], shape: ((cls: Function, name: string, options: InterfaceOptions) => void) | null }}
 */
export function interfaceRegistry() {
	if (interfaceRegistry.state === undefined)
		interfaceRegistry.state = { declared: [], shape: null };

	return interfaceRegistry.state;
}

/**
 * Declares a class as the WebIDL interface `name` (see above).
 * @param {Function} cls
 * @param {string} name
 * @param {InterfaceOptions} [options] the operations that return promises (they reject, not
 *   throw); whether it is a pair iterable (@@iterator is entries)
 */
export function defineInterface(cls, name, options = {}) {
	const registry = interfaceRegistry();

	if (registry.shape === null) registry.declared.push([cls, name, options]);
	else registry.shape(cls, name, options);
}

/** Whether a value is an object (WebIDL's Type(V) is Object). */
export const isObject = (value) =>
	(typeof value === 'object' && value !== null) || typeof value === 'function';

/**
 * The pairs an init of sequence<sequence<T>> or record<K, T> holds (Headers', URLSearchParams'),
 * each key and value converted by `convert` (to a string type) as WebIDL converts them: a
 * sequence's items (each an iterable of exactly two), or a record's own enumerable keys with their
 * values, in order, each key converted before its value is read.
 * @param {object} init
 * @param {string} what the interface, for errors
 * @param {(value: unknown) => string} convert
 * @returns {[string, string][]}
 */
export function initPairs(init, what, convert) {
	const method = init[Symbol.iterator];
	const out = [];

	if (method === undefined || method === null) {
		// (a symbol key is kept: converting it to a string type throws, as WebIDL's does)
		for (const key of Reflect.ownKeys(init)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(init, key);

			if (descriptor === undefined || !descriptor.enumerable) continue;
			const name = convert(key);

			out.push([name, convert(init[key])]);
		}

		return out;
	}

	if (typeof method !== 'function') throw new TypeError(`${what}: init is not iterable`);

	for (const pair of { [Symbol.iterator]: () => method.call(init) }) {
		if (!isObject(pair)) throw new TypeError(`${what}: each pair must be a sequence`);
		const items = [...pair];

		if (items.length !== 2) throw new TypeError(`${what}: each pair must have exactly two items`);
		out.push([convert(items[0]), convert(items[1])]);
	}

	return out;
}

/**
 * The prototype of an interface's pair iterators ("Headers Iterator"): %IteratorPrototype%'s
 * child with next() and @@toStringTag, made once per interface.
 * @param {string} name the interface
 */
function iteratorPrototype(name) {
	if (iteratorPrototype.made === undefined) iteratorPrototype.made = new Map();
	let proto = iteratorPrototype.made.get(name);

	if (proto === undefined) {
		proto = Object.create(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));
		proto.next = function next() {
			const pairs = this._pairs(this._target);

			if (this._index >= pairs.length) return { value: undefined, done: true };
			const [key, value] = pairs[this._index++];
			const kind = this._kind;

			return { value: kind === 'key' ? key : kind === 'value' ? value : [key, value], done: false };
		};
		// (%IteratorPrototype% has this, but Porffor's for...of does not find it there)
		proto[Symbol.iterator] = function iterator() {
			return this;
		};
		proto[Symbol.toStringTag] = `${name} Iterator`;
		iteratorPrototype.made.set(name, proto);
	}

	return proto;
}

/**
 * A WebIDL pair iterator (https://webidl.spec.whatwg.org/#es-iterable): it reads the pairs again
 * at each step, so changes made while iterating show, as the spec's do.
 * @param {string} name the interface ("Headers")
 * @param {object} target what is iterated
 * @param {'key' | 'value' | 'pair'} kind
 * @param {(target: object) => [unknown, unknown][]} pairs the target's pairs, as they are now
 */
export function pairIterator(name, target, kind, pairs) {
	const iterator = Object.create(iteratorPrototype(name));

	iterator._target = target;
	iterator._kind = kind;
	iterator._pairs = pairs;
	iterator._index = 0;

	return iterator;
}
