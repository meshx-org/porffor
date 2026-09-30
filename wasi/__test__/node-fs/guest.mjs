// The node:fs fixture: Node's synchronous file system calls in a preopened directory, what each
// saw returned as JSON for the test to check (and the files left behind).
import fs from 'node:fs';
import { basename, join } from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const code = (f) => {
	try {
		f();
		return 'none';
	} catch (error) {
		return error.code;
	}
};

export function run(root) {
	const out = {};
	out.input = fs.readFileSync(join(root, 'input.txt'), 'utf8');
	out.exists = [fs.existsSync(join(root, 'input.txt')), fs.existsSync(join(root, 'nope'))];

	out.made = fs.mkdirSync(join(root, 'a/b/c'), { recursive: true });
	fs.writeFileSync(join(root, 'a/b/c/x.txt'), 'héllo from wasi\n');
	fs.writeFileSync(join(root, 'a/y.txt'), 'y');
	out.size = fs.statSync(join(root, 'a/b/c/x.txt')).size;
	out.isDirectory = fs.statSync(join(root, 'a/b')).isDirectory();
	out.list = fs.readdirSync(join(root, 'a'));

	fs.renameSync(join(root, 'a/y.txt'), join(root, 'a/z.txt'));
	fs.cpSync(join(root, 'a'), join(root, 'copy'), { recursive: true });
	out.copied = fs.readFileSync(join(root, 'copy/b/c/x.txt'), 'utf8');

	out.missing = code(() => fs.readFileSync(join(root, 'missing.txt'), 'utf8'));
	out.rmDirectory = code(() => fs.rmSync(join(root, 'copy')));
	fs.rmSync(join(root, 'copy'), { recursive: true, force: true });
	out.removed = fs.existsSync(join(root, 'copy'));

	const temp = fs.mkdtempSync(join(root, 'tmp-'));
	out.temp = basename(temp).startsWith('tmp-') && fs.statSync(temp).isDirectory();
	fs.rmSync(temp, { recursive: true });

	out.platform = os.platform();
	out.spawn = code(() => execSync('true'));
	return JSON.stringify(out);
}
