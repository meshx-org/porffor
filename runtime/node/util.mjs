// node:util: inspect and format as Node prints values (the same layout rules: one line while it
// fits in 80 columns, arrays of short entries in columns, <ref *1> for cycles, depth 2), the
// promise helpers (promisify, callbackify), deprecate, inherits, isDeepStrictEqual, the type
// checks (util.types), debuglog, styleText and a basic parseArgs.
//
// What Porffor cannot tell apart is shown as best it can be: a promise's state (Promise { <pending>
// } whatever it is), an async function (a plain [Function]), a Proxy (its target). No colors.
import { argCount, arg, getenv, isTTY, pid } from 'porffor:process';

const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');

const codeError = (Kind, code, message) => {
	const e = new Kind(message);
	e.code = code;
	return e;
};

const invalidArgType = (name, expected, value) =>
	codeError(
		TypeError,
		'ERR_INVALID_ARG_TYPE',
		`The "${name}" argument must be ${expected}. Received ${value === null ? 'null' : typeof value === 'function' ? `function ${value.name}` : `type ${typeof value} (${String(value)})`}`
	);

// ---- types ----

const tag = (value) => Object.prototype.toString.call(value).slice(8, -1);
const typedArrayName = (value) =>
	ArrayBuffer.isView(value) && !(value instanceof DataView) ? tag(value) : undefined;

const isTypedArrayOf = (name) => (value) => typedArrayName(value) === name;

/** Node's util.types: what kind of built-in object a value is. */
export const types = {
	isPromise: (value) => value instanceof Promise,
	isDate: (value) => value instanceof Date,
	isRegExp: (value) => value instanceof RegExp,
	isMap: (value) => value instanceof Map,
	isSet: (value) => value instanceof Set,
	isWeakMap: (value) => value instanceof WeakMap,
	isWeakSet: (value) => value instanceof WeakSet,
	isArrayBuffer: (value) => value instanceof ArrayBuffer,
	isSharedArrayBuffer: (value) =>
		typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer,
	isAnyArrayBuffer: (value) =>
		value instanceof ArrayBuffer ||
		(typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer),
	isArrayBufferView: (value) => ArrayBuffer.isView(value),
	isDataView: (value) => value instanceof DataView,
	isTypedArray: (value) => typedArrayName(value) !== undefined,
	isInt8Array: isTypedArrayOf('Int8Array'),
	isUint8Array: isTypedArrayOf('Uint8Array'),
	isUint8ClampedArray: isTypedArrayOf('Uint8ClampedArray'),
	isInt16Array: isTypedArrayOf('Int16Array'),
	isUint16Array: isTypedArrayOf('Uint16Array'),
	isInt32Array: isTypedArrayOf('Int32Array'),
	isUint32Array: isTypedArrayOf('Uint32Array'),
	isFloat32Array: isTypedArrayOf('Float32Array'),
	isFloat64Array: isTypedArrayOf('Float64Array'),
	isBigInt64Array: isTypedArrayOf('BigInt64Array'),
	isBigUint64Array: isTypedArrayOf('BigUint64Array'),
	isNativeError: (value) => value instanceof Error,
	isAsyncFunction: (value) =>
		typeof value === 'function' &&
		(value.constructor?.name === 'AsyncFunction' ||
			value.constructor?.name === 'AsyncGeneratorFunction'),
	isGeneratorFunction: (value) =>
		typeof value === 'function' &&
		(value.constructor?.name === 'GeneratorFunction' ||
			value.constructor?.name === 'AsyncGeneratorFunction'),
	isGeneratorObject: (value) => tag(value) === 'Generator' || tag(value) === 'AsyncGenerator',
	isMapIterator: (value) => tag(value) === 'Map Iterator',
	isSetIterator: (value) => tag(value) === 'Set Iterator',
	isNumberObject: (value) => typeof value === 'object' && value instanceof Number,
	isStringObject: (value) => typeof value === 'object' && value instanceof String,
	isBooleanObject: (value) => typeof value === 'object' && value instanceof Boolean,
	isBigIntObject: (value) => typeof value === 'object' && value instanceof BigInt,
	isSymbolObject: (value) => typeof value === 'object' && value instanceof Symbol,
	isBoxedPrimitive: (value) =>
		typeof value === 'object' &&
		(value instanceof Number ||
			value instanceof String ||
			value instanceof Boolean ||
			value instanceof BigInt ||
			value instanceof Symbol),
	isProxy: () => false,
	isExternal: () => false,
	isModuleNamespaceObject: (value) => tag(value) === 'Module',
	isArgumentsObject: (value) => tag(value) === 'Arguments',
	isKeyObject: () => false,
	isCryptoKey: (value) => tag(value) === 'CryptoKey'
};

// ---- inspect ----

const defaultOptions = {
	showHidden: false,
	depth: 2,
	colors: false,
	customInspect: true,
	showProxy: false,
	maxArrayLength: 100,
	maxStringLength: 10000,
	breakLength: 80,
	compact: 3,
	sorted: false,
	getters: false,
	numericSeparator: false
};

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

// a string as Node quotes it: single quotes, unless it has some and no double quotes (then
// double), or both and no backticks (then backticks); control characters escaped
const quote = (string) => {
	let q = "'";
	if (string.includes("'")) {
		if (!string.includes('"')) q = '"';
		else if (!string.includes('`') && !string.includes('${')) q = '`';
	}
	let out = q;
	for (let i = 0; i < string.length; i++) {
		const c = string.charCodeAt(i);
		const ch = string[i];
		if (ch === q || ch === '\\') out += '\\' + ch;
		else if (c === 10) out += '\\n';
		else if (c === 9) out += '\\t';
		else if (c === 13) out += '\\r';
		else if (c === 8) out += '\\b';
		else if (c === 12) out += '\\f';
		else if (c === 11) out += '\\x0B';
		else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).toUpperCase().padStart(2, '0');
		else if (c >= 0xd800 && c <= 0xdfff) {
			const next = string.charCodeAt(i + 1);
			if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
				out += ch + string[i + 1];
				i++;
			} else out += '\\u' + c.toString(16).toUpperCase();
		} else out += ch;
	}
	return out + q;
};

const formatNumber = (n) => (Object.is(n, -0) ? '-0' : String(n));

const formatPrimitive = (value, ctx) => {
	switch (typeof value) {
		case 'string': {
			let string = value;
			let trailer = '';
			if (value.length > ctx.maxStringLength) {
				const more = value.length - ctx.maxStringLength;
				string = value.slice(0, ctx.maxStringLength);
				trailer = `... ${more} more character${more > 1 ? 's' : ''}`;
			}
			return quote(string) + trailer;
		}
		case 'number':
			return formatNumber(value);
		case 'bigint':
			return `${value}n`;
		case 'boolean':
			return String(value);
		case 'undefined':
			return 'undefined';
		case 'symbol':
			return value.toString();
	}
	return 'null';
};

// own keys in the order Node lists them: integer keys ascending, then strings, then symbols
// (the engine's order is not always that), the enumerable ones unless showHidden
const ownKeys = (value, showHidden) => {
	const integers = [];
	const strings = [];
	const symbols = [];
	for (const key of Reflect.ownKeys(value)) {
		if (!showHidden && !Object.prototype.propertyIsEnumerable.call(value, key)) continue;
		if (typeof key === 'symbol') symbols.push(key);
		else if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295) integers.push(key);
		else strings.push(key);
	}
	integers.sort((a, b) => a - b);
	return integers.concat(strings, symbols);
};

const isClass = (fn) => {
	const descriptor = Object.getOwnPropertyDescriptor(fn, 'prototype');
	return descriptor !== undefined && descriptor.writable === false;
};

const functionBase = (fn) => {
	const ctorName = fn.constructor?.name;
	if (isClass(fn)) {
		let base = `[class ${fn.name || '(anonymous)'}`;
		const parent = Object.getPrototypeOf(fn);
		if (parent !== null && parent !== Function.prototype && parent.name)
			base += ` extends ${parent.name}`;
		return base + ']';
	}
	const kind =
		ctorName === 'AsyncFunction' ||
		ctorName === 'GeneratorFunction' ||
		ctorName === 'AsyncGeneratorFunction'
			? ctorName
			: 'Function';
	return `[${kind}${fn.name ? `: ${fn.name}` : ' (anonymous)'}]`;
};

// the name a constructed object shows before its braces: its constructor's (Foo {}), or
// [Object: null prototype] without one
const constructorName = (value) => {
	let proto = Object.getPrototypeOf(value);
	while (proto !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(proto, 'constructor');
		if (
			descriptor !== undefined &&
			typeof descriptor.value === 'function' &&
			descriptor.value.name !== ''
		)
			return descriptor.value.name;
		proto = Object.getPrototypeOf(proto);
	}
	return null;
};

// "Foo [tag] " or "[Object: null prototype] " etc.: the prefix of an object's braces
const prefix = (ctorName, tagName, fallback, size = '') => {
	if (ctorName === null) {
		if (tagName !== '' && tagName !== fallback)
			return `[${fallback}${size}: null prototype] [${tagName}] `;
		return `[${fallback}${size}: null prototype] `;
	}
	if (tagName !== '' && ctorName !== tagName) return `${ctorName}${size} [${tagName}] `;
	return `${ctorName}${size} `;
};

const errorString = (error) => {
	const stack = typeof error.stack === 'string' ? error.stack : '';
	if (stack.includes('\n    at ')) return stack;
	let name = 'Error';
	let message = '';
	try {
		name = error.name ?? 'Error';
		message = error.message ?? '';
	} catch {
		// a throwing getter: the defaults
	}
	const head = stack !== '' ? stack : message === '' ? String(name) : `${name}: ${message}`;
	return `[${head}]`;
};

const isBelowBreakLength = (ctx, output, start, base) => {
	let total = output.length + start;
	if (total + output.length > ctx.breakLength) return false;
	for (const entry of output) {
		total += entry.length;
		if (total > ctx.breakLength) return false;
	}
	return base === '' || !base.includes('\n');
};

// Node's groupArrayElements: many short entries of an array, in aligned columns
const groupArrayElements = (ctx, output, value) => {
	let totalLength = 0;
	let maxLength = 0;
	let outputLength = output.length;
	if (ctx.maxArrayLength < output.length) outputLength--;
	const separatorSpace = 2;
	const dataLen = [];
	for (let i = 0; i < outputLength; i++) {
		const len = output[i].length;
		dataLen.push(len);
		totalLength += len + separatorSpace;
		if (maxLength < len) maxLength = len;
	}
	const actualMax = maxLength + separatorSpace;
	if (
		actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
		(totalLength / actualMax > 5 || maxLength <= 6)
	) {
		const averageBias = Math.sqrt(actualMax - totalLength / output.length);
		const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
		const columns = Math.min(
			Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
			Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
			ctx.compact * 4,
			15
		);
		if (columns <= 1) return output;
		const maxLineLength = [];
		for (let i = 0; i < columns; i++) {
			let lineLength = 0;
			for (let j = i; j < output.length; j += columns)
				if (dataLen[j] > lineLength) lineLength = dataLen[j];
			maxLineLength.push(lineLength + separatorSpace);
		}
		let padStart = true;
		if (value !== undefined) {
			for (let i = 0; i < output.length; i++) {
				if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') {
					padStart = false;
					break;
				}
			}
		}
		const grouped = [];
		for (let i = 0; i < outputLength; i += columns) {
			const max = Math.min(i + columns, outputLength);
			let line = '';
			let j = i;
			for (; j < max - 1; j++) {
				const cell = `${output[j]}, `;
				line += padStart
					? cell.padStart(maxLineLength[j - i], ' ')
					: cell.padEnd(maxLineLength[j - i], ' ');
			}
			line += padStart ? output[j].padStart(maxLineLength[j - i] - separatorSpace, ' ') : output[j];
			grouped.push(line);
		}
		if (ctx.maxArrayLength < output.length) grouped.push(output[outputLength]);
		return grouped;
	}
	return output;
};

// Node's reduceToSingleString: the entries on one line if they fit, else one per line
const reduceToSingleString = (ctx, output, base, braces, isArrayLike, recurseTimes, value) => {
	const entries = output.length;
	if (isArrayLike && entries > 6) output = groupArrayElements(ctx, output, value);
	if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
		const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
		if (isBelowBreakLength(ctx, output, start, base)) {
			const joined = output.join(', ');
			if (!joined.includes('\n'))
				return `${base ? `${base} ` : ''}${braces[0]} ${joined} ${braces[1]}`;
		}
	}
	const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
	return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
};

const formatKey = (key, hidden) => {
	let name;
	if (typeof key === 'symbol') name = key.toString();
	else if (IDENTIFIER.test(key)) name = key;
	else name = quote(key);
	return hidden ? `[${name}]` : name;
};

const formatProperty = (ctx, value, recurseTimes, key, isArrayEntry) => {
	const descriptor = Object.getOwnPropertyDescriptor(value, key) ?? {
		value: value[key],
		enumerable: true
	};
	let text;
	if (descriptor.value !== undefined || !('get' in descriptor || 'set' in descriptor)) {
		ctx.indentationLvl += isArrayEntry ? 2 : 2;
		text = formatValue(ctx, descriptor.value, recurseTimes);
		ctx.indentationLvl -= 2;
	} else if (descriptor.get !== undefined)
		text = descriptor.set !== undefined ? '[Getter/Setter]' : '[Getter]';
	else text = descriptor.set !== undefined ? '[Setter]' : 'undefined';
	if (isArrayEntry) return text;
	return `${formatKey(key, !descriptor.enumerable)}: ${text}`;
};

const formatArrayLike = (ctx, value, recurseTimes, keys, length) => {
	const output = [];
	const max = Math.min(length, ctx.maxArrayLength);
	let holes = 0;
	const flushHoles = () => {
		if (holes > 0) {
			output.push(`<${holes} empty item${holes > 1 ? 's' : ''}>`);
			holes = 0;
		}
	};
	for (let i = 0; i < max; i++) {
		if (!Object.prototype.hasOwnProperty.call(value, i) && !ArrayBuffer.isView(value)) {
			holes++;
			continue;
		}
		flushHoles();
		output.push(formatProperty(ctx, value, recurseTimes, i, true));
	}
	flushHoles();
	if (length > max) {
		const more = length - max;
		output.push(`... ${more} more item${more > 1 ? 's' : ''}`);
	}
	// the other own keys: those that are not indices
	for (const key of keys) {
		if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length) continue;
		output.push(formatProperty(ctx, value, recurseTimes, key, false));
	}
	return output;
};

const hexBytes = (buffer, max) => {
	const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, max));
	let out = '';
	for (let i = 0; i < bytes.length; i++)
		out += (i > 0 ? ' ' : '') + bytes[i].toString(16).padStart(2, '0');
	if (buffer.byteLength > max)
		out += ` ... ${buffer.byteLength - max} more byte${buffer.byteLength - max > 1 ? 's' : ''}`;
	return out;
};

function formatValue(ctx, value, recurseTimes, typedArray) {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
		return formatPrimitive(value, ctx);

	if (ctx.customInspect) {
		const custom = value[inspectCustom];
		if (typeof custom === 'function' && custom !== inspect) {
			const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
			const options = { ...ctx, depth, stylize: (text) => text };
			const result = custom.call(value, depth, options, inspect);
			if (result !== value) {
				if (typeof result !== 'string') return formatValue(ctx, result, recurseTimes);
				return result.replaceAll('\n', `\n${' '.repeat(ctx.indentationLvl)}`);
			}
		}
	}

	// a value being printed that contains itself: [Circular *n], and <ref *n> on it
	if (ctx.seen.includes(value)) {
		let index = ctx.circular.get(value);
		if (index === undefined) {
			index = ctx.circular.size + 1;
			ctx.circular.set(value, index);
		}
		return `[Circular *${index}]`;
	}

	return formatRaw(ctx, value, recurseTimes, typedArray);
}

function formatRaw(ctx, value, recurseTimes) {
	let keys = ownKeys(value, ctx.showHidden);
	const ctorName = constructorName(value);
	let tagName = value[Symbol.toStringTag];
	if (typeof tagName !== 'string') tagName = '';

	let base = '';
	let braces = ['{', '}'];
	let isArrayLike = false;
	let formatter = null;
	const primitiveBox = boxedPrimitive(value);

	if (Array.isArray(value)) {
		const size = ctorName === 'Array' ? '' : `(${value.length})`;
		const pre = ctorName === 'Array' ? '' : prefix(ctorName, tagName, 'Array', size);
		braces = [`${pre}[`, ']'];
		if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
		isArrayLike = true;
		formatter = () => formatArrayLike(ctx, value, recurseTimes, keys, value.length);
	} else if (typedArrayName(value) !== undefined && !(value instanceof DataView)) {
		const name = ctorName ?? typedArrayName(value);
		braces = [
			`${prefix(name, tagName === typedArrayName(value) ? '' : tagName, typedArrayName(value), `(${value.length})`)}[`,
			']'
		];
		if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
		isArrayLike = true;
		formatter = () => formatArrayLike(ctx, value, recurseTimes, keys, value.length);
	} else if (value instanceof Set) {
		const pre = prefix(ctorName, tagName === 'Set' ? '' : tagName, 'Set', `(${value.size})`);
		if (value.size === 0 && keys.length === 0) return `${pre}{}`;
		braces = [`${pre}{`, '}'];
		formatter = () => {
			ctx.indentationLvl += 2;
			const output = [];
			for (const entry of value) output.push(formatValue(ctx, entry, recurseTimes));
			ctx.indentationLvl -= 2;
			for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, false));
			return output;
		};
	} else if (value instanceof Map) {
		const pre = prefix(ctorName, tagName === 'Map' ? '' : tagName, 'Map', `(${value.size})`);
		if (value.size === 0 && keys.length === 0) return `${pre}{}`;
		braces = [`${pre}{`, '}'];
		formatter = () => {
			ctx.indentationLvl += 2;
			const output = [];
			for (const [k, v] of value)
				output.push(`${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`);
			ctx.indentationLvl -= 2;
			for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, false));
			return output;
		};
	} else if (typeof value === 'function') {
		base = functionBase(value);
		// a class's own enumerable statics, a function's properties
		keys = keys.filter((key) => key !== 'prototype' || ctx.showHidden);
		if (keys.length === 0) return base;
	} else if (value instanceof RegExp) {
		base = RegExp.prototype.toString.call(value);
		if (keys.length === 0) return base;
	} else if (value instanceof Date) {
		base = Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
		if (keys.length === 0) return base;
	} else if (value instanceof Error) {
		base = errorString(value);
		keys = keys.filter((key) => key !== 'stack' && key !== 'message');
		if (keys.length === 0) return base;
		if (ctx.indentationLvl !== 0)
			base = base.replaceAll('\n', `\n${' '.repeat(ctx.indentationLvl)}`);
	} else if (value instanceof ArrayBuffer) {
		const pre = prefix(ctorName, '', 'ArrayBuffer');
		braces = [`${pre}{`, '}'];
		formatter = () => {
			const output = [
				`[Uint8Contents]: <${hexBytes(value, ctx.maxArrayLength)}>`,
				`[byteLength]: ${value.byteLength}`
			];
			for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, false));
			return output;
		};
	} else if (value instanceof DataView) {
		braces = [`${prefix(ctorName, '', 'DataView')}{`, '}'];
		formatter = () => {
			ctx.indentationLvl += 2;
			const output = [
				`[byteLength]: ${value.byteLength}`,
				`[byteOffset]: ${value.byteOffset}`,
				`[buffer]: ${formatValue(ctx, value.buffer, recurseTimes)}`
			];
			ctx.indentationLvl -= 2;
			return output;
		};
	} else if (value instanceof Promise) {
		braces = [`${prefix(ctorName, tagName === 'Promise' ? '' : tagName, 'Promise')}{`, '}'];
		formatter = () => {
			const output = ['<pending>'];
			for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, false));
			return output;
		};
	} else if (value instanceof WeakMap || value instanceof WeakSet) {
		return `${prefix(ctorName, '', value instanceof WeakMap ? 'WeakMap' : 'WeakSet')}{ <items unknown> }`;
	} else if (primitiveBox !== null) {
		base = `[${primitiveBox[0]}${ctorName !== primitiveBox[0] && ctorName !== null ? ` (${ctorName})` : ''}: ${formatPrimitive(primitiveBox[1], ctx)}]`;
		if (primitiveBox[0] === 'String') keys = keys.filter((key) => !/^(0|[1-9][0-9]*)$/.test(key));
		if (keys.length === 0) return base;
	} else {
		if (ctorName === 'Object') {
			if (tag(value) === 'Arguments') braces[0] = '[Arguments] [';
			else if (tagName !== '') braces[0] = `${prefix(ctorName, tagName, 'Object')}{`;
		} else braces[0] = `${prefix(ctorName, tagName, 'Object')}{`;
		if (keys.length === 0) return `${braces[0]}}`;
	}

	if (recurseTimes > ctx.depth && ctx.depth !== null) {
		const name = ctorName ?? 'Object';
		return Array.isArray(value) ? '[Array]' : `[${name}]`;
	}

	recurseTimes++;
	ctx.seen.push(value);
	ctx.currentDepth = recurseTimes;
	const output = formatter !== null ? formatter() : [];
	if (formatter === null)
		for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, false));
	ctx.seen.pop();

	const index = ctx.circular.get(value);
	if (index !== undefined) {
		const reference = `<ref *${index}>`;
		if (base === '') braces[0] = `${reference} ${braces[0]}`;
		else base = `${reference} ${base}`;
	}
	return reduceToSingleString(ctx, output, base, braces, isArrayLike, recurseTimes, value);
}

// [ 'Number', 3 ] for new Number(3), and so on; null for anything else
const boxedPrimitive = (value) => {
	if (typeof value !== 'object') return null;
	if (value instanceof Number) return ['Number', Number.prototype.valueOf.call(value)];
	if (value instanceof String) return ['String', String.prototype.valueOf.call(value)];
	if (value instanceof Boolean) return ['Boolean', Boolean.prototype.valueOf.call(value)];
	if (value instanceof BigInt) return ['BigInt', BigInt.prototype.valueOf.call(value)];
	if (value instanceof Symbol) return ['Symbol', Symbol.prototype.valueOf.call(value)];
	return null;
};

/**
 * A value as Node prints it (console.log's form, without colors).
 * @param {unknown} value
 * @param {object | boolean} [options] Node's options (depth, compact, breakLength, ...), or
 *   the legacy (value, showHidden, depth) form
 * @returns {string}
 */
export function inspect(value, options, legacyDepth) {
	const ctx = {
		...defaultOptions,
		...inspect.defaultOptions,
		seen: [],
		circular: new Map(),
		indentationLvl: 0,
		currentDepth: 0
	};
	if (typeof options === 'boolean') {
		ctx.showHidden = options;
		if (legacyDepth !== undefined) ctx.depth = legacyDepth;
	} else if (options !== null && typeof options === 'object') {
		for (const key of Object.keys(options)) if (key in defaultOptions) ctx[key] = options[key];
	}
	if (ctx.depth === Infinity) ctx.depth = null;
	if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
	if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
	return formatValue(ctx, value, 0);
}

inspect.custom = inspectCustom;
inspect.defaultOptions = { ...defaultOptions };
// the styles and colors Node's inspect knows (styleText reads these)
inspect.colors = {
	reset: [0, 0],
	bold: [1, 22],
	dim: [2, 22],
	italic: [3, 23],
	underline: [4, 24],
	blink: [5, 25],
	inverse: [7, 27],
	hidden: [8, 28],
	strikethrough: [9, 29],
	doubleunderline: [21, 24],
	black: [30, 39],
	red: [31, 39],
	green: [32, 39],
	yellow: [33, 39],
	blue: [34, 39],
	magenta: [35, 39],
	cyan: [36, 39],
	white: [37, 39],
	bgBlack: [40, 49],
	bgRed: [41, 49],
	bgGreen: [42, 49],
	bgYellow: [43, 49],
	bgBlue: [44, 49],
	bgMagenta: [45, 49],
	bgCyan: [46, 49],
	bgWhite: [47, 49],
	framed: [51, 54],
	overlined: [53, 55],
	gray: [90, 39],
	redBright: [91, 39],
	greenBright: [92, 39],
	yellowBright: [93, 39],
	blueBright: [94, 39],
	magentaBright: [95, 39],
	cyanBright: [96, 39],
	whiteBright: [97, 39],
	bgGray: [100, 49],
	bgRedBright: [101, 49],
	bgGreenBright: [102, 49],
	bgYellowBright: [103, 49],
	bgBlueBright: [104, 49],
	bgMagentaBright: [105, 49],
	bgCyanBright: [106, 49],
	bgWhiteBright: [107, 49]
};
inspect.colors.grey = inspect.colors.gray;
inspect.styles = {
	special: 'cyan',
	number: 'yellow',
	bigint: 'yellow',
	boolean: 'yellow',
	undefined: 'grey',
	null: 'bold',
	string: 'green',
	symbol: 'green',
	date: 'magenta',
	regexp: 'red',
	module: 'underline'
};

// ---- format ----

// whether an object's toString is the one its built-in class gives (then %s inspects it)
const hasBuiltinToString = (value) => {
	const own = value.toString;
	if (typeof own !== 'function') return true;
	if (Object.prototype.hasOwnProperty.call(value, 'toString')) return false;
	let proto = value;
	while ((proto = Object.getPrototypeOf(proto)) !== null) {
		if (Object.prototype.hasOwnProperty.call(proto, 'toString')) {
			const ctor = proto.constructor;
			return (
				proto === Object.prototype ||
				proto === Array.prototype ||
				proto === Error.prototype ||
				proto === Date.prototype ||
				proto === RegExp.prototype ||
				proto === Function.prototype ||
				(typeof ctor === 'function' && isBuiltinConstructor(ctor))
			);
		}
	}
	return true;
};

const BUILTIN_CONSTRUCTORS = new Set([
	Object,
	Array,
	Error,
	TypeError,
	RangeError,
	SyntaxError,
	ReferenceError,
	Date,
	RegExp,
	Map,
	Set,
	Promise,
	Number,
	String,
	Boolean,
	Symbol,
	BigInt
]);
const isBuiltinConstructor = (ctor) => BUILTIN_CONSTRUCTORS.has(ctor);

// JSON.stringify, '[Circular]' for a value that contains itself (checked first: a cycle is
// not something to hand the engine's JSON)
const formatJson = (value) => {
	const seen = [];
	const cyclic = (v) => {
		if (v === null || typeof v !== 'object') return false;
		if (seen.includes(v)) return true;
		seen.push(v);
		for (const key of Object.keys(v)) if (cyclic(v[key])) return true;
		seen.pop();
		return false;
	};
	if (cyclic(value)) return '[Circular]';
	return JSON.stringify(value);
};

/** The arguments as one string, printf-style: %s %d %i %f %j %o %O %c %%, the rest inspected. */
export function format(...args) {
	return formatWithOptions(undefined, ...args);
}

/** format(), with inspect's options for the values it inspects. */
export function formatWithOptions(inspectOptions, ...args) {
	const first = args[0];
	let a = 0;
	let out = '';
	const inspectWith = (value, extra) => inspect(value, { ...inspectOptions, ...extra });

	if (typeof first === 'string') {
		if (args.length === 1) return first;
		a = 1;
		let lastPos = 0;
		for (let i = 0; i < first.length - 1; i++) {
			if (first.charCodeAt(i) !== 37) continue; // '%'
			const next = first[i + 1];
			if (a === args.length && next !== '%') continue;
			let text;
			switch (next) {
				case 's': {
					const arg = args[a++];
					if (typeof arg === 'number') text = formatNumber(arg);
					else if (typeof arg === 'bigint') text = `${arg}n`;
					else if (typeof arg !== 'object' || arg === null || !hasBuiltinToString(arg))
						text = String(arg);
					else text = inspectWith(arg, { depth: 0, colors: false, compact: 3 });
					break;
				}
				case 'j':
					text = formatJson(args[a++]);
					break;
				case 'd': {
					const arg = args[a++];
					if (typeof arg === 'bigint') text = `${arg}n`;
					else if (typeof arg === 'symbol') text = 'NaN';
					else text = formatNumber(Number(arg));
					break;
				}
				case 'O':
					text = inspectWith(args[a++]);
					break;
				case 'o':
					text = inspectWith(args[a++], { showHidden: true, showProxy: true, depth: 4 });
					break;
				case 'i': {
					const arg = args[a++];
					if (typeof arg === 'bigint') text = `${arg}n`;
					else if (typeof arg === 'symbol') text = 'NaN';
					else text = formatNumber(Number.parseInt(arg));
					break;
				}
				case 'f': {
					const arg = args[a++];
					text = typeof arg === 'symbol' ? 'NaN' : formatNumber(Number.parseFloat(arg));
					break;
				}
				case 'c':
					a++;
					text = '';
					break;
				case '%':
					out += first.slice(lastPos, i);
					lastPos = i + 1;
					i++;
					continue;
				default:
					continue;
			}
			if (lastPos !== i) out += first.slice(lastPos, i);
			out += text;
			lastPos = i + 2;
			i++;
		}
		if (lastPos !== 0) {
			if (lastPos < first.length) out += first.slice(lastPos);
		} else out = first;
	}

	while (a < args.length) {
		const value = args[a];
		out += (a > 0 ? ' ' : '') + (typeof value === 'string' ? value : inspectWith(value));
		a++;
	}
	return out;
}

// ---- functions ----

/**
 * A promise-returning form of a function that takes a Node-style callback last
 * ((error, value) => ...), or its util.promisify.custom when it has one.
 */
export function promisify(original) {
	if (typeof original !== 'function')
		throw invalidArgType('original', 'of type function', original);
	const custom = original[promisifyCustom];
	if (custom !== undefined) {
		if (typeof custom !== 'function')
			throw invalidArgType('util.promisify.custom', 'of type function', custom);
		return custom;
	}
	function promisified(...args) {
		return new Promise((resolve, reject) => {
			original.call(this, ...args, (error, ...values) => {
				if (error) reject(error);
				else resolve(values[0]);
			});
		});
	}
	Object.setPrototypeOf(promisified, Object.getPrototypeOf(original));
	Object.defineProperty(promisified, promisifyCustom, { value: promisified, configurable: true });
	return promisified;
}

promisify.custom = promisifyCustom;

/**
 * A callback-taking form of an async function: its promise's value (or reason) passed to the
 * last argument, (error, value), a turn later.
 */
export function callbackify(original) {
	if (typeof original !== 'function')
		throw invalidArgType('original', 'of type function', original);
	return function (...args) {
		const callback = args.pop();
		if (typeof callback !== 'function')
			throw invalidArgType('last argument', 'of type function', callback);
		original.apply(this, args).then(
			(value) => Promise.resolve().then(() => callback(null, value)),
			(reason) => {
				// a falsy reason as an Error, as Node does
				if (!reason) {
					const e = new Error('Promise was rejected with a falsy value');
					e.code = 'ERR_FALSY_VALUE_REJECTION';
					e.reason = reason;
					reason = e;
				}
				Promise.resolve().then(() => callback(reason));
			}
		);
	};
}

const warnedCodes = new Set();

/** fn, printing a DeprecationWarning (to stderr) the first time it is called. */
export function deprecate(fn, message, code) {
	if (typeof fn !== 'function') throw invalidArgType('fn', 'of type function', fn);
	let warned = false;
	return function (...args) {
		if (!warned && !(code !== undefined && warnedCodes.has(code))) {
			warned = true;
			if (code !== undefined) warnedCodes.add(code);
			console.error(
				`(node:${pid()}) ${code !== undefined ? `[${code}] ` : ''}DeprecationWarning: ${message}`
			);
		}
		return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
	};
}

/** ctor inherits superCtor's prototype (the pre-class way); ctor.super_ is superCtor. */
export function inherits(ctor, superCtor) {
	if (typeof ctor !== 'function') throw invalidArgType('ctor', 'of type function', ctor);
	if (typeof superCtor !== 'function')
		throw invalidArgType('superCtor', 'of type function', superCtor);
	if (superCtor.prototype === undefined)
		throw invalidArgType('superCtor.prototype', 'of type object', superCtor.prototype);
	Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true });
	Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

// ---- deep equality ----

/** Whether a and b are deeply equal, as assert.deepStrictEqual has it. */
export function isDeepStrictEqual(a, b) {
	return deepEqual(a, b, []);
}

const deepEqual = (a, b, memo) => {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
	if (tag(a) !== tag(b)) return false;
	for (const [x, y] of memo) if (x === a && y === b) return true;
	memo.push([a, b]);

	if (a instanceof Date) {
		if (!Object.is(a.getTime(), b.getTime())) return false;
	} else if (a instanceof RegExp) {
		if (a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false;
	} else if (a instanceof Error) {
		if (a.message !== b.message || a.name !== b.name) return false;
	} else if (boxedPrimitive(a) !== null) {
		if (!Object.is(boxedPrimitive(a)[1], boxedPrimitive(b)[1])) return false;
	} else if (ArrayBuffer.isView(a)) {
		if (a.byteLength !== b.byteLength) return false;
		const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
		const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
		if (typedArrayName(a) !== undefined && !a.constructor.name.startsWith('Float')) {
			for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
		} else if (typedArrayName(a) !== undefined) {
			for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
		} else for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	} else if (a instanceof ArrayBuffer) {
		if (a.byteLength !== b.byteLength) return false;
		const x = new Uint8Array(a);
		const y = new Uint8Array(b);
		for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	} else if (a instanceof Set) {
		if (a.size !== b.size) return false;
		outer: for (const x of a) {
			if (b.has(x)) continue;
			if (x === null || typeof x !== 'object') return false;
			for (const y of b) if (deepEqual(x, y, memo)) continue outer;
			return false;
		}
	} else if (a instanceof Map) {
		if (a.size !== b.size) return false;
		outer: for (const [k, v] of a) {
			if (b.has(k)) {
				if (!deepEqual(v, b.get(k), memo)) return false;
				continue;
			}
			if (k === null || typeof k !== 'object') return false;
			for (const [k2, v2] of b)
				if (deepEqual(k, k2, memo) && deepEqual(v, v2, memo)) continue outer;
			return false;
		}
	}
	if (Array.isArray(a) && a.length !== b.length) return false;

	const keysA = ownKeys(a, false);
	const keysB = ownKeys(b, false);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) {
		if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
		if (!deepEqual(a[key], b[key], memo)) return false;
	}
	return true;
};

// ---- debuglog ----

let debugSections = null;

const debugEnabled = (section) => {
	if (debugSections === null) {
		const setting = getenv('NODE_DEBUG') ?? '';
		debugSections = setting
			.split(/[\s,]+/)
			.filter((s) => s !== '')
			.map(
				(s) =>
					new RegExp('^' + s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*') + '$', 'i')
			);
	}
	return debugSections.some((pattern) => pattern.test(section));
};

/**
 * A logger for a section: it prints (to stderr, "SECTION: message") only when the NODE_DEBUG
 * environment variable names the section; otherwise it does nothing.
 */
export function debuglog(section, callback) {
	let enabled;
	const logger = (...args) => {
		enabled ??= debugEnabled(section);
		if (!enabled) return;
		console.error(`${section.toUpperCase()}: ${format(...args)}`);
	};
	Object.defineProperty(logger, 'enabled', {
		get: () => (enabled ??= debugEnabled(section)),
		configurable: true
	});
	if (typeof callback === 'function') callback(logger);
	return logger;
}

export { debuglog as debug };

// ---- styleText ----

// whether stdout takes colors: a terminal, unless NO_COLOR or NODE_DISABLE_COLORS; FORCE_COLOR
// forces them (as Node decides for styleText's default stream)
const colorsWanted = () => {
	const force = getenv('FORCE_COLOR');
	if (force !== undefined) return force !== '0' && force !== 'false';
	if (getenv('NO_COLOR') !== undefined || getenv('NODE_DISABLE_COLORS') !== undefined) return false;
	if (getenv('TERM') === 'dumb') return false;
	return isTTY(1);
};

/**
 * text in a style or styles of inspect.colors ('red', ['bold', 'underline']), as ANSI escapes;
 * plain text when stdout does not take colors (unless validateStream is false).
 */
export function styleText(format, text, options) {
	if (typeof text !== 'string') throw invalidArgType('text', 'of type string', text);
	const formats = Array.isArray(format) ? format : [format];
	let left = '';
	let right = '';
	for (const key of formats) {
		const codes = key === 'none' ? null : inspect.colors[key];
		if (codes === undefined) {
			const e = new TypeError(
				`The argument 'format' must be one of: ${Object.keys(inspect.colors)
					.map((k) => `'${k}'`)
					.join(', ')}. Received ${inspect(key)}`
			);
			e.code = 'ERR_INVALID_ARG_VALUE';
			throw e;
		}
		if (codes === null) continue;
		left += `\u001b[${codes[0]}m`;
		right = `\u001b[${codes[1]}m` + right;
	}
	if (options?.validateStream !== false && !colorsWanted()) return text;
	return left + text + right;
}

// ANSI escape sequences (Node's pattern), the introducers written as code points: what the
// pattern matches are control characters
const ANSI_PATTERN = new RegExp(
	`[${String.fromCharCode(0x1b, 0x9b)}][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?${String.fromCharCode(7)})|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))`,
	'g'
);

/** text without ANSI escape sequences. */
export const stripVTControlCharacters = (text) => text.replace(ANSI_PATTERN, '');

// ---- parseArgs ----

const parseArgsError = (code, message) => codeError(TypeError, code, message);

/**
 * Command-line arguments as { values, positionals } (Node's parseArgs, without tokens): options
 * { name: { type: 'string' | 'boolean', short, multiple, default } }; strict (the default)
 * refuses unknown options and positionals unless allowPositionals.
 */
export function parseArgs(config = {}) {
	const args = config.args ?? processArgs();
	const options = config.options ?? {};
	const strict = config.strict ?? true;
	const allowPositionals = config.allowPositionals ?? !strict;
	const allowNegative = config.allowNegative ?? false;
	const values = Object.create(null);
	const positionals = [];
	const shorts = new Map();
	for (const name of Object.keys(options)) {
		const option = options[name];
		if (option.type !== 'string' && option.type !== 'boolean')
			throw parseArgsError(
				'ERR_INVALID_ARG_VALUE',
				`The property 'options.${name}.type' must be one of: 'string', 'boolean'. Received ${inspect(option.type)}`
			);
		if (option.short !== undefined) shorts.set(option.short, name);
	}

	const store = (name, value, raw) => {
		const option = options[name];
		if (option === undefined) {
			if (strict)
				throw parseArgsError(
					'ERR_PARSE_ARGS_UNKNOWN_OPTION',
					`Unknown option '${raw}'${allowPositionals ? '' : `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${inspect(raw)}`}`
				);
			values[name] = value ?? true;
			return;
		}
		if (strict) {
			if (option.type === 'string' && typeof value !== 'string')
				throw parseArgsError(
					'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
					`Option '${option.short ? `-${option.short}, ` : ''}--${name} <value>' argument missing`
				);
			if (option.type === 'boolean' && typeof value === 'string')
				throw parseArgsError(
					'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
					`Option '${option.short ? `-${option.short}, ` : ''}--${name}' does not take an argument`
				);
		}
		const stored = value ?? true;
		if (option.multiple) (values[name] ??= []).push(stored);
		else values[name] = stored;
	};

	for (let i = 0; i < args.length; i++) {
		const current = args[i];
		if (current === '--') {
			for (const rest of args.slice(i + 1)) {
				if (strict && !allowPositionals)
					throw parseArgsError(
						'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
						`Unexpected argument '${rest}'. This command does not take positional arguments`
					);
				positionals.push(rest);
			}
			break;
		}
		if (current.startsWith('--') && current.length > 2) {
			const eq = current.indexOf('=');
			let name = eq === -1 ? current.slice(2) : current.slice(2, eq);
			let value = eq === -1 ? undefined : current.slice(eq + 1);
			if (allowNegative && name.startsWith('no-') && options[name.slice(3)]?.type === 'boolean') {
				values[name.slice(3)] = false;
				continue;
			}
			if (value === undefined && options[name]?.type === 'string' && i + 1 < args.length)
				value = args[++i];
			store(name, value, `--${name}`);
		} else if (current.startsWith('-') && current.length > 1 && current !== '-') {
			// -abc: boolean shorts together; a string short takes the rest, or the next argument
			for (let j = 1; j < current.length; j++) {
				const letter = current[j];
				const name = shorts.get(letter) ?? letter;
				if (options[name]?.type === 'string') {
					let value = current.slice(j + 1);
					if (value === '') value = i + 1 < args.length ? args[++i] : undefined;
					store(name, value, `-${letter}`);
					break;
				}
				store(name, undefined, `-${letter}`);
			}
		} else {
			if (strict && !allowPositionals)
				throw parseArgsError(
					'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
					`Unexpected argument '${current}'. This command does not take positional arguments`
				);
			positionals.push(current);
		}
	}

	for (const name of Object.keys(options)) {
		if (options[name].default !== undefined && values[name] === undefined)
			values[name] = options[name].default;
	}
	return { values, positionals };
}

// the program's arguments after its path (process.argv.slice(2)'s, for a compiled binary
// argv[1] is itself: the arguments start at argv[1] of the host's)
const processArgs = () => {
	const out = [];
	for (let i = 1; i < argCount(); i++) out.push(arg(i));
	return out;
};

// ---- the rest ----

/** An AbortSignal's abort as a promise (Node's util.aborted; resource is not tracked). */
export const aborted = (signal) =>
	new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener('abort', () => resolve(), { once: true });
	});

export const toUSVString = (string) => String(string).toWellFormed();

const isArray = (value) => Array.isArray(value);

const TextEncoderValue = TextEncoder;
const TextDecoderValue = TextDecoder;
export { TextEncoderValue as TextEncoder, TextDecoderValue as TextDecoder, isArray };

export default {
	inspect,
	format,
	formatWithOptions,
	promisify,
	callbackify,
	deprecate,
	inherits,
	isDeepStrictEqual,
	types,
	debuglog,
	debug: debuglog,
	styleText,
	stripVTControlCharacters,
	parseArgs,
	aborted,
	toUSVString,
	isArray,
	TextEncoder: TextEncoderValue,
	TextDecoder: TextDecoderValue
};
