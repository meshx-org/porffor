# TODO

## Semantics

- [ ] Separate module scope from the global object (top-level functions of an ES module are
      linked to `globalThis`)
- [ ] Resolve globals created at run time (`self[name] = …`, `Object.defineProperty(globalThis, …)`,
      UMD `root["X"] = …`); free names are bound at compile time
- [ ] `for await` over any object with `Symbol.asyncIterator`
- [ ] Complete builtin prototypes under reflection (`Object.getOwnPropertyNames`, computed keys)
- [ ] Run-time `eval` / `new Function`: implement or document as unsupported

## Builtins

- [ ] `String.prototype.normalize`
- [ ] Locale-aware `localeCompare` and `toLocaleString`

## Code size and speed

- [ ] Profile react_ssr for a possible regression from closure environment snapshots in direct
      closure calls
- [ ] Generate every argument of a type-dispatched method call once, not per branch
- [ ] A `throw` lexically inside a `try` of the same function: jump to the catch with the value,
      no longjmp. A throw costs ~20 ns native, ~0.19 µs in V8's wasm and ~2.8 µs in wasmtime
      (its unwinding, whatever the collector or backtrace setting); entering a `try` costs
      nothing extra anywhere
- [ ] Throws across calls without engine exceptions: a pending-exception result each call site
      checks (as QuickJS does), so wasmtime pays no unwinding and `throw` works without wasm EH.
      Overlaps the setjmp-free `try` stackless coroutines need
- [ ] Standalone wasm collects nothing under `PORF_GC_DEFER` (no safe point until `main`
      returns; a component collects at each export). Safe points (loop back-edges, allocating
      calls) with the live pointer-holding locals spilled to a shadow frame the collector scans

## test262

- [ ] Triage the failing tests by directory and fix the largest groups

## Tooling

- [ ] `PORF_TRAP_INTERNAL_THROW` without `__builtin_trap` (tcc)
- [ ] test262 runner: refuse the gcc fallback above a few threads
