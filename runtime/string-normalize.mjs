// String.prototype.normalize, which Porffor lacks, installed by the build into guests whose
// code calls `.normalize(` (scripts/bundle.mjs). Libraries call it on input they hash or
// compare: better-auth normalizes a password to NFKC before scrypt.
//
// Without the Unicode data it normalizes only ASCII, where every form (NFC, NFD, NFKC, NFKD)
// is the string unchanged. Anything else throws rather than returning the string as is: a
// guess would pass most text through and quietly differ from every other engine on the rest
// (a password hashed here would not match its hash from Node).
//
// TODO: String.prototype.normalize as a Porffor builtin in external/porffor, from the UCD
// (decomposition mappings, canonical combining classes, composition exclusions, Hangul by
// algorithm), checked against test262's built-ins/String/prototype/normalize; then delete
// this file and its entry in scripts/bundle.mjs.

const FORMS = ['NFC', 'NFD', 'NFKC', 'NFKD'];
// the last code unit every form leaves as it is without the Unicode data
const LAST_ASCII = 0x7f;
const HEX = 16;
// U+XXXX: a code point in at least four hex digits
const CODE_POINT_DIGITS = 4;

/**
 * The string in Unicode normalization form `form` (NFC by default); ASCII only for now.
 * @this {unknown}
 * @param {string} [form]
 * @returns {string}
 */
function normalize(form = undefined) {
	if (this === null || this === undefined)
		throw new TypeError('String.prototype.normalize called on null or undefined');

	const string = String(this);
	const name = form === undefined ? 'NFC' : String(form);

	if (!FORMS.includes(name))
		throw new RangeError(`The normalization form should be one of NFC, NFD, NFKC, NFKD.`);

	for (let i = 0; i < string.length; i++) {
		const unit = string.charCodeAt(i);

		if (unit > LAST_ASCII) {
			const hex = unit.toString(HEX).toUpperCase().padStart(CODE_POINT_DIGITS, '0');

			throw new Error(
				`String.prototype.normalize: only ASCII is supported here yet (${name} of a string with U+${hex})`
			);
		}
	}

	return string;
}

if (typeof ''.normalize !== 'function')
	Object.defineProperty(String.prototype, 'normalize', {
		value: normalize,
		writable: true,
		enumerable: false,
		configurable: true
	});
