// The selfhosted compiler's Node: the process global, and the node:fs / node:child_process the
// compiler's patched imports read (build.mjs), from the JS runtime (runtime/node, runtime/host)
import * as proc from '../runtime/host/native/process.mjs';
import fs from '../runtime/node/fs.mjs';
import child_process from '../runtime/node/child_process.mjs';

const argv = [];
if (proc.argCount() > 0) argv.push(proc.arg(0));
argv.push('cli/index.js');
for (let i = 1; i < proc.argCount(); i++) argv.push(proc.arg(i));

globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

globalThis.process = {
  argv,
  env: proc.env(),
  cwd: () => proc.cwd(),
  platform: proc.platform(),
  version: 'porffor-native',
  stdin: {
    readLine: proc.readLine
  },
  stdout: {
    isTTY: proc.isTTY(1),
    write: proc.write
  },
  exit: proc.exit
};

globalThis.__porfforNode = { fs, child_process };
