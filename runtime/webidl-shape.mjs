// The shape WebIDL gives an interface (https://webidl.spec.whatwg.org/#es-interfaces), put on
// the runtime's classes that declare themselves interfaces (./webidl.mjs): a JS class's methods
// and accessors are not enumerable, its name is whatever the bundle renamed it to, and nothing
// checks `this` or how many arguments came. Here the prototype's members are made enumerable,
// the class named, the prototype given its @@toStringTag, and each operation that takes
// arguments, and each attribute getter and setter, wrapped in a check: `this` must be an instance
// (TypeError, or a rejected promise for an operation returning one), and an operation needs its
// required arguments.
//
// A member's required argument count is its JS length: an optional argument is written with a
// default (`delete(name, value = undefined)`), as a JS function's length counts only those
// before the first default. Members named with a leading _ are the runtime's own and are left
// alone.
//
// Its own provider (runtime/globals.json), loaded only for a program that looks at shapes: the
// wrappers and descriptor work cost a program some 30 KB, which one that only calls the APIs
// does not carry. It shapes the classes declared before it loaded, and those declared after.

import { interfaceRegistry } from './webidl.mjs';

/**
 * An operation or getter that checks `this` and the argument count before running.
 * @param {Function | null} brand the class `this` must be an instance of (null: a static)
 * @param {Function} body
 * @param {string} name
 * @param {number} required
 * @param {boolean} promise whether it returns a promise (it rejects, then, rather than throws)
 */
function checked(brand, body, name, required, promise) {
	const wrapper = function (...args) {
		let problem = null;

		if (brand !== null && !(this instanceof brand))
			problem = `Illegal invocation: ${name} called on an object that is not a ${brand.name}`;
		else if (args.length < required)
			problem = `${name}: ${required} argument${required === 1 ? '' : 's'} required, but only ${args.length} present`;

		if (problem === null) return body.apply(this, args);
		const error = new TypeError(problem);

		if (promise) return Promise.reject(error);
		throw error;
	};

	Object.defineProperty(wrapper, 'name', { value: name, configurable: true });
	Object.defineProperty(wrapper, 'length', { value: required, configurable: true });

	return wrapper;
}

/** Makes an object's own members enumerable, wrapping them (see checked). */
function shapeMembers(holder, brand, promises) {
	for (const key of Object.getOwnPropertyNames(holder)) {
		if (key === 'constructor' || key === 'prototype' || key === 'length' || key === 'name')
			continue;

		if (key.startsWith('_')) continue;
		const descriptor = Object.getOwnPropertyDescriptor(holder, key);

		if (typeof descriptor.value === 'function') {
			const required = descriptor.value.length;

			if (brand !== null || required > 0)
				descriptor.value = checked(brand, descriptor.value, key, required, promises.includes(key));
		} else if (brand !== null) {
			if (descriptor.get !== undefined)
				descriptor.get = checked(brand, descriptor.get, `get ${key}`, 0, false);

			if (descriptor.set !== undefined)
				descriptor.set = checked(brand, descriptor.set, `set ${key}`, 1, false);
		}
		descriptor.enumerable = true;
		Object.defineProperty(holder, key, descriptor);
	}
}

/**
 * Gives a class WebIDL's interface shape (see above).
 * @param {Function} cls
 * @param {string} name the interface's name
 * @param {import('./webidl.mjs').InterfaceOptions} options
 */
function shape(cls, name, options) {
	const promises = options.promises ?? [];
	const proto = cls.prototype;

	Object.defineProperty(cls, 'name', { value: name, configurable: true });
	shapeMembers(proto, cls, promises);
	shapeMembers(cls, null, promises);
	Object.defineProperty(proto, Symbol.toStringTag, { value: name, configurable: true });

	if (options.iterable)
		Object.defineProperty(proto, Symbol.iterator, {
			value: proto.entries,
			writable: true,
			configurable: true
		});
}

const registry = interfaceRegistry();

registry.shape = shape;

for (const [cls, name, options] of registry.declared) shape(cls, name, options);
registry.declared = [];
