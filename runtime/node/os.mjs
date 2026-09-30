// node:os: what Porffor's compiler asks of it (so it can compile itself), with Node's signatures.
import * as host from '../host/native/process.mjs';

export const EOL = '\n';

export const platform = () => host.platform();

export const homedir = () => {
	const home = host.getenv('HOME');
	return home === undefined || home === '' ? '/' : home;
};

// TMPDIR (else TMP, TEMP) without a trailing slash, else /tmp
export const tmpdir = () => {
	let dir = host.getenv('TMPDIR');
	if (dir === undefined || dir === '') dir = host.getenv('TMP');
	if (dir === undefined || dir === '') dir = host.getenv('TEMP');
	if (dir === undefined || dir === '') return '/tmp';
	if (dir.length > 1 && dir[dir.length - 1] === '/') return dir.slice(0, -1);
	return dir;
};

export default { EOL, platform, homedir, tmpdir };
