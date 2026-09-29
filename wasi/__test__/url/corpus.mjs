// The URL test's corpus: inputs against bases, setter values, and URLSearchParams
// operations, run by the guest (in Porffor) and by the test (in Node) to compare.

export const bases = [
	undefined,
	'http://example.org/foo/bar?q=1#frag',
	'https://user:pw@h.example:8080/a/b/c',
	'file:///C:/dir/file.txt',
	'file://host/share/x',
	'sc://host/path/x',
	'about:blank'
];
export const inputs = [
	'http://example.com',
	'HTTP://EXAMPLE.COM/A/b',
	'https://example.com:443/',
	'http://example.com:80/x',
	'http://example.com:8080',
	'ftp://h:21/f',
	'ws://h:80',
	'wss://h:443/w',
	'http://example.com:65535/',
	'http://example.com:65536/',
	'http://example.com:/p',
	'http://h:0x50/',
	'http://user:pass@host/',
	'http://user@host',
	'http://:pass@host',
	'http://u:p:q@host',
	'http://a@b@c/',
	'http://@host/',
	'http://@/',
	'http://us er:p ss@host',
	'http://127.0.0.1/',
	'http://127.1/',
	'http://0x7f.1/',
	'http://0300.0250.0.1/',
	'http://4294967295/',
	'http://4294967296/',
	'http://1.2.3.4.5/',
	'http://1.2.3.256/',
	'http://999999999999/',
	'http://0x/',
	'http://09/',
	'http://1.2.3.09/',
	'http://foo.0x4/',
	'http://[::1]/',
	'http://[1:0::]/',
	'http://[0:0:0:0:0:0:0:0]/',
	'http://[1:2:3:4:5:6:7:8]/',
	'http://[::ffff:127.0.0.1]/',
	'http://[1::2::3]/',
	'http://[::1.2.3]/',
	'http://[1:2:3:4:5:6:7:8:9]/',
	'http://[::127.0.0.01]/',
	'http://[0:0:1:0:0:0:0:0]/',
	'http://[1:0:0:2:0:0:0:3]/',
	'http://[FFFF::]/',
	'http://[::1/',
	'http://münchen.de/',
	'http://EXAMPLE.com/',
	'http://ex%41mple.com/',
	'http://a.b.c./',
	'http://ex ample.com/',
	'http://ex<ample.com/',
	'http://%zz/',
	'http://ex\u3002ample.com/',
	'http://xn--nxasmq6b/',
	'http://日本語.jp/path',
	'http://h/a/./b/../c',
	'http://h/a/%2e/b/%2E%2e/c',
	'http://h/..',
	'http://h/../../x',
	'http://h/a/b/..',
	'http://h/a/b/.',
	'http://h\\a\\b',
	'http://h/a b/c"d<e>f`g{h}i^j',
	'http://h/ü/😀',
	'http://h/%zz%2f',
	'http://h/?q=a b&c="d"&e=\'f\'&g=<h>#frag ment',
	'http://h/?',
	'http://h/#',
	'http://h?x',
	'http://h#y',
	'http://h/?%zz',
	'http://h/#a#b',
	'http://h/?ü=😀#ü',
	'  http://h/trim  ',
	'\u0000http://h/x\u001f',
	'ht\ttp://h/\nx\ry',
	'http:example.com/',
	'http:/example.com/',
	'http:\\\\h\\p',
	'http:///h/',
	'https:',
	'http://',
	'http:',
	'file:///etc/passwd',
	'file://localhost/etc',
	'file://host/share',
	'file:c:/x',
	'file:///c|/x',
	'file:/C:/a/../..',
	'file:C:',
	'file://C:/',
	'file:///',
	'file:',
	'file:..',
	'file://h:8080/',
	'file://u@h/',
	'file:\\\\server\\share\\x',
	'C|/foo',
	'c:/x/y',
	'mailto:user@example.com',
	'mailto:a b?subject=hi there#x',
	'data:text/plain,hello%20world',
	'javascript:alert(1)',
	'blob:https://example.com/uuid',
	'blob:ftp://x/y',
	'urn:isbn:0451450523',
	'sc:\\../',
	'sc://ñ.test/',
	'sc://h:99/p?q#f',
	'sc://@/',
	'sc://[::1]/',
	'sc://a b/',
	'sc://%/',
	'sc:/p',
	'sc:p',
	'git+ssh://git@github.com/a/b',
	'non-spec:/.//p',
	'non-spec:/..//p',
	'x://h/ x ?y z#w q',
	'/abs/path',
	'rel/path',
	'../up',
	'./here',
	'..',
	'.',
	'',
	'?only=query',
	'#only-frag',
	'//other.host/p',
	'///triple',
	'\\\\back',
	'g;x=1/../y',
	'g?y/./x',
	'//[::1]:81/',
	'//h:99999',
	'a:',
	':no-scheme',
	'1http://x',
	'http://%41.com'
];

export const setterStarts = [
	'http://u:p@example.com:8080/a/b?x=1#f',
	'https://example.com/',
	'file:///C:/dir/f',
	'file://host/share',
	'mailto:someone@x',
	'sc://h/p?q',
	'sc:opaque'
];
export const setters = [
	'href',
	'protocol',
	'username',
	'password',
	'host',
	'hostname',
	'port',
	'pathname',
	'search',
	'hash'
];
export const setterValues = [
	'',
	'https',
	'ftp:',
	'file',
	'sc',
	'new.host',
	'NEW.HOST:81',
	'h:0x',
	'[::1]:99',
	'ü ser',
	'p@ss:w',
	'8443',
	'65536',
	'/x/../y z',
	'a?b#c',
	'?q=ä&r',
	'#frag ü',
	'http://other/'
];

const KEYS = [
	'href',
	'origin',
	'protocol',
	'username',
	'password',
	'host',
	'hostname',
	'port',
	'pathname',
	'search',
	'hash'
];

/** Every result, as lines, with the given URL and URLSearchParams classes. */
export function runCorpus(URLClass, Params) {
	const lines = [];

	for (const base of bases)
		for (const input of inputs) {
			let line;

			try {
				const url = base === undefined ? new URLClass(input) : new URLClass(input, base);

				line = KEYS.map((key) => url[key]).join(' | ');
			} catch {
				line = 'FAIL';
			}
			lines.push(line);
		}

	for (const start of setterStarts)
		for (const key of setters)
			for (const value of setterValues) {
				let line;

				try {
					const url = new URLClass(start);

					url[key] = value;
					line = url.href + ' | ' + url.searchParams.toString();
				} catch {
					line = 'THROW';
				}
				lines.push(line);
			}
	const params = new Params('?a=1&b=2&a=3&x=%C3%BC&y=a+b&z=%zz');

	params.append('n', 'ö &=+');
	params.set('a', 'new');
	params.delete('b');
	params.sort();
	lines.push(params.toString() + ' | ' + params.get('a') + ' | ' + String(params.size));
	const linked = new URLClass('http://h/?a=1');

	linked.searchParams.append('b', 'x y');
	linked.search = '?c=3';
	linked.searchParams.set('d', '4');
	lines.push(linked.href);

	return lines;
}
