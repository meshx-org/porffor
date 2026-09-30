// The server benchmark: bench/server/app.mjs served by Porffor (porf native), by Bun (when
// installed) and, as bench/server/node.mjs, by Node's http, each loaded by wrk in turn: hello world
// with and without keep-alive, a JSON response, a 1 KB POST echoed back, a streamed response.
// A binary given as UWS_BIN (the old uWebSockets build of a hello-world server) runs the hello
// world scenarios too. Writes a Markdown table of requests per second and mean latency to stdout,
// and to the path given.
//   node bench/server/run.mjs [out.md]
// DURATION (seconds, default 10), CONNECTIONS (default 50) and THREADS (default 2) tune wrk.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = import.meta.dirname;
const root = path.join(here, '../..');
const duration = process.env.DURATION ?? '10';
const connections = process.env.CONNECTIONS ?? '50';
const threads = process.env.THREADS ?? '2';
const port = 3900;

const has = (command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

if (!has('wrk') && spawnSync('wrk', [], { stdio: 'ignore' }).error)
	throw new Error('the server benchmark needs wrk (brew install wrk, apt install wrk)');

// (a connection each goes last, and waits before each server: its closed connections sit in
// TIME_WAIT, and a run right after one runs out of ports to connect from)
const scenarios = [
	{ name: 'hello, keep-alive', path: '/' },
	{ name: 'JSON', path: '/json' },
	{ name: 'POST 1 KB echo', path: '/echo', args: ['-s', path.join(here, 'post.lua')] },
	{ name: 'streamed 16 x 1 KB', path: '/stream' },
	{ name: 'hello, a connection each', path: '/', args: ['-H', 'Connection: close'], cooldown: 30 }
];

// the Porffor build of the app
const porfBin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'porffor-server-bench-')), 'app');

execFileSync(process.execPath, [path.join(root, 'cli/index.js'), 'native', path.join(here, 'app.mjs'), '-o', porfBin], {
	stdio: ['ignore', 'ignore', 'inherit']
});

const servers = [
	{ name: 'Porffor', command: [porfBin] },
	{ name: 'Node http', command: [process.execPath, path.join(here, 'node.mjs')] },
	...(has('bun') ? [{ name: 'Bun', command: ['bun', path.join(here, 'app.mjs')] }] : []),
	...(process.env.UWS_BIN ? [{ name: 'old uWS', command: [process.env.UWS_BIN], only: '/', fixedPort: 3001 }] : [])
];

/** Waits until the server answers, up to 10 s. */
async function ready(url) {
	for (let i = 0; i < 100; i++) {
		try {
			await fetch(url);

			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error(`${url} never answered`);
}

/** One wrk run: requests per second and mean latency. */
function load(url, args = []) {
	const out = execFileSync('wrk', ['-t', threads, '-c', connections, '-d', `${duration}s`, ...args, url], {
		encoding: 'utf8'
	});
	const rps = Number(/Requests\/sec:\s+([\d.]+)/.exec(out)?.[1] ?? NaN);
	const latency = /Latency\s+([\d.]+\w+)/.exec(out)?.[1] ?? '?';
	// (a closed connection is a read error to wrk: only these are failures)
	const socket = /Socket errors: connect (\d+), read \d+, write (\d+), timeout (\d+)/.exec(out);
	const non2xx = /Non-2xx or 3xx responses: (\d+)/.exec(out)?.[1];
	const errors = [
		socket && socket.slice(1).some((n) => n !== '0') ? socket[0] : '',
		non2xx ? `${non2xx} non-2xx` : ''
	]
		.filter(Boolean)
		.join(', ');

	return { rps, latency, errors };
}

const results = {};

for (const scenario of scenarios)
	for (const server of servers) {
		if (server.only !== undefined && scenario.path !== server.only) continue;
		const listen = server.fixedPort ?? port;

		if (scenario.cooldown) await new Promise((resolve) => setTimeout(resolve, scenario.cooldown * 1000));
		const child = spawn(server.command[0], server.command.slice(1), {
			env: { ...process.env, PORT: String(listen) },
			stdio: 'ignore'
		});

		try {
			await ready(`http://127.0.0.1:${listen}/`);
			const result = load(`http://127.0.0.1:${listen}${scenario.path}`, scenario.args);

			(results[scenario.name] ??= {})[server.name] = result;
			console.error(
				`${server.name}, ${scenario.name}: ${result.rps.toFixed(0)} req/s, ${result.latency} ${result.errors}`
			);
		} finally {
			child.kill();
			await new Promise((resolve) => child.on('exit', resolve));
		}
	}

const names = servers.map((server) => server.name);
const lines = [
	`Server benchmark: wrk -t${threads} -c${connections} -d${duration}s, ${os.cpus()[0].model}, ${os.platform()} ${os.arch()}. Requests per second (mean latency); * had errors.`,
	'',
	`| scenario | ${names.join(' | ')} |`,
	`| --- | ${names.map(() => '---:').join(' | ')} |`,
	...scenarios.map(
		(scenario) =>
			`| ${scenario.name} | ${names
				.map((name) => {
					const result = results[scenario.name]?.[name];

					return result === undefined ? '' : `${Math.round(result.rps).toLocaleString('en')} (${result.latency})${result.errors ? ' *' : ''}`;
				})
				.join(' | ')} |`
	),
	'',
	`Binary size of the Porffor build: ${(fs.statSync(porfBin).size / 1e6).toFixed(2)} MB.`
];
const table = lines.join('\n') + '\n';

process.stdout.write(table);

if (process.argv[2]) fs.writeFileSync(process.argv[2], table);
