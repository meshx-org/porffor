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

## test262

- [ ] Triage the failing tests by directory and fix the largest groups

## Tooling

- [ ] `PORF_TRAP_INTERNAL_THROW` without `__builtin_trap` (tcc)
- [ ] test262 runner: refuse the gcc fallback above a few threads
