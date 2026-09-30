// node:child_process: what Porffor's compiler runs (so it can compile itself), execSync and
// execFileSync with Node's signatures, over the host's (host/native/child_process.mjs).
import * as host from '../host/native/child_process.mjs';

export const execSync = host.execSync;
export const execFileSync = host.execFileSync;

export default { execSync, execFileSync };
