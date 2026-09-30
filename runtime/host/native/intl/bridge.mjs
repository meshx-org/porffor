// Native Intl's one call into ICU4X (runtime/intl, the crate's C ABI: src/capi.rs, linked in
// by compiler/deps.js when a program's C calls porf_intl_call). A request and its reply are
// JSON, so no C struct has to match a Rust one: JSON.stringify, one C call, JSON.parse.
// The modules beside this one give the shapes the WASI glue gives meshx:intl (functions,
// resource classes, errors), so runtime/intl*.mjs cannot tell the two apart.
import { takeCString } from '../../c.mjs';

Porffor.c`
unsigned char *porf_intl_call(const unsigned char *request, size_t len, size_t *reply_len);
`;

// the reply's JSON for a request's (a string: UTF-8 to the C)
const send = (request) => {
	const requestType = Porffor.type(request);
	let len = 0;
	let buf = 0;
	Porffor.c`
{
size_t request_len;
char *request_bytes = __porffor_bytes(MEM, ${request}, (i32)${requestType}.val, &request_len);
size_t reply_len = 0;
unsigned char *reply_bytes = porf_intl_call((const unsigned char *)request_bytes, request_len, &reply_len);
free(request_bytes);
${len} = (f64)reply_len;
${buf} = (f64)(u64)reply_bytes;
}
`;
	if (buf === 0) throw new RangeError('Intl: out of memory');

	return takeCString(len, buf);
};

// the error a result's err throws, as the WASI glue (and jco) throw it: its value on `payload`
const componentError = (payload) => {
	const error = new Error(
		payload !== null && typeof payload === 'object'
			? `${payload.tag} (see error.payload)`
			: String(payload)
	);
	error.payload = payload;

	return error;
};

/**
 * Calls ICU4X: `call` is the WIT function (`locale.maximize`, or a resource's method,
 * `number-format.format`), `self` a resource's handle, `args` its arguments as the glue
 * spells them. Returns the ok value (undefined for none, as the glue has it); an err throws.
 */
export const intlCall = (call, self, args) => {
	const reply = JSON.parse(send(JSON.stringify({ call, self, args })));

	if (reply.err !== undefined) throw componentError(reply.err);

	return reply.ok === null ? undefined : reply.ok;
};
