// WASI host: child processes, which WASI has none of: spawning is Node's ENOSYS error.
// runtime/host/native/child_process.mjs is the same over libuv (uv_spawn).
const ENOSYS = -38;

// as the native host's, but never runs anything: the spawn error ENOSYS
export const spawnSync = () => [0, 0, '', '', ENOSYS];

export const writeStderr = () => undefined;

export const errorName = (code) => (code === ENOSYS ? 'ENOSYS' : 'UNKNOWN');
export const errorMessage = (code) =>
	code === ENOSYS ? 'function not implemented' : 'unknown error';
