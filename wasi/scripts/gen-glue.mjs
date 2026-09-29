// Generate the component glue for a Porffor-compiled guest from its WIT world.
//
//   node gen-glue.mjs <wit-dir> <world> <out-dir>   (build-component.mjs runs it)
//
// wit-bindgen's C generator does the canonical ABI (bindings/<world>.{c,h}). This adds
// the layer between those typed C structs and Porffor's JS values, generated from the
// same WIT so the two sides cannot drift:
//
//   js/rt.mjs         the queue's JS side, four functions that call straight into C
//                     (Porffor.c): rtQ (reset the queue), rtP (push), rtR (pop),
//                     rtImp (call import #id)
//   js/imp-N.mjs      one module per imported interface, with jco's JS shapes
//                     (camelCase functions, PascalCase resource classes, {tag, val}
//                     variants, undefined for none); what the guest bundle imports
//   js/entry.mjs      the guest bundle plus rtExp(id), the export router, which C
//                     calls as rt_call_exp(id)
//   glue.c            rt_import(id) and the wit-bindgen export functions
//   aliases.json      esbuild aliases: WIT import specifiers -> js/imp-N.mjs
//   features.json     what the glue supports: { async } (the async runtime is in glue.c),
//                     { httpHandler }, { timezone } (glue.c answers Porffor's time zone hooks)
//
// JS and C never share object layouts. A value crosses as a flat sequence of
// primitives (numbers, booleans, strings) through one queue: the sender flattens it in
// WIT order, the receiver rebuilds it in the same order. A list is its length then its
// elements; an option, result or variant is its discriminant then its payload.
//
// Shapes nothing has exercised yet fail at generation time instead of guessing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [witDir, worldName, outDir] = process.argv.slice(2);

if (!outDir) {
	console.error('usage: node gen-glue.mjs <wit-dir> <world> <out-dir>');
	process.exit(2);
}
fs.mkdirSync(path.join(outDir, 'bindings'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });

// the unstable WIT features the glue knows: wasi:clocks/timezone, the host's time zone
const WIT_FEATURES = 'clocks-timezone';

execFileSync(
	process.env.WIT_BINDGEN ?? 'wit-bindgen',
	[
		'c',
		witDir,
		'--world',
		worldName,
		'--features',
		WIT_FEATURES,
		'--out-dir',
		path.join(outDir, 'bindings')
	],
	{
		stdio: ['ignore', 'ignore', 'inherit']
	}
);
const wit = JSON.parse(
	execFileSync(
		process.env.WASM_TOOLS ?? 'wasm-tools',
		['component', 'wit', witDir, '--features', WIT_FEATURES, '--json'],
		{ maxBuffer: 1 << 28 }
	)
);

// Async exports are lifted with a callback (wit-bindgen's own wrappers) when every
// coroutine in the program is stackless, else stackful: the export's own thread waits
// (waitable-set.wait) while its promises are pending, so a stackful coroutine (a P3
// thread) switches on one live thread throughout. With the callback ABI each callback
// runs on the task's implicit thread after it has returned WAIT, and a coroutine that
// hands control back to it fails in wasmtime. Which one is a C switch, RT_STACKFUL:
// wasi-porffor-build sets it from the program's PORF_STACKFUL (known only once Porffor
// has run), for this file and glue.c alike.
{
	const cFile = path.join(outDir, 'bindings', `${worldName.replaceAll('-', '_')}.c`);
	let kase = fs.readFileSync(cFile, 'utf8');
	kase = kase.replace(
		/__attribute__\(\(__export_name__\("\[async-lift\]([^"]+)"\)\)\)\nint32_t (\w+)\(([^)]*)\) \{([\s\S]*?)\n {2}return ret;\n\}/g,
		(callback, name, fn, params, body) =>
			`#if RT_STACKFUL\n__attribute__((__export_name__("[async-lift-stackful]${name}")))\nvoid ${fn}(${params}) {${body}\n  (void)ret;\n}\n#else\n${callback}\n#endif`
	);
	kase = kase.replace(
		/(__attribute__\(\(__export_name__\("\[callback\]\[async-lift\][^"]+"\)\)\)\n)/g,
		'#if !RT_STACKFUL\n$1#endif\n'
	);
	kase = `#ifndef RT_STACKFUL\n#error "RT_STACKFUL: how async exports are lifted (set by wasi-porffor-build)"\n#endif\n${kase}`;
	fs.writeFileSync(cFile, kase);
}
fs.writeFileSync(path.join(outDir, 'wit.json'), JSON.stringify(wit, null, 1));

const worlds = wit.worlds.filter((writer) => writer.name === worldName);
const world = worlds[worlds.length - 1];

if (!world) throw new Error(`no world ${worldName}`);

// ---- names ----

const snake = (text) => text.replaceAll('-', '_');
const camel = (text) => text.replace(/-([a-z0-9])/g, (___, kase) => kase.toUpperCase());
const pascal = (text) => camel(text).replace(/^./, (kase) => kase.toUpperCase());
const JS_RESERVED = new Set(
	(
		'break case catch class const continue debugger default delete do else enum export extends false finally for ' +
		'function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
		'yield let static implements interface package private protected public await arguments eval'
	).split(' ')
);
/** A WIT parameter name as a JS identifier (`this` -> `this_`). */
const jsParam = (text) => (JS_RESERVED.has(camel(text)) ? camel(text) + '_' : camel(text));
const C_KEYWORDS = new Set(
	(
		'auto break case char const continue default do double else enum extern float for goto if ' +
		'inline int long register restrict return short signed sizeof static struct switch typedef union ' +
		'unsigned void volatile while bool true false _Bool ' +
		// wit-bindgen escapes C++ keywords too (its header is C++-includable)
		'alignas alignof and and_eq asm bitand bitor catch char16_t char32_t class compl constexpr const_cast ' +
		'decltype delete dynamic_cast explicit export friend mutable namespace new noexcept not not_eq nullptr ' +
		'operator or or_eq private protected public reinterpret_cast static_assert static_cast template this ' +
		'thread_local throw try typeid typename using virtual wchar_t xor xor_eq'
	).split(' ')
);
// wit-bindgen lowercases C member names (DNS-error -> dns_error)
const cField = (text) => {
	const count = snake(text).toLowerCase();
	return C_KEYWORDS.has(count) ? count + '_' : count;
};

const witPackage = (iface) => {
	const [ns, rest] = wit.packages[iface.package].name.split(':');
	const [name, version] = rest.split('@');
	return { ns, name, version };
};
const cPrefix = (iface, exported) => {
	const decl = witPackage(iface);
	return `${exported ? 'exports_' : ''}${snake(decl.ns)}_${snake(decl.name)}_${snake(iface.name)}`;
};
const specifier = (iface) => {
	const decl = witPackage(iface);
	return `${decl.ns}:${decl.name}/${iface.name}${decl.version ? '@' + decl.version : ''}`;
};

// ---- the wit-bindgen header's prototypes ----

const header = fs.readFileSync(path.join(outDir, 'bindings', `${snake(worldName)}.h`), 'utf8');
const protos = new Map();
{
	const flat = header.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ');

	for (const match of flat.matchAll(
		/(?:extern )?([A-Za-z_][\w ]*?\**) ?\b([A-Za-z_]\w*)\(([^()]*)\);/g
	)) {
		const list = match[3].trim();
		const params =
			list === '' || list === 'void'
				? []
				: list.split(',').map((decl) => {
						const pm = /^(.*?)(\w+)$/.exec(decl.trim());
						return { type: pm[1].trim(), name: pm[2] };
					});
		protos.set(match[2], { ret: match[1].trim(), params });
	}
}
const proto = (name) => {
	const decl = protos.get(name);

	if (!decl) throw new Error(`wit-bindgen header has no ${name}`);
	return decl;
};
const valueType = (typeRef) => typeRef.replace(/\*$/, '').trim(); // `cloud_string_t *` -> `cloud_string_t`
const freeFn = (ctype) => {
	const name = ctype.replace(/_t$/, '_free');
	return protos.has(name) ? name : null;
};

// ---- WIT types ----

const unalias = (typeRef) => {
	while (typeof typeRef === 'number' && wit.types[typeRef].kind.type !== undefined)
		typeRef = wit.types[typeRef].kind.type;
	return typeRef;
};
const typeKind = (typeRef) => {
	const spec = wit.types[typeRef].kind;
	return typeof spec === 'string' ? [spec, null] : Object.entries(spec)[0];
};
const importedIfaces = new Set();
const exportedIfaces = new Set();

for (const item of Object.values(world.imports))
	if (item.interface) importedIfaces.add(item.interface.id);

for (const item of Object.values(world.exports))
	if (item.interface) exportedIfaces.add(item.interface.id);

for (const [key, item] of Object.entries(world.imports))
	if (!item.interface && !item.type) throw new Error(`world-level import ${key}: unsupported`);

/** A resource type id through any aliases (`type trailers = fields`). */
const unres = (id) => {
	while (wit.types[id].kind.type !== undefined) id = wit.types[id].kind.type;
	return id;
};
/** 'imported' | 'exported' for a resource type id. */
const resourceSide = (id) => {
	id = unres(id);
	const owner = wit.types[id].owner?.interface;

	if (importedIfaces.has(owner)) return 'imported';

	if (exportedIfaces.has(owner)) return 'exported';
	throw new Error(
		`resource ${wit.types[id].name}: owner interface is neither imported nor exported`
	);
};
const resourceClass = (id) => pascal(wit.types[unres(id)].name);
// Resources the module being generated lifts: their wrap functions are imported from
// the module of the interface that defines them.
const jsNeeds = new Set();
const needImports = (self) =>
	[...jsNeeds]
		.filter((result) => wit.types[result].owner.interface !== self)
		.map(
			(result) =>
				`import { wrap${resourceClass(result)} } from './imp-${wit.types[result].owner.interface}.mjs';`
		)
		.join('\n');
const unsupported = (what) => {
	throw new Error(`unsupported (not exercised yet): ${what}`);
};

// ---- JS: lower (guest value -> queue) and lift (queue -> guest value) ----

const jsFns = new Map();
const jsFn = (name, make) => {
	if (!jsFns.has(name)) {
		jsFns.set(name, null);
		jsFns.set(name, make());
	}
	return name;
};
const WIDE = new Set(['u64', 's64']);

function jsLower(typeRef, expr) {
	typeRef = unalias(typeRef);

	if (typeof typeRef === 'string') return WIDE.has(typeRef) ? `P(Number(${expr}));` : `P(${expr});`;
	return `${jsFn('L' + typeRef, () => `function L${typeRef}(v) {\n${jsLowerBody(typeRef)}\n}`)}(${expr});`;
}

function jsLowerBody(typeRef) {
	const [kind, spec] = typeKind(typeRef);

	switch (kind) {
		case 'record':
			return spec.fields.map((field) => jsLower(field.type, `v.${camel(field.name)}`)).join('\n');
		case 'tuple':
			return spec.types.map((ty, index) => jsLower(ty, `v[${index}]`)).join('\n');
		case 'list':
			return `const n = v.length;\nP(n);\nfor (let i = 0; i < n; i++) { ${jsLower(spec, 'v[i]')} }`;
		case 'option':
			return `if (v === undefined || v === null) P(0);\nelse { P(1); ${jsLower(spec, 'v')} }`;
		case 'result':
			return (
				`if (v.tag === 'ok') { P(0); ${spec.ok != null ? jsLower(spec.ok, 'v.val') : ''} }\n` +
				`else if (v.tag === 'err') { P(1); ${spec.err != null ? jsLower(spec.err, 'v.val') : ''} }\n` +
				`else throw new TypeError('invalid result tag ' + v.tag);`
			);
		case 'variant':
			return (
				`switch (v.tag) {\n` +
				spec.cases
					.map(
						(kase, index) =>
							`case '${kase.name}': P(${index}); ${kase.type != null ? jsLower(kase.type, 'v.val') : ''} break;`
					)
					.join('\n') +
				`\ndefault: throw new TypeError('invalid ${wit.types[typeRef].name} tag ' + v.tag);\n}`
			);
		case 'enum':
			return (
				`switch (v) {\n` +
				spec.cases.map((kase, index) => `case '${kase.name}': P(${index}); break;`).join('\n') +
				`\ndefault: throw new TypeError('invalid ${wit.types[typeRef].name} value ' + v);\n}`
			);
		case 'stream':
		case 'future':
			return `P(v);`; // a handle
		case 'flags':
			if (spec.flags.length > 32) unsupported('flags wider than 32');
			return `P(${spec.flags.map((field, index) => `(v.${camel(field.name)} ? ${2 ** index} : 0)`).join(' + ') || '0'});`;
		case 'handle': {
			const [how, res] = Object.entries(spec)[0];

			if (resourceSide(res) === 'imported') return `P(v.__h);`;

			// An exported resource handed out owned (a static constructor's result):
			// register the instance, its index is the rep.
			if (how === 'own') return `reps.push(v);\nP(reps.length - 1);`;

			return unsupported('lowering a borrow of an exported resource');
		}
		default:
			unsupported(`lowering ${kind}`);
	}
}

function jsLift(typeRef) {
	typeRef = unalias(typeRef);

	if (typeof typeRef === 'string') return WIDE.has(typeRef) ? 'BigInt(R())' : 'R()';
	return `${jsFn('U' + typeRef, () => `function U${typeRef}() {\n${jsLiftBody(typeRef)}\n}`)}()`;
}

function jsLiftBody(typeRef) {
	const [kind, spec] = typeKind(typeRef);

	switch (kind) {
		case 'record':
			// Object literal properties evaluate in order: field order is queue order.
			return `return { ${spec.fields.map((field) => `${camel(field.name)}: ${jsLift(field.type)}`).join(', ')} };`;
		case 'tuple':
			return `return [${spec.types.map((ty) => jsLift(ty)).join(', ')}];`;
		case 'list':
			// list<u8> is a Uint8Array, as jco gives it
			if (unalias(spec) === 'u8')
				return `const n = R();\nconst a = new Uint8Array(n);\nfor (let i = 0; i < n; i++) a[i] = R();\nreturn a;`;
			return `const n = R();\nconst a = [];\nfor (let i = 0; i < n; i++) a.push(${jsLift(spec)});\nreturn a;`;
		case 'option':
			return `return R() ? ${jsLift(spec)} : undefined;`;
		case 'result':
			return (
				`if (R()) return { tag: 'err', val: ${spec.err != null ? jsLift(spec.err) : 'undefined'} };\n` +
				`return { tag: 'ok', val: ${spec.ok != null ? jsLift(spec.ok) : 'undefined'} };`
			);
		case 'variant':
			return (
				`switch (R()) {\n` +
				spec.cases
					.map(
						(kase, index) =>
							`case ${index}: return { tag: '${kase.name}'${kase.type != null ? `, val: ${jsLift(kase.type)}` : ''} };`
					)
					.join('\n') +
				`\n}\nthrow new TypeError('invalid ${wit.types[typeRef].name} discriminant');`
			);
		case 'enum':
			return `return [${spec.cases.map((kase) => `'${kase.name}'`).join(', ')}][R()];`;
		case 'stream':
		case 'future':
			return `return R();`; // a handle
		case 'flags':
			return `const b = R();\nreturn { ${spec.flags.map((field, index) => `${camel(field.name)}: (b & ${2 ** index}) !== 0`).join(', ')} };`;
		case 'handle': {
			const [how, res] = Object.entries(spec)[0];

			if (resourceSide(res) === 'imported') {
				jsNeeds.add(unres(res));
				return `return wrap${resourceClass(res)}(R());`;
			}

			if (how === 'borrow') return `return reps[R()];`;
			unsupported('an owned exported resource crossing into the guest');
		}
		// falls through
		default:
			unsupported(`lifting ${kind}`);
	}
}

// ---- C: lower (queue -> struct) and lift (struct -> queue) ----

let tmp = 0;
const CNUM = {
	u8: 'uint8_t',
	u16: 'uint16_t',
	u32: 'uint32_t',
	u64: 'uint64_t',
	s8: 'int8_t',
	s16: 'int16_t',
	s32: 'int32_t',
	s64: 'int64_t',
	f32: 'float',
	f64: 'double'
};

function cLower(typeRef, lv) {
	typeRef = unalias(typeRef);

	if (typeof typeRef === 'string') {
		if (typeRef === 'bool') return `${lv} = rt_pop_bool();`;

		if (typeRef === 'char') return `${lv} = rt_pop_char();`;

		if (typeRef === 'string') return `rt_pop_string(&(${lv}).ptr, &(${lv}).len);`;

		if (typeRef === 'u64' || typeRef === 's64' || typeRef === 'u32')
			return `${lv} = (${CNUM[typeRef]})(int64_t)rt_pop_num();`;

		if (CNUM[typeRef]) return `${lv} = (${CNUM[typeRef]})rt_pop_num();`;
		unsupported(`C lowering ${typeRef}`);
	}
	const [kind, spec] = typeKind(typeRef);

	switch (kind) {
		case 'record':
			return spec.fields
				.map((field) => cLower(field.type, `(${lv}).${cField(field.name)}`))
				.join('\n');
		case 'tuple':
			return spec.types.map((ty, index) => cLower(ty, `(${lv}).f${index}`)).join('\n');
		case 'list': {
			const count = `n${tmp}`,
				index = `i${tmp++}`;
			return (
				`{ const size_t ${count} = (size_t)rt_pop_num();\n(${lv}).len = ${count};\n` +
				`(${lv}).ptr = ${count} ? malloc(${count} * sizeof *(${lv}).ptr) : NULL;\n` +
				`for (size_t ${index} = 0; ${index} < ${count}; ${index}++) { ${cLower(spec, `(${lv}).ptr[${index}]`)} } }`
			);
		}
		case 'option':
			return `if (((${lv}).is_some = rt_pop_bool())) { ${cLower(spec, `(${lv}).val`)} }`;
		case 'result':
			return (
				`if (((${lv}).is_err = rt_pop_bool())) { ${spec.err != null ? cLower(spec.err, `(${lv}).val.err`) : ''} }\n` +
				`else { ${spec.ok != null ? cLower(spec.ok, `(${lv}).val.ok`) : ''} }`
			);
		case 'variant':
			return (
				`(${lv}).tag = (uint32_t)rt_pop_num();\nswitch ((${lv}).tag) {\n` +
				spec.cases
					.map((kase, index) =>
						kase.type != null
							? `case ${index}: ${cLower(kase.type, `(${lv}).val.${cField(kase.name)}`)} break;`
							: ''
					)
					.join('\n') +
				`\n}`
			);
		case 'enum':
		case 'flags':
		case 'stream':
		case 'future':
			return `${lv} = (uint32_t)rt_pop_num();`;
		case 'handle': {
			const [how, res] = Object.entries(spec)[0];

			if (resourceSide(res) === 'imported') return `(${lv}).__handle = (int32_t)rt_pop_num();`;

			if (how !== 'own') unsupported('C lowering a borrow of an exported resource');
			const result = `${cPrefix(wit.interfaces[wit.types[unres(res)].owner.interface], true)}_${snake(wit.types[unres(res)].name)}`;
			const value = `rep${tmp++}`;
			return `{ ${result}_t *${value} = malloc(sizeof *${value}); ${value}->rep = rt_pop_num(); ${lv} = ${result}_new(${value}); }`;
		}
		default:
			unsupported(`C lowering ${kind}`);
	}
}

function cLift(typeRef, rv) {
	typeRef = unalias(typeRef);

	if (typeof typeRef === 'string') {
		if (typeRef === 'bool') return `rt_push_bool(${rv});`;

		if (typeRef === 'char') return `rt_push_char(${rv});`;

		if (typeRef === 'string') return `rt_push_string((${rv}).ptr, (${rv}).len);`;

		if (CNUM[typeRef]) return `rt_push_num((f64)(${rv}));`;
		unsupported(`C lifting ${typeRef}`);
	}
	const [kind, spec] = typeKind(typeRef);

	switch (kind) {
		case 'record':
			return spec.fields
				.map((field) => cLift(field.type, `(${rv}).${cField(field.name)}`))
				.join('\n');
		case 'tuple':
			return spec.types.map((ty, index) => cLift(ty, `(${rv}).f${index}`)).join('\n');
		case 'list': {
			const index = `i${tmp++}`;
			return (
				`rt_push_num((f64)(${rv}).len);\n` +
				`for (size_t ${index} = 0; ${index} < (${rv}).len; ${index}++) { ${cLift(spec, `(${rv}).ptr[${index}]`)} }`
			);
		}
		case 'option':
			return `rt_push_bool((${rv}).is_some);\nif ((${rv}).is_some) { ${cLift(spec, `(${rv}).val`)} }`;
		case 'result':
			return (
				`rt_push_bool((${rv}).is_err);\n` +
				`if ((${rv}).is_err) { ${spec.err != null ? cLift(spec.err, `(${rv}).val.err`) : ''} }\n` +
				`else { ${spec.ok != null ? cLift(spec.ok, `(${rv}).val.ok`) : ''} }`
			);
		case 'variant':
			return (
				`rt_push_num((f64)(${rv}).tag);\nswitch ((${rv}).tag) {\n` +
				spec.cases
					.map((kase, index) =>
						kase.type != null
							? `case ${index}: ${cLift(kase.type, `(${rv}).val.${cField(kase.name)}`)} break;`
							: ''
					)
					.join('\n') +
				`\n}`
			);
		case 'enum':
		case 'flags':
		case 'stream':
		case 'future':
			return `rt_push_num((f64)(${rv}));`;
		case 'handle': {
			const [how, res] = Object.entries(spec)[0];

			if (resourceSide(res) === 'imported') return `rt_push_num((f64)(${rv}).__handle);`;

			if (how === 'borrow') return `rt_push_num((${rv})->rep);`;
			unsupported('C lifting an owned exported resource');
		}
		// falls through
		default:
			unsupported(`C lifting ${kind}`);
	}
}

/**
 * The JS return of an import. A top-level result follows jco: ok returns its value,
 * err throws an Error whose `payload` is the error value (what yel-solid's
 * witErrorCase reads).
 */
/** The statements that rebuild an import's result: a lift function's body. */
function jsReturn(result) {
	if (result == null) return '';
	const unit = unalias(result);

	if (typeof unit === 'number' && typeKind(unit)[0] === 'result') {
		const spec = typeKind(unit)[1];
		return (
			`if (R()) throw componentError(${spec.err != null ? jsLift(spec.err) : 'undefined'});\n` +
			`return ${spec.ok != null ? jsLift(spec.ok) : 'undefined'};`
		);
	}
	return `return ${jsLift(result)};`;
}

// ---- function naming ----

/** { kind, resource, name } from a WIT function. */
const fnShape = (fn) => {
	const raw = typeof fn.kind === 'string' ? fn.kind : Object.keys(fn.kind)[0];
	const res = typeof fn.kind === 'string' ? null : Object.values(fn.kind)[0];
	const name = fn.name.replace(/^\[[a-z-]+\][^.]*\.?/, '');
	return { kind: raw.replace(/^async-/, ''), res, name, async: raw.startsWith('async-') };
};
const cFnName = (prefix, fn) => {
	const { kind, res, name } = fnShape(fn);

	if (kind === 'freestanding') return `${prefix}_${snake(fn.name)}`;
	const result = snake(wit.types[res].name);

	if (kind === 'constructor') return `${prefix}_constructor_${result}`;

	if (kind === 'method') return `${prefix}_method_${result}_${snake(name)}`;

	if (kind === 'static') return `${prefix}_static_${result}_${snake(name)}`;
	unsupported(`function kind ${kind}`);
};

// ---- async ----
// An async import's call record keeps its arguments and result alive until the
// subtask returns (the callee may read the arguments after the call has returned
// STARTING); rt_async_complete lifts the result and frees it.

const cAsyncStructs = [];
const cAsyncComplete = [];
const cAsyncStart = []; // rt_async_start: issues a queued operation on the export's thread
const cAsyncCancel = []; // rt_async_cancel: ends a started operation with the host
const cAsyncAbandon = []; // rt_async_abandon: frees one that will never complete
let hasAsync = false;

/** C and JS for an async import: start the subtask, then a promise (js/async.mjs). */
function asyncImport(fn, id, cName, decl, witParams, result, lowerSelf) {
	hasAsync = true;
	const fields = [],
		lowers = [],
		args = [],
		frees = [];
	witParams.forEach((wp, index) => {
		const hp = decl.params[index];
		const ct = valueType(hp.type);
		const free = freeFn(ct);
		fields.push(`${ct} a${index};`);

		if (hp.name.startsWith('maybe_')) {
			const inner = typeKind(unalias(wp.type))[1];
			fields.push(`bool has${index};`);
			lowers.push(`if ((c->has${index} = rt_pop_bool())) { ${cLower(inner, `c->a${index}`)} }`);
			args.push(`c->has${index} ? &c->a${index} : NULL`);

			if (free) frees.push(`if (c->has${index}) ${free}(&c->a${index});`);
			return;
		}
		lowers.push(cLower(wp.type, `c->a${index}`));
		args.push(hp.type.endsWith('*') ? `&c->a${index}` : `c->a${index}`);

		if (free) frees.push(`${free}(&c->a${index});`);
	});
	const out = decl.params.slice(witParams.length);

	if (result != null) {
		if (out.length !== 1) throw new Error(`${cName}: expected one result pointer`);
		fields.push(`${valueType(out[0].type)} r;`);
		args.push('&c->r');
	} else if (out.length) throw new Error(`${cName}: unexpected out-params`);
	const rfree = result != null ? freeFn(valueType(out[0].type)) : null;
	cAsyncStructs.push(`struct rt_call_${id} { ${fields.join(' ') || 'char unused;'} };`);
	const cCase =
		`case ${id}: { // ${fn.name} (async): queued, started on the export's thread\n` +
		`struct rt_call_${id} *c = calloc(1, sizeof *c);\n${lowers.join('\n')}\n` +
		`rt_reset();\nrt_push_bool(0);\nrt_push_num((f64)rt_defer(${id}, c, 0));\nbreak; }`;
	cAsyncStart.push(
		`case ${id}: { struct rt_call_${id} *c = data;\nconst uint32_t st = ${cName}(${args.join(', ')});\n` +
			`if ((st & 0xf) == RT_WU(SUBTASK_RETURNED)) { rt_reset(); rt_async_complete(${id}, c, 0); rt_settle(token); }\n` +
			`else rt_pending_add(st >> 4, RT_OP_SUBTASK, ${id}, c, 0, token);\nbreak; }`
	);
	cAsyncComplete.push(
		`case ${id}: { struct rt_call_${id} *c = data;\n` +
			`${result != null ? cLift(result, 'c->r') : ''}\n${frees.join('\n')}\n` +
			`${rfree ? `${rfree}(&c->r);` : ''}\nfree(c);\nbreak; }`
	);
	cAsyncCancel.push(`case ${id}: return RT_W(subtask_cancel)(waitable);`);
	// cancelled before it returned: the result was never written
	cAsyncAbandon.push(
		`case ${id}: { struct rt_call_${id} *c = data;\n${frees.join('\n')}\nfree(c);\nbreak; }`
	);
	const lift = `() => {\n${jsReturn(result) || 'return undefined;'}\n}`;
	const js =
		`Q();\n${lowerSelf}\nrtImp(${id});\n` +
		`if (R()) return rtNow(${lift});\nreturn rtAwait(R(), ${lift});`;
	return { cCase, js };
}

// ---- imports ----

let importId = 0;
const cImportCases = [];
const aliases = {};
const importedResources = new Set();

for (const ifaceId of importedIfaces) {
	const iface = wit.interfaces[ifaceId];
	const prefix = cPrefix(iface, false);
	const js = [];
	const classes = new Map(); // resource id -> { ctor, methods, statics }

	for (const fn of Object.values(iface.functions)) {
		const id = importId++;
		const { kind, res, name } = fnShape(fn);
		const cName = cFnName(prefix, fn);
		const decl = proto(cName);
		const witParams = fn.params;
		const result = fn.result ?? null;
		const jsParamsA = witParams
			.filter((wp) => !(kind === 'method' && wp.name === 'self'))
			.map((wp) => jsParam(wp.name));
		const lowersA = witParams
			.map((wp) =>
				kind === 'method' && wp.name === 'self'
					? 'P(this.__h);'
					: jsLower(wp.type, jsParam(wp.name))
			)
			.join('\n');

		if (fnShape(fn).async) {
			const left = asyncImport(fn, id, cName, decl, witParams, result, lowersA);
			cImportCases.push(left.cCase);
			const member = `${camel(kind === 'freestanding' ? fn.name : name)}(${jsParamsA.join(', ')}) {\n${left.js}\n}`;

			if (kind === 'freestanding') js.push(`export function ${member}`);
			else {
				importedResources.add(res);
				classes.set(res, classes.get(res) ?? { members: [] });
				classes.get(res).members.push(`${kind === 'static' ? 'static ' : ''}${member}`);
			}
			continue;
		}
		const resultKind =
			result != null && typeof unalias(result) === 'number' ? typeKind(unalias(result))[0] : null;

		// C: pop the arguments, call, reset the queue, push the result.
		const locals = [],
			args = [],
			frees = [];
		witParams.forEach((wp, index) => {
			const hp = decl.params[index];

			if (!hp) throw new Error(`${cName}: header has fewer params than WIT`);
			const ct = valueType(hp.type);
			const free = freeFn(ct);

			if (hp.name.startsWith('maybe_')) {
				// wit-bindgen C passes an option parameter as a nullable pointer to its payload
				const inner = typeKind(unalias(wp.type))[1];
				locals.push(
					`${ct} a${index};\nconst bool has${index} = rt_pop_bool();\nif (has${index}) { ${cLower(inner, `a${index}`)} }`
				);
				args.push(`has${index} ? &a${index} : NULL`);

				if (free) frees.push(`if (has${index}) ${free}(&a${index});`);
				return;
			}
			locals.push(`${ct} a${index};\n${cLower(wp.type, `a${index}`)}`);
			args.push(hp.type.endsWith('*') ? `&a${index}` : `a${index}`);

			if (free) frees.push(`${free}(&a${index});`);
		});
		const extra = decl.params.slice(witParams.length);
		let call;

		if (result == null) {
			if (extra.length) throw new Error(`${cName}: unexpected out-params`);
			call = `${cName}(${args.join(', ')});\nrt_reset();`;
		} else if (resultKind === 'result' || resultKind === 'option') {
			// wit-bindgen C: `bool f(args, T *ret[, E *err])`, true for ok / some, with an
			// out-param only for a side that carries a payload. The queue gets the
			// discriminant (1 = err / some) then that side's payload.
			const spec = typeKind(unalias(result))[1];
			const sides =
				resultKind === 'result'
					? [
							{ name: 'ret', type: spec.ok, when: 'ok' },
							{ name: 'err', type: spec.err, when: '!ok' }
						].filter((text) => text.type != null)
					: [{ name: 'ret', type: spec, when: 'ok' }];

			if (
				extra.length !== sides.length ||
				extra.some((param, index) => param.name !== sides[index].name)
			)
				throw new Error(
					`${cName}: out-params ${extra.map((param) => param.name)} do not match ${resultKind}`
				);
			const decls = extra.map((param) => `${valueType(param.type)} r_${param.name};`).join('\n');
			const lifts = sides
				.map((text, index) => {
					const free = freeFn(valueType(extra[index].type));
					return `if (${text.when}) { ${cLift(text.type, `r_${text.name}`)}${free ? ` ${free}(&r_${text.name});` : ''} }`;
				})
				.join('\n');
			const flag = resultKind === 'result' ? '!ok' : 'ok';
			call =
				`${decls}\nconst bool ok = ${cName}(${[...args, ...extra.map((param) => `&r_${param.name}`)].join(', ')});\n` +
				`rt_reset();\nrt_push_bool(${flag});\n${lifts}`;
		} else if (extra.length === 0) {
			call = `${decl.ret} r = ${cName}(${args.join(', ')});\nrt_reset();\n${cLift(result, 'r')}`;
		} else if (extra.length === 1 && extra[0].name === 'ret') {
			const ct = valueType(extra[0].type);
			const free = freeFn(ct);
			call =
				`${ct} r;\n${cName}(${[...args, '&r'].join(', ')});\nrt_reset();\n${cLift(result, 'r')}` +
				(free ? `\n${free}(&r);` : '');
		} else throw new Error(`${cName}: unexpected out-params ${extra.map((param) => param.name)}`);
		cImportCases.push(
			`case ${id}: { // ${specifier(iface)} ${fn.name}\n${locals.join('\n')}\n${call}\n${frees.join('\n')}\nbreak; }`
		);

		// JS: flatten the arguments in order, call, rebuild the result.
		const jsParams = witParams
			.filter((wp) => !(kind === 'method' && wp.name === 'self'))
			.map((wp) => jsParam(wp.name));
		const lowers = witParams
			.map((wp) =>
				kind === 'method' && wp.name === 'self'
					? 'P(this.__h);'
					: jsLower(wp.type, jsParam(wp.name))
			)
			.join('\n');
		const body = `Q();\n${lowers}\nrtImp(${id});`;

		if (kind === 'constructor') {
			importedResources.add(res);
			classes.set(res, classes.get(res) ?? { members: [] });
			classes.get(res).ctor = `constructor(${jsParams.join(', ')}) {\n${body}\nthis.__h = R();\n}`;
		} else if (kind === 'method' || kind === 'static') {
			importedResources.add(res);
			classes.set(res, classes.get(res) ?? { members: [] });
			const ret = jsReturn(result);
			classes
				.get(res)
				.members.push(
					`${kind === 'static' ? 'static ' : ''}${camel(name)}(${jsParams.join(', ')}) {\n${body}\n${ret}\n}`
				);
		} else {
			const ret = jsReturn(result);
			js.push(`export function ${camel(fn.name)}(${jsParams.join(', ')}) {\n${body}\n${ret}\n}`);
		}
	}

	// Resources this interface defines but never constructs still need a class.
	for (const tid of Object.values(iface.types))
		if (wit.types[tid].kind === 'resource' && !classes.has(tid)) classes.set(tid, { members: [] });

	for (const [res, kase] of classes) {
		const cls = resourceClass(res);
		// Handles the host hands the guest skip the constructor. Dropping imported
		// resources is not wired yet: the guest has no finalizer to hang it on.
		js.push(
			`export class ${cls} {\n${kase.ctor ?? ''}\n${kase.members.join('\n')}\n}\n` +
				`export function wrap${cls}(h) {\nconst o = Object.create(${cls}.prototype);\no.__h = h;\nreturn o;\n}`
		);
	}

	const file = `imp-${ifaceId}.mjs`;
	const helpers = () => [...jsFns.values()].join('\n\n');
	fs.writeFileSync(
		path.join(outDir, 'js', file),
		`// ${specifier(iface)} (generated by gen.mjs)\nimport { rtQ as Q, rtP as P, rtR as R, rtImp } from 'rt-bridge';\n` +
			`import { rtAwait, rtNow } from 'rt-async';\n${needImports(ifaceId)}\n\n` +
			"// jco's ComponentError: the message it builds, the value on `payload`.\n" +
			"function componentError(payload) {\nconst e = new Error(typeof payload === 'string' ? payload : (payload !== null && typeof payload === 'object' && typeof payload.tag === 'string' ? payload.tag : String(payload)) + ' (see error.payload)');\ne.payload = payload;\nreturn e;\n}\n\n" +
			js.join('\n\n') +
			'\n\n' +
			helpers() +
			'\n'
	);
	jsFns.clear();
	jsNeeds.clear();
	aliases[specifier(iface)] = path.resolve(outDir, 'js', file);
}

// ---- stream and future helpers (js/async.mjs) ----
// Per stream or future type the guest can reach: new, read, write, drop. They are
// canonical built-ins, not WIT functions; wit-bindgen C names them after the type
// (wasi_http_types_stream_u8_read), which mangle() reproduces to find them.

function mangle(typeRef) {
	if (typeof typeRef === 'string') return typeRef;
	const ty = wit.types[typeRef];

	if (ty.name) return snake(ty.name);
	const [kind, spec] = typeKind(typeRef);

	switch (kind) {
		case 'option':
			return `option_${mangle(spec)}`;
		case 'result':
			return `result_${spec.ok != null ? mangle(spec.ok) : 'void'}_${spec.err != null ? mangle(spec.err) : 'void'}`;
		case 'list':
			return `list_${mangle(spec)}`;
		case 'tuple':
			return `tuple${spec.types.length}_${spec.types.map(mangle).join('_')}`;
		case 'handle': {
			const [how, result] = Object.entries(spec)[0];
			return `${how}_${mangle(result)}`;
		}
		case 'stream':
			return `stream_${spec != null ? mangle(spec) : 'void'}`;
		case 'future':
			return `future_${spec != null ? mangle(spec) : 'void'}`;
		case 'type':
			return mangle(spec);
	}
	unsupported(`mangling ${kind}`);
}

// The stream and future types the world's functions reach. Only these: types of the
// same name in other packages (wasi:sockets' error-code beside wasi:http's) mangle to
// the same C name, and must not be matched against its functions.
const reachedEnds = [];
{
	const seen = new Set();
	const walk = (typeRef) => {
		if (typeof typeRef !== 'number' || seen.has(typeRef)) return;
		seen.add(typeRef);
		const [kind, spec] = typeKind(typeRef);

		if (kind === 'stream' || kind === 'future') reachedEnds.push(typeRef);

		if (spec == null || typeof spec !== 'object') return walk(spec);

		if (kind === 'record') spec.fields.forEach((field) => walk(field.type));
		else if (kind === 'variant') spec.cases.forEach((kase) => walk(kase.type));
		else if (kind === 'tuple') spec.types.forEach(walk);
		else if (kind === 'result') {
			walk(spec.ok);
			walk(spec.err);
		}
	};
	const fns = [...importedIfaces, ...exportedIfaces].flatMap((index) =>
		Object.values(wit.interfaces[index].functions)
	);

	for (const item of Object.values(world.exports)) if (item.function) fns.push(item.function);

	for (const fn of fns) {
		fn.params.forEach((decl) => walk(decl.type));
		walk(fn.result);
	}
}

const asyncJs = [];
const seenEnds = new Set();

for (const typeRef of reachedEnds) {
	const [kind, elem] = typeKind(typeRef);
	const match = mangle(typeRef);

	if (seenEnds.has(match)) continue;
	const base = [...protos.keys()]
		.filter((count) => count.endsWith(`_${match}_new`))
		.sort((left, right) => left.length - right.length)[0]
		?.slice(0, -4);

	if (!base) continue; // a type of an interface the world does not reach
	seenEnds.add(match);
	hasAsync = true;
	const ids = {
		new: importId++,
		read: importId++,
		write: importId++,
		dropR: importId++,
		dropW: importId++
	};
	// a drop behind a queued cancellation of the same end waits its turn (rt_cancel_queued)
	const drops = [
		[ids.dropR, 'readable'],
		[ids.dropW, 'writable']
	]
		.map(
			([id, end]) =>
				`case ${id}: { const uint32_t h = (uint32_t)rt_pop_num(); rt_reset();\n` +
				`if (rt_cancel_queued(h)) rt_defer(${id}, (void*)(uintptr_t)h, 1); else ${base}_drop_${end}(h);\nbreak; }`
		)
		.join('\n');

	cAsyncStart.push(
		`case ${ids.dropR}: ${base}_drop_readable((uint32_t)(uintptr_t)data); break;`,
		`case ${ids.dropW}: ${base}_drop_writable((uint32_t)(uintptr_t)data); break;`
	);
	cImportCases.push(
		`case ${ids.new}: { ${base}_writer_t w; const uint32_t r = ${base}_new(&w); rt_reset(); rt_push_num((f64)r); rt_push_num((f64)w); break; }\n${drops}`
	);
	const jsCommon =
		`export function ${match}_new() {\nQ();\nrtImp(${ids.new});\nreturn [R(), R()];\n}\n` +
		`export function ${match}_drop_readable(h) {\nQ();\nP(h);\nrtImp(${ids.dropR});\n}\n` +
		`export function ${match}_drop_writable(h) {\nQ();\nP(h);\nrtImp(${ids.dropW});\n}\n`;

	if (kind === 'stream') {
		if (elem !== 'u8') continue; // only byte streams are read and written from JS

		// Reads and writes go straight into and out of the Uint8Array's memory.
		for (const [op, fnName, weak] of [
			['read', 'read', 0],
			['write', 'write', 0]
		]) {
			const id = ids[op];
			cImportCases.push(
				`case ${id}: { rt_stream_op *s = malloc(sizeof *s); s->h = (uint32_t)rt_pop_num(); s->b = rt_pop_bytes(&s->n);\n` +
					`rt_reset();\nrt_push_bool(0);\nrt_push_num((f64)rt_defer(${id}, s, ${weak}));\nbreak; }`
			);
			cAsyncStart.push(
				`case ${id}: { rt_stream_op *s = data;\nconst uint32_t st = ${base}_${fnName}(s->h, s->b, s->n);\n` +
					`if (st == RT_WU(WAITABLE_STATUS_BLOCKED)) rt_pending_add(s->h, ${op === 'read' ? 'RT_OP_READ' : 'RT_OP_WRITE'}, ${id}, s, ${weak}, token);\n` +
					`else { rt_reset(); rt_async_complete(${id}, s, st); rt_settle(token); }\nbreak; }`
			);
			cAsyncComplete.push(`case ${id}: rt_push_stream_result(code); free(data); break;`);
			cAsyncCancel.push(`case ${id}: return ${base}_cancel_${fnName}(waitable);`);
			cAsyncAbandon.push(`case ${id}: free(data); break;`);
		}
		asyncJs.push(
			jsCommon +
				`/** Reads into buf; resolves { n, done } (done: the writer is gone). */\n` +
				`export function ${match}_read(h, buf) {\nQ();\nP(h);\nP(buf);\nrtImp(${ids.read});\nif (R()) return rtNow(streamResult);\nreturn rtAwait(R(), streamResult, buf);\n}\n` +
				`/** Writes from buf; resolves { n, done } (done: the reader is gone). */\n` +
				`export function ${match}_write(h, buf) {\nQ();\nP(h);\nP(buf);\nrtImp(${ids.write});\nif (R()) return rtNow(streamResult);\nreturn rtAwait(R(), streamResult, buf);\n}`
		);
		continue;
	}
	// future<T>: the value goes through a heap buffer of the payload's C type
	const rp = proto(`${base}_read`);
	const bt = valueType(rp.params[1].type);
	// the value goes through a heap record of the payload's C type
	const rec = `struct rt_future_${ids.read}`;
	cAsyncStructs.push(`${rec} { uint32_t h; ${bt} v; };`);
	cImportCases.push(
		`case ${ids.read}: { ${rec} *f = calloc(1, sizeof *f); f->h = (uint32_t)rt_pop_num();\n` +
			`rt_reset();\nrt_push_bool(0);\nrt_push_num((f64)rt_defer(${ids.read}, f, 0));\nbreak; }`,
		// a write nobody reads must not keep an async export waiting: weak
		`case ${ids.write}: { ${rec} *f = calloc(1, sizeof *f); f->h = (uint32_t)rt_pop_num();\n` +
			`${elem != null ? cLower(elem, '(f->v)') : ''}\nrt_reset();\nrt_push_bool(0);\nrt_push_num((f64)rt_defer(${ids.write}, f, 1));\nbreak; }`
	);

	for (const [id, fnName, kind, weak] of [
		[ids.read, 'read', 'RT_OP_READ', 0],
		[ids.write, 'write', 'RT_OP_WRITE', 1]
	]) {
		cAsyncCancel.push(`case ${id}: return ${base}_cancel_${fnName}(waitable);`);
		cAsyncAbandon.push(`case ${id}: free(data); break;`);
		cAsyncStart.push(
			`case ${id}: { ${rec} *f = data;\nconst uint32_t st = ${base}_${fnName}(f->h, &f->v);\n` +
				`if (st == RT_WU(WAITABLE_STATUS_BLOCKED)) rt_pending_add(f->h, ${kind}, ${id}, f, ${weak}, token);\n` +
				`else { rt_reset(); rt_async_complete(${id}, f, st); rt_settle(token); }\nbreak; }`
		);
	}
	cAsyncComplete.push(
		`case ${ids.read}: { ${rec} *f = data;\nconst bool got = RT_WU(WAITABLE_STATE)(code) == RT_WU(WAITABLE_COMPLETED);\nrt_push_bool(got);\n` +
			`if (got) { ${elem != null ? cLift(elem, '(f->v)') : ''} }\nfree(f);\nbreak; }`,
		`case ${ids.write}: { rt_push_bool(RT_WU(WAITABLE_STATE)(code) == RT_WU(WAITABLE_COMPLETED)); free(data); break; }`
	);
	const liftV = elem != null ? jsLift(elem) : 'undefined';
	asyncJs.push(
		jsCommon +
			`/** Resolves the value; rejects when the writer was dropped without writing. */\n` +
			`export function ${match}_read(h) {\nQ();\nP(h);\nrtImp(${ids.read});\n` +
			`const lift = () => {\nif (!R()) throw new Error('future dropped before it was written');\nreturn ${liftV};\n};\n` +
			`if (R()) return rtNow(lift);\nreturn rtAwait(R(), lift);\n}\n` +
			`/** Resolves true once read, false when the reader was dropped. */\n` +
			`export function ${match}_write(h, v) {\nQ();\nP(h);\n${elem != null ? jsLower(elem, 'v') : ''}\nrtImp(${ids.write});\n` +
			`if (R()) return rtNow(R);\nreturn rtAwait(R(), R);\n}`
	);
}

// the runtime's own imports: rtCancel (AbortSignal, clearTimeout), rtYield (scheduler.yield)
const cancelId = importId++;
const yieldId = importId++;

fs.writeFileSync(
	path.join(outDir, 'js', 'async.mjs'),
	`// Async plumbing and stream/future helpers (generated by gen.mjs). A pending operation's
// promise waits here under the token glue.c gave it; rtSettle (called from C when the
// operation's event arrives) resolves it from the result in the queue.
import { rtQ as Q, rtP as P, rtR as R, rtImp } from 'rt-bridge';
${needImports(-1)}

const pending = new Map();
let lastToken = 0;

/**
 * A promise settled by rtSettle(token); keep stays reachable until then. rtLastToken
 * names it right after the call that made it, for rtCancel.
 */
export function rtAwait(token, lift, keep) {
lastToken = token;
return new Promise((resolve, reject) => {
pending.set(token, [resolve, reject, lift, keep]);
});
}

/** The token of the operation the latest call is waiting for; 0 when it finished at once. */
export function rtLastToken() {
return lastToken;
}

/**
 * Cancels a pending operation: its promise rejects with reason now, and the host's side
 * of it ends (glue.c's rt_cancel). False when it had already settled.
 */
export function rtCancel(token, reason) {
const p = pending.get(token);
if (p === undefined) return false;
pending.delete(token);
Q();
P(token);
rtImp(${cancelId});
p[1](reason);
return true;
}

/** A promise settled after the host has had a turn (glue.c's rt_yield_request). */
export function rtYield() {
Q();
rtImp(${yieldId});
return rtAwait(R(), () => undefined);
}

/** An operation that finished at once. */
export function rtNow(lift) {
lastToken = 0;
try {
return Promise.resolve(lift());
} catch (e) {
return Promise.reject(e);
}
}

export function rtSettle(token) {
const p = pending.get(token);
if (p === undefined) return 0;
pending.delete(token);
let v;
try {
v = p[2]();
} catch (e) {
p[1](e);
return 0;
}
p[0](v);
return 0;
}

// Async export calls, several at once: each promise's outcome under its task id, polled
// by glue.c from the call's own thread.
const tasks = new Map();
let nextTask = 1;

export function rtTaskStart(start) {
const id = nextTask++;
const task = { state: 1, value: undefined };
tasks.set(id, task);
let p;
try {
p = Promise.resolve(start());
} catch (e) {
p = Promise.reject(e);
}
p.then(
(v) => {
task.state = 3;
task.value = v;
},
(e) => {
task.state = 2;
task.value = e;
console.error('async export failed: ' + (e !== null && typeof e === 'object' && e.message !== undefined ? e.message : e));
}
);
return id;
}

/** 0 still running, 1 resolved (value: rtTaskValue), 2 rejected. */
export function rtTaskPoll(id) {
const task = tasks.get(id);
if (task.state === 1) return 0;
return task.state === 3 ? 1 : 2;
}

/** The call's outcome; the call is forgotten after. */
export function rtTaskValue(id) {
const task = tasks.get(id);
tasks.delete(id);
return task.value;
}

function streamResult() {
return { n: R(), done: R() };
}

${asyncJs.join('\n\n')}

${[...jsFns.values()].join('\n\n')}

// glue.c settles a promise through here, callable from C
Porffor.c\`void rt_call_settle(uint32_t token) { (void)\${rtSettle}(porf_box_num((f64)token)); }\`;
`
);
aliases['rt-async'] = path.resolve(outDir, 'js', 'async.mjs');
jsFns.clear();
jsNeeds.clear();

// ---- exports ----

let exportId = 0;
const cExports = [];
const jsExportCases = [];
const exportedResources = new Set();

// The guest's JS name for an exported interface: jco's camelCase, qualified by the
// package when two exported interfaces share a name (meshx:query/store and
// meshx:settings/store become queryStore and settingsStore).
const exportNames = new Map();

for (const ifaceId of exportedIfaces) {
	const count = wit.interfaces[ifaceId].name;
	exportNames.set(count, (exportNames.get(count) ?? 0) + 1);
}
const jsExportName = (iface) =>
	exportNames.get(iface.name) > 1
		? camel(witPackage(iface).name) + pascal(iface.name)
		: camel(iface.name);

/** The C and JS for one exported function (of an interface, or of the world itself). */
function emitExport(fn, prefix, jsObj) {
	if (fnShape(fn).async) return emitAsyncExport(fn, prefix, jsObj);
	const id = exportId++;
	const { kind, res, name } = fnShape(fn);
	const cName = cFnName(prefix, fn);
	const hdr = proto(cName);
	const result = fn.result ?? null;
	const rk =
		result != null && typeof unalias(result) === 'number' ? typeKind(unalias(result))[0] : null;

	// C: push the arguments, run the guest, pop the result.
	const lifts = [],
		frees = [];
	fn.params.forEach((wp, index) => {
		const hp = hdr.params[index];

		if (kind === 'method' && wp.name === 'self') {
			lifts.push(`rt_push_num(${hp.name}->rep);`);
			return;
		}
		const isPtr = hp.type.endsWith('*');
		const free = freeFn(valueType(hp.type));

		if (hp.name.startsWith('maybe_')) {
			// an option parameter: a nullable pointer to its payload
			const inner = typeKind(unalias(wp.type))[1];
			lifts.push(
				`rt_push_bool(${hp.name} != NULL);\nif (${hp.name}) { ${cLift(inner, `(*${hp.name})`)} }`
			);

			if (free) frees.push(`if (${hp.name}) ${free}(${hp.name});`);
			return;
		}
		lifts.push(cLift(wp.type, isPtr ? `(*${hp.name})` : hp.name));

		if (free) frees.push(`${free}(${isPtr ? hp.name : '&' + hp.name});`);
	});
	const extra = hdr.params.slice(fn.params.length);
	let ret;
	let decl = '';

	if (kind === 'constructor') {
		const rec = `${prefix}_${snake(wit.types[res].name)}`;
		ret = `${rec}_t *self = malloc(sizeof *self);\nself->rep = rt_pop_num();\nLEAVE();\nreturn ${rec}_new(self);`;
	} else if (result == null) {
		ret = 'LEAVE();';
	} else if (rk === 'result') {
		// wit-bindgen C: `bool f(args, T *ret, E *err)`, true for ok, an out-param per
		// side with a payload. The queue holds is-err then that side's payload.
		const spec = typeKind(unalias(result))[1];
		const outParam = (count) => extra.find((param) => param.name === count);
		ret =
			`const bool is_err = rt_pop_bool();\n` +
			`if (!is_err) { ${spec.ok != null ? cLower(spec.ok, `(*${outParam('ret').name})`) : ''} }\n` +
			`else { ${spec.err != null ? cLower(spec.err, `(*${outParam('err').name})`) : ''} }\n` +
			`LEAVE();\nreturn !is_err;`;
	} else if (rk === 'option') {
		const spec = typeKind(unalias(result))[1];
		ret = `const bool some = rt_pop_bool();\nif (some) { ${cLower(spec, '(*ret)')} }\nLEAVE();\nreturn some;`;
	} else if (extra.length === 0) {
		decl = `${hdr.ret} r;\n`;
		ret = `${cLower(result, 'r')}\nLEAVE();\nreturn r;`;
	} else if (extra.length === 1 && extra[0].name === 'ret') {
		ret = `${cLower(result, `(*${extra[0].name})`)}\nLEAVE();`;
	} else throw new Error(`${cName}: unexpected out-params`);
	const sig = `${hdr.ret} ${cName}(${hdr.params.map((param) => `${param.type} ${param.name}`).join(', ') || 'void'})`;
	cExports.push(
		`${sig} {\nENTER();\n${decl}rt_reset();\n${lifts.join('\n')}\n${frees.join('\n')}\nrt_call_exp(${id});\n${ret}\n}`
	);

	// JS: rebuild the arguments, call the guest, flatten the result.
	const argNames = [],
		argReads = [];

	for (const wp of fn.params) {
		if (kind === 'method' && wp.name === 'self') continue;
		const left = `a_${snake(wp.name)}`;
		argNames.push(left);
		argReads.push(`const ${left} = ${jsLift(wp.type)};`);
	}
	const selfRead = kind === 'method' ? 'const self = reps[R()];\n' : '';
	let call;

	if (kind === 'constructor') {
		call = `reps.push(new ${jsObj}.${resourceClass(res)}(${argNames.join(', ')}));\nQ();\nP(reps.length - 1);`;
	} else {
		const target =
			kind === 'method'
				? `self.${camel(name)}`
				: kind === 'static'
					? `${jsObj}.${resourceClass(res)}.${camel(name)}`
					: `${jsObj}.${camel(fn.name)}`;
		const invoke = `${target}(${argNames.join(', ')})`;

		if (result == null) call = `${invoke};\nQ();`;
		else if (rk === 'result') {
			// jco's convention: a normal return is ok, a throw is err, its payload the
			// thrown value's `payload` when it has one.
			const spec = typeKind(unalias(result))[1];
			call =
				`let r;\ntry { r = ${invoke}; }\n` +
				`catch (e) { Q(); P(1); ${spec.err != null ? jsLower(spec.err, "(e !== null && typeof e === 'object' && e.payload !== undefined ? e.payload : e)") : ''} return 0; }\n` +
				`Q();\nP(0);\n${spec.ok != null ? jsLower(spec.ok, 'r') : ''}`;
		} else call = `const r = ${invoke};\nQ();\n${jsLower(result, 'r')}`;
	}
	jsExportCases.push(
		`case ${id}: { // ${fn.name}\n${selfRead}${argReads.join('\n')}\n${call}\nreturn 0; }`
	);
}

/**
 * An async export on the callback ABI (a function, or a resource's method or static
 * function): the call starts the guest's function and returns
 * WAIT while its promise is pending; each event comes back through the callback, which
 * settles the operation's promise and runs the microtasks; once the export's promise
 * settles, task.return carries its value and the callback code is EXIT.
 */
function emitAsyncExport(fn, prefix, jsObj) {
	hasAsync = true;
	const id = exportId++;
	const pollId = exportId++;
	const { kind, res, name } = fnShape(fn);

	// P3 lifts no async constructor, and a JS one could not be
	if (kind === 'constructor') unsupported('async constructors as exports');
	const cName = cFnName(prefix, fn);
	const decl = proto(cName);
	const result = fn.result ?? null;
	const lifts = [],
		frees = [];
	fn.params.forEach((wp, index) => {
		const hp = decl.params[index];

		// a method's resource: its rep, as for a sync method
		if (kind === 'method' && wp.name === 'self') {
			lifts.push(`rt_push_num(${hp.name}->rep);`);
			return;
		}
		const isPtr = hp.type.endsWith('*');
		lifts.push(cLift(wp.type, isPtr ? `(*${hp.name})` : hp.name));
		const free = freeFn(valueType(hp.type));

		if (free) frees.push(`${free}(${isPtr ? hp.name : '&' + hp.name});`);
	});
	const rp = proto(`${cName}_return`);
	let give = `${cName}_return();`;

	if (result != null) {
		const rt = valueType(rp.params[0].type);
		const free = freeFn(rt);
		give =
			`${rt} r;\n${cLower(result, 'r')}\n${cName}_return(${rp.params[0].type.endsWith('*') ? '&r' : 'r'});` +
			(free ? `\n${free}(&r);` : '');
	}
	const cb = proto(`${cName}_callback`);
	const params = decl.params.map((param) => `${param.type} ${param.name}`).join(', ') || 'void';
	const cbParams = cb.params.map((param) => `${param.type} ${param.name}`).join(', ');
	cExports.push(
		'#if RT_STACKFUL\n' +
			`${decl.ret} ${cName}(${params}) {\n` +
			// each call on its own thread, several at once: its task id keys its promise's
			// outcome (js/async.mjs); rt_wait_turn shares the one event loop among them
			`ENTER();\nrt_waitset_own();\nrt_reset();\n${lifts.join('\n')}\n${frees.join('\n')}\nrt_call_exp(${id});\n` +
			`const f64 task = rt_pop_num();\nrt_calls++;\n` +
			`for (;;) {\nporf_run_jobs();\nrt_async_poll();\nrt_stdio_flush();\n` +
			`rt_reset();\nrt_push_num(task);\nrt_call_exp(${pollId});\nconst int st = (int)rt_pop_num();\n` +
			`if (st == 1) break;\n` +
			`if (st == 2) rt_fail("async export ${fn.name} rejected (see stderr)");\n` +
			// yields waiting: the host gets a turn (a GC safe point too), then they settle
			`if (rt_nyield > 0) { RT_W(thread_yield)(); porf_gc_run_pending(); rt_settle_yields(); continue; }\n` +
			`rt_wait_turn("async export ${fn.name}");\n}\n` +
			`${give}\n` +
			// the value is returned; the thread lives on until the host work it started is
			// done (a response body streaming out after its head goes on this way too)
			`for (;;) {\nporf_run_jobs();\nrt_async_poll();\nrt_stdio_flush();\n` +
			`if (rt_nyield > 0) { RT_W(thread_yield)(); porf_gc_run_pending(); rt_settle_yields(); continue; }\n` +
			`if (rt_thread_outstanding() == 0) break;\n` +
			`rt_wait_turn("async export ${fn.name}");\n}\n` +
			// the loop is someone else's now
			`rt_calls--;\nrt_waitset_drop();\nrt_wake_parked();\n` +
			`return RT_WU(CALLBACK_CODE_EXIT);\n}\n\n` +
			// lifted stackful: the host never calls the callback
			`${cb.ret} ${cName}_callback(${cbParams}) {\n(void)${cb.params[0].name};\nrt_fail("stackful async export: no callback");\n}\n` +
			'#else\n' +
			// lifted with a callback: the same loop, a turn at a time. A turn ends by returning
			// WAIT, YIELD or EXIT to the host, which calls back with the next event
			`static ${decl.ret} ${cName}_turn(rt_task* t) {\n` +
			`for (;;) {\nporf_run_jobs();\nrt_async_poll();\nrt_stdio_flush();\n` +
			`if (!t->returned) {\n` +
			`rt_reset();\nrt_push_num(t->js);\nrt_call_exp(${pollId});\nconst int st = (int)rt_pop_num();\n` +
			`if (st == 2) rt_fail("async export ${fn.name} rejected (see stderr)");\n` +
			// the value is returned; the task lives on until the host work it started is
			// done (a response body streaming out after its head goes on this way too)
			`if (st == 1) {\n${give}\nt->returned = 1;\ncontinue;\n}\n` +
			`} else if (rt_thread_outstanding() == 0) return rt_task_end(t);\n` +
			// yields waiting: the host gets a turn, and they settle when it calls back
			`if (rt_nyield > 0) {\nt->yielding = 1;\nreturn rt_task_turn(RT_WU(CALLBACK_CODE_YIELD));\n}\n` +
			`return rt_task_wait(t, "async export ${fn.name}");\n}\n}\n\n` +
			`${decl.ret} ${cName}(${params}) {\n` +
			`ENTER();\nrt_task* t = rt_task_start();\nrt_reset();\n${lifts.join('\n')}\n${frees.join('\n')}\nrt_call_exp(${id});\n` +
			`t->js = rt_pop_num();\nreturn ${cName}_turn(t);\n}\n\n` +
			// each callback is a fresh entry: a GC safe point, with nothing on the stack
			`${cb.ret} ${cName}_callback(${cbParams}) {\nENTER();\nreturn ${cName}_turn(rt_task_resume(${cb.params[0].name}));\n}\n` +
			'#endif'
	);
	const argNames = [],
		argReads = [];

	for (const wp of fn.params) {
		if (kind === 'method' && wp.name === 'self') continue;
		const left = `a_${snake(wp.name)}`;
		argNames.push(left);
		argReads.push(`const ${left} = ${jsLift(wp.type)};`);
	}
	// what the task runs: the guest's function, or a resource's method or static function
	const selfRead = kind === 'method' ? 'const self = reps[R()];\n' : '';
	const target =
		kind === 'method'
			? `self.${camel(name)}`
			: kind === 'static'
				? `${jsObj}.${resourceClass(res)}.${camel(name)}`
				: `${jsObj}.${camel(fn.name)}`;
	// a primitive (string, u32 …) has no type entry: only a type reference can be a result
	const [resultKind, resultSpec] =
		result != null && typeof unalias(result) !== 'string'
			? typeKind(unalias(result))
			: [null, null];
	jsExportCases.push(
		`case ${id}: { // ${fn.name} (async)\n${selfRead}${argReads.join('\n')}\nconst task = rtTaskStart(() => ${target}(${argNames.join(', ')}));\nQ();\nP(task);\nreturn 0; }`,
		`case ${pollId}: { // ${fn.name}: settled yet?\nconst task = R();\nconst s = rtTaskPoll(task);\n` +
			(resultKind === 'result'
				? // jco's convention, as for the sync exports: resolving is ok, rejecting is err
					// (its payload the thrown value's `payload` when it has one)
					`if (s === 0) { Q(); P(0); return 0; }\nconst r = rtTaskValue(task);\nQ();\nP(1);\n` +
					`if (s === 1) { P(0); ${resultSpec.ok != null ? jsLower(resultSpec.ok, 'r') : ''} }\n` +
					`else { P(1); ${resultSpec.err != null ? jsLower(resultSpec.err, "(r !== null && typeof r === 'object' && r.payload !== undefined ? r.payload : r)") : ''} }\n`
				: `Q();\nP(s);\n` +
					(result != null
						? `if (s === 1) { const r = rtTaskValue(task); ${jsLower(result, 'r')} }\n`
						: '')) +
			`return 0; }`
	);
}

for (const ifaceId of exportedIfaces) {
	const iface = wit.interfaces[ifaceId];
	const prefix = cPrefix(iface, true);
	const jsObj = `guest.${jsExportName(iface)}`;

	for (const [tname, tid] of Object.entries(iface.types)) {
		if (wit.types[tid].kind !== 'resource') continue;
		exportedResources.add(tid);
		const result = `${prefix}_${snake(tname)}`;
		const dropId = exportId++;
		// The rep is the guest-side index into `reps`, where the JS instance lives.
		cExports.push(
			`struct ${result}_t { f64 rep; };\n\n` +
				`void ${result}_destructor(${result}_t *self) {\nENTER();\nrt_reset();\nrt_push_num(self->rep);\nrt_call_exp(${dropId});\nLEAVE();\nfree(self);\n}`
		);
		jsExportCases.push(`case ${dropId}: reps[R()] = undefined; Q(); return 0; // drop ${tname}`);
	}

	for (const fn of Object.values(iface.functions)) emitExport(fn, prefix, jsObj);
}

for (const [key, item] of Object.entries(world.exports)) {
	if (item.interface) continue;

	if (!item.function) unsupported(`world-level export ${key}`);
	emitExport(item.function, `exports_${snake(worldName)}`, 'guest');
}

fs.writeFileSync(
	path.join(outDir, 'js', 'entry.mjs'),
	`// The guest plus its export router (generated by gen.mjs). glue.c calls rtExp(id)
// with the arguments already in the queue, and reads the result back from it.
import * as guest from 'rt-guest';
import { rtQ as Q, rtP as P, rtR as R } from 'rt-bridge';
import { rtTaskStart, rtTaskPoll, rtTaskValue } from 'rt-async';
${needImports(-1)}

// Exported resource instances; a rep is an index here.
const reps = [];

function rtExp(id) {
switch (id) {
${jsExportCases.join('\n')}
}
return 0;
}

${[...jsFns.values()].join('\n\n')}

// glue.c's way into the program: the export router, callable from C
Porffor.c\`void rt_call_exp(int id) { (void)\${rtExp}(porf_box_num((f64)id)); }\`;
`
);

// RT_JSVAL: a parameter Porffor compiled as a number, boxed back to a jsval. Its helpers are
// declared where it is used (block scope); the macro once per C file
const cJsval = `jsval rt_jsval(jsval v);
	jsval rt_jsnum(f64 v);
#ifndef RT_JSVAL
#define RT_JSVAL(x) _Generic((x), jsval: rt_jsval, default: rt_jsnum)(x)
#endif`;

fs.writeFileSync(
	path.join(outDir, 'js', 'rt.mjs'),
	`// The value queue's JS side (generated by gen.mjs): each function returns straight
// from C (core.c). The JS after it never runs; it only makes the return value
// opaque to Porffor's type inference, so no call site assumes what C hands back.
// Each function declares what it calls itself, at block scope: with --units the four can
// land in different C files, and a top-level Porffor.c block lands in only one of them.
const slot = [];
export function rtQ() { Porffor.c\`jsval rt_js_Q(void);
	return rt_js_Q();\`; return slot.pop(); }
export function rtP(v) { Porffor.c\`jsval rt_js_P(jsval v);
	${cJsval}
	return rt_js_P(RT_JSVAL(\${v}));\`; slot.push(v); return slot.pop(); }
export function rtR() { Porffor.c\`jsval rt_js_R(void);
	return rt_js_R();\`; return slot.pop(); }
export function rtImp(id) { Porffor.c\`jsval rt_js_Imp(jsval id);
	${cJsval}
	return rt_js_Imp(RT_JSVAL(\${id}));\`; slot.push(id); return slot.pop(); }
`
);

// a world that imports wasi:clocks/timezone gives Porffor's Date and Temporal.Now the host's
// time zone: glue.c defines the two hooks its C runtime calls under PORF_HOST_TIMEZONE
const hasTimezone = [...importedIfaces].some(
	(id) => specifier(wit.interfaces[id]) === 'wasi:clocks/timezone@0.3.0'
);
const cTimezone = `
// ---- the host's time zone (wasi:clocks/timezone), for Porffor's local time ----

f64 porf_host_tz_offset_ms(f64 t) {
const f64 s = floor(t / 1000.0);
wasi_clocks_timezone_instant_t when = { (int64_t)s, (uint32_t)((t - s * 1000.0) * 1000000.0) };
int64_t ns;
return wasi_clocks_timezone_utc_offset(&when, &ns) ? (f64)(ns / 1000000) : 0;
}

int porf_host_tz_id(char* buf, int cap) {
${snake(worldName)}_string_t id;
if (!wasi_clocks_timezone_iana_id(&id)) return 0;
const int n = id.len <= (size_t)cap ? (int)id.len : 0;
memcpy(buf, id.ptr, (size_t)n);
${snake(worldName)}_string_free(&id);
return n;
}
`;

fs.writeFileSync(
	path.join(outDir, 'glue.c'),
	`// Component glue for a Porffor-compiled guest (generated by gen.mjs from world ${worldName}).
${hasAsync ? `#define RT_ASYNC 1\n#define RT_W(x) ${snake(worldName)}_##x\n#define RT_WU(x) ${snake(worldName).toUpperCase()}_##x\n` : ''}#include "bindings/${snake(worldName)}.h"
#ifdef RT_SPLIT
#include "porf.h" // the program compiled on its own, in units (--units)
#else
#include "entry.c"
#endif
#include "${path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../runtime/c/core.c')}"
${
	hasAsync
		? `#include "${path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../runtime/c/async.c')}"

// ---- async call records and completions ----

${cAsyncStructs.join('\n')}

static void rt_async_start(int op, void* data, uint32_t token) {
(void)data; (void)token;
switch (op) {
${cAsyncStart.join('\n')}
default: rt_fail("unknown async operation to start");
}
}

static void rt_async_complete(int op, void* data, uint32_t code) {
(void)data; (void)code;
switch (op) {
${cAsyncComplete.join('\n')}
default: rt_fail("unknown async operation");
}
}

static uint32_t rt_async_cancel(int op, uint32_t waitable) {
switch (op) {
${cAsyncCancel.join('\n')}
default: rt_fail("unknown async operation to cancel");
}
return 0;
}

static void rt_async_abandon(int op, void* data) {
(void)data;
switch (op) {
${cAsyncAbandon.join('\n')}
default: rt_fail("unknown async operation to abandon");
}
}
`
		: ''
}
// ---- imports: rtImp(id) from js/imp-*.mjs ----

static void rt_import(int id) {
switch (id) {
${cImportCases.join('\n')}
${
	hasAsync
		? `case ${cancelId}: rt_cancel((uint32_t)rt_pop_num()); rt_reset(); break;\n` +
			`case ${yieldId}: rt_reset(); rt_push_num((f64)rt_yield_request()); break;`
		: ''
}
default: rt_fail("unknown import id");
}
}

// ---- exports ----

${cExports.join('\n\n')}
${hasTimezone ? cTimezone : ''}`
);

fs.writeFileSync(path.join(outDir, 'aliases.json'), JSON.stringify(aliases, null, 1));
// a fetch-handler server: the world exports wasi:http/handler (bundle.mjs wires the guest's
// default export's fetch to it)
const httpHandler = [...exportedIfaces].some((id) =>
	specifier(wit.interfaces[id]).startsWith('wasi:http/handler@0.3')
);

fs.writeFileSync(
	path.join(outDir, 'features.json'),
	JSON.stringify({ async: hasAsync, httpHandler, timezone: hasTimezone })
);
console.log(
	`${worldName}: ${importId} imports, ${exportId} exports, resources imported [${[...importedResources].map((result) => wit.types[result].name)}] exported [${[...exportedResources].map((result) => wit.types[result].name)}]`
);
