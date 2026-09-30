// node:os: the machine and the user, with Node's signatures, over the platform's
// (porffor:process: libuv's natively; WASI tells little: one processor, no memory totals).
import * as host from 'porffor:process';

export const EOL = '\n';
export const devNull = '/dev/null';

export const platform = () => host.platform();
export const homedir = () => host.homedir();
export const tmpdir = () => host.tmpdir();
export const hostname = () => host.hostname();

// uname(2): the system's name (Darwin, Linux), its release and version, the machine
export const type = () => host.systemInfo(0);
export const release = () => host.systemInfo(1);
export const machine = () => host.systemInfo(2);
export const version = () => host.systemInfo(3);

// the architecture as Node names it (x64, arm64), from the machine uname gives
export const arch = () => {
	const m = host.systemInfo(2);
	if (m === 'x86_64' || m === 'amd64') return 'x64';
	if (m === 'aarch64' || m === 'arm64') return 'arm64';
	if (m === 'i386' || m === 'i686') return 'ia32';
	if (m.startsWith('arm')) return 'arm';
	return m;
};

export const endianness = () => 'LE';
export const availableParallelism = () => host.cpuCount();
export const totalmem = () => host.totalMemory();
export const freemem = () => host.freeMemory();
export const uptime = () => host.uptime();

export const cpus = () => {
	const out = [];
	for (const [model, speed, user, nice, sys, idle, irq] of host.cpus()) {
		out.push({ model, speed, times: { user, nice, sys, idle, irq } });
	}
	return out;
};

export default {
	EOL,
	devNull,
	platform,
	homedir,
	tmpdir,
	hostname,
	type,
	release,
	machine,
	version,
	arch,
	endianness,
	availableParallelism,
	totalmem,
	freemem,
	uptime,
	cpus
};
