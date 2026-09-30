// The selfhosted compiler's Node: the process and timer globals, and the node:fs / node:child_process
// the compiler's patched imports read (build.mjs), from the JS runtime (runtime/node), as a program
// built with the runtime has them
import process from '../runtime/node/process.mjs';
import { clearInterval, clearTimeout, setInterval, setTimeout } from '../runtime/node-timers.mjs';
import fs from '../runtime/node/fs.mjs';
import child_process from '../runtime/node/child_process.mjs';

// the compiler's arguments follow its script (cli/index.js), as under node; a compiled program's
// argv[1] is the program itself
process.argv[1] = 'cli/index.js';

globalThis.process = process;
globalThis.setTimeout = setTimeout;
globalThis.setInterval = setInterval;
globalThis.clearTimeout = clearTimeout;
globalThis.clearInterval = clearInterval;

globalThis.__porfforNode = { fs, child_process };
