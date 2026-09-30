// The core of a fetch-handler server, whichever platform serves it: the program's default export
// `{ fetch(request, env, ctx) }` (Cloudflare's module form, as Bun and Deno take it; a Hono app is
// one) answers each Request with a Response. The platform's porffor:http-server moves the bytes:
// natively a TCP server over libuv with llhttp parsing (runtime/host/native/http-server.mjs), on
// WASI the wasi:http handler export (runtime/host/wasi/http-server.mjs). Both hand every request
// to respond() here, so a handler behaves the same on either.
//
// env is the process environment as an object; ctx has waitUntil (the process, or the export's
// task, already runs until what the handler started is done) and passThroughOnException (a
// no-op). A handler that throws, or answers with something that is not a Response, answers 500.
//
// Natively, a program whose entry module exports such a default is served (the linker adds the
// call: compiler/modules.js); a WASI build makes it the handler export (wasi/scripts/bundle.mjs).

import { environment } from 'porffor:environment';
import { Response } from './response.mjs';

/** An outcome nobody needs to see. */
const ignore = () => undefined;

/** The context a fetch handler gets. */
const handlerContext = {
	waitUntil: ignore,
	passThroughOnException: ignore
};

/**
 * Throws unless app can be served: an object with a fetch method.
 * @param {unknown} app
 */
export function checkApp(app) {
	if (app === null || app === undefined || typeof app.fetch !== 'function')
		throw new TypeError('a server must export default { fetch(request, env, ctx) }');
}

/** A handler that failed: logged, and answered with a 500. */
function failed(error) {
	console.error('fetch handler failed: ' + (error?.stack ?? error?.message ?? error));

	return new Response('Internal Server Error', { status: 500 });
}

/** What a handler answered with, when it must be a Response. */
function checked(answer) {
	return answer instanceof Response
		? answer
		: failed(new TypeError('the fetch handler did not return a Response'));
}

/**
 * The app's Response to a request: the Response itself when the handler answered with one at once
 * (a server writes it without waiting a turn), else a promise of it. It never rejects: a handler
 * that throws, or that answers with something that is not a Response, is logged and answered with
 * a 500.
 * @param {{ fetch(request: Request, env: object, ctx: object): Response | Promise<Response> }} app
 * @param {Request} request
 * @returns {Response | Promise<Response>}
 */
export function respond(app, request) {
	let answer;

	try {
		answer = app.fetch(request, environment(), handlerContext);
	} catch (error) {
		return failed(error);
	}

	if (answer instanceof Response) return answer;

	// (then, not await: no coroutine for the common promise)
	return Promise.resolve(answer).then(checked, failed);
}
