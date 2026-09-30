import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runtimeDir } from './modules.js';

// The C a native build with the runtime (--runtime) links: the runtime's vendored libraries
// (runtime/c/<name>, what to compile in its sources.json), each built once per copy into a cached
// static archive with cc. Nothing is fetched. An archive only brings in what the program calls, so
// scrypt costs nothing in a program that never hashes, mbedTLS (fetch's TLS) nothing in one that
// never fetches, and llhttp (the server's HTTP parser) nothing in one that never serves
const RUNTIME_DEPS = [ 'libuv', 'scrypt', 'mbedtls', 'llhttp' ];

// each function and datum in its own section, so --gc-sections drops what is not called (the
// Mach-O linker's -dead_strip does not need them)
const CFLAGS = [ '-O2', '-w', '-ffunction-sections', '-fdata-sections' ];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  stdio: 'pipe',
  encoding: 'utf8',
  ...opts
});

const NO_PLATFORM = { sources: [], defines: [], libs: [] };

// one library's archive, the include directory its users need (if any), and what linking it needs
export const ensureDepBuilt = name => {
  const dir = path.join(runtimeDir(), 'c', name);
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'));
  const platform = list.platforms ? list.platforms[process.platform] : NO_PLATFORM;
  if (!platform) throw new Error(`porffor: the runtime's ${name} is not built for ${process.platform} yet`);

  // one archive per copy of the sources (their list's text keys it, and the text of the config
  // headers it names, which the sources' own paths do not cover) and compiler
  const cc = process.env.CC ?? 'cc';
  let key = 0x811c9dc5;
  const config = (list.config ?? []).map(x => fs.readFileSync(path.join(dir, x), 'utf8'));
  const keyText = JSON.stringify(list) + config.join('') + cc + CFLAGS.join(' ');
  for (let i = 0; i < keyText.length; i++) key = Math.imul(key ^ keyText.charCodeAt(i), 0x01000193);
  const cacheDir = path.join(os.homedir(), '.cache', 'porffor', 'deps', `${name}-${(key >>> 0).toString(36)}`);
  const archive = path.join(cacheDir, `${name}.a`);
  const out = { archive, include: list.headers ? path.join(dir, list.headers) : null, libs: platform.libs };
  if (fs.existsSync(archive)) return out;

  const objDir = path.join(cacheDir, `.build-${process.pid}`);
  fs.rmSync(objDir, { recursive: true, force: true });
  fs.mkdirSync(objDir, { recursive: true });

  const objects = [];
  try {
    for (const source of [ ...list.common, ...platform.sources ]) {
      const object = path.join(objDir, source.replace(/[/.]/g, '_') + '.o');
      run(cc, [
        '-c', ...CFLAGS,
        ...[ ...(list.defines ?? []), ...platform.defines ].map(x => `-D${x}`),
        ...list.includes.flatMap(x => [ '-I', path.join(dir, x) ]),
        path.join(dir, source), '-o', object
      ]);
      objects.push(object);
    }
    run('ar', [ 'rcs', archive + '.tmp', ...objects ]);
    fs.renameSync(archive + '.tmp', archive);
  } catch (error) {
    fs.rmSync(archive + '.tmp', { force: true });
    const stderr = error?.stderr?.toString?.().trim?.();
    const stdout = error?.stdout?.toString?.().trim?.();
    throw new Error(stderr || stdout || `failed to build ${name}.a`);
  } finally {
    fs.rmSync(objDir, { recursive: true, force: true });
  }

  return out;
};

// The runtime's Rust libraries: runtime/<name>, a Cargo crate built by cargo into a static archive
// (its C ABI, feature `features`). Unlike the C ones, one is built and linked only for a program
// whose C calls it (names `symbol`): building takes cargo, a crates.io download the first time and
// a minute, which a program that never formats a date should not need. Intl is ICU4X
// (runtime/intl, called by runtime/host/native/intl), its types generated from meshx:intl's WIT
// (`wit`, beside runtime/)
const CARGO_DEPS = [ {
  name: 'intl', crate: 'meshx-intl', symbol: 'porf_intl_call', features: 'capi',
  wit: '../wasi/wit/meshx-intl-0.1.0'
} ];

// the files under dir, its subdirectories' too, sorted (a walk: the selfhosted compiler's fs has
// no recursive readdir)
const filesUnder = dir => fs.readdirSync(dir).sort().flatMap(x => {
  const file = path.join(dir, x);
  return fs.statSync(file).isDirectory() ? filesUnder(file) : [ file ];
});

// one Rust library's archive and the system libraries linking it needs (rustc's
// native-static-libs), built once per copy of the crate and cached like the C ones
export const ensureCargoDep = ({ name, crate, features, wit }) => {
  const dir = path.join(runtimeDir(), name);
  // keyed by what decides the build: the manifest, lock file, sources and WIT, and the features
  let key = 0x811c9dc5;
  const inputs = [ path.join(dir, 'Cargo.toml'), path.join(dir, 'Cargo.lock'), ...filesUnder(path.join(dir, 'src')), ...filesUnder(path.join(runtimeDir(), wit)) ];
  const keyText = inputs.map(x => path.relative(dir, x) + '\0' + fs.readFileSync(x, 'utf8')).join('\0') + features;
  for (let i = 0; i < keyText.length; i++) key = Math.imul(key ^ keyText.charCodeAt(i), 0x01000193);
  const depsDir = path.join(os.homedir(), '.cache', 'porffor', 'deps');
  const cacheDir = path.join(depsDir, `${name}-${(key >>> 0).toString(36)}`);
  const archive = path.join(cacheDir, `${name}.a`);
  const libsFile = path.join(cacheDir, 'libs.json');
  if (fs.existsSync(archive) && fs.existsSync(libsFile)) return { archive, include: null, libs: JSON.parse(fs.readFileSync(libsFile, 'utf8')) };

  try {
    run('cargo', [ '--version' ]);
  } catch {
    throw new Error(`porffor: this program uses the runtime's ${name} (runtime/${name}, Rust), which a native build compiles with cargo, and cargo was not found: install Rust (https://rustup.rs)`);
  }

  // one target directory for every copy, so a change rebuilds only the crate, not its
  // dependencies. The crate itself is always rebuilt (cleaned first): rustc prints the system
  // libraries the archive needs (native-static-libs) only when it builds it
  const targetDir = path.join(depsDir, `${name}-target`);
  const manifest = [ '--manifest-path', path.join(dir, 'Cargo.toml'), '--target-dir', targetDir ];
  let log;
  try {
    if (process.stderr?.isTTY) process.stderr.write(`porffor: building the runtime's ${name} with cargo (once)...\n`);
    run('cargo', [ 'clean', '--release', '-p', crate, ...manifest ]);
    // rustc prints the libraries on stderr, which a success does not return: both, through sh
    log = run('sh', [ '-c', '"$0" "$@" 2>&1', 'cargo',
      'rustc', '--release', '--lib', '--locked', ...manifest,
      '--no-default-features', '--features', features, '--crate-type', 'staticlib',
      '--', '--print', 'native-static-libs'
    ]);
  } catch (error) {
    // the end of cargo's log, where its error is
    const text = (error?.stdout?.toString?.() || error?.stderr?.toString?.() || '').trim().split('\n').slice(-40).join('\n');
    throw new Error(text || `failed to build the runtime's ${name} with cargo`);
  }
  // what the C compiler links anyway, and the Mach-O umbrella, are not repeated
  const libsLine = /native-static-libs: (.*)/.exec(log)?.[1] ?? '';
  const libs = [ ...new Set(libsLine.trim().split(/\s+/).filter(x => x && ![ '-lc', '-lSystem' ].includes(x))) ];

  const lib = path.join(targetDir, 'release', `lib${crate.replace(/-/g, '_')}.a`);
  fs.mkdirSync(cacheDir, { recursive: true });
  run('cp', [ lib, archive + '.tmp' ]);
  fs.renameSync(archive + '.tmp', archive);
  fs.writeFileSync(libsFile, JSON.stringify(libs));
  return { archive, include: null, libs };
};

// every runtime library: the compiler's -I flags, and the archives and libraries to link. `code`,
// the program's C (a string or the units' strings), decides which Rust libraries it needs
export const runtimeDeps = (code = '') => {
  const text = Array.isArray(code) ? code.join('\n') : code;
  const deps = [
    ...RUNTIME_DEPS.map(ensureDepBuilt),
    ...CARGO_DEPS.filter(x => text.includes(x.symbol)).map(ensureCargoDep)
  ];
  return {
    include: deps.filter(x => x.include).flatMap(x => [ '-I', x.include ]),
    link: [ ...deps.map(x => x.archive), ...new Set(deps.flatMap(x => x.libs)) ]
  };
};
