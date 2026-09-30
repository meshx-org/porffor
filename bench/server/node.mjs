// The server benchmark's app on node:http: the routes of bench/server/app.mjs.
import { createServer } from 'node:http';

const json = { message: 'Hello, World!', list: [1, 2, 3], nested: { ok: true } };
const chunk = Buffer.from('x'.repeat(1024));

createServer((request, response) => {
	if (request.url === '/') {
		response.setHeader('content-type', 'text/plain;charset=UTF-8');
		response.end('Hello World!');
	} else if (request.url === '/json') {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify(json));
	} else if (request.url === '/echo') {
		const parts = [];

		request.on('data', (part) => parts.push(part));
		request.on('end', () => {
			response.setHeader('content-type', 'text/plain;charset=UTF-8');
			response.end(Buffer.concat(parts));
		});
	} else if (request.url === '/stream') {
		for (let i = 0; i < 16; i++) response.write(chunk);
		response.end();
	} else {
		response.statusCode = 404;
		response.end('not found');
	}
}).listen(Number(process.env.PORT ?? 3000));
