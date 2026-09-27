// JSON at API-payload sizes: a deterministic ~1 MB array of records (nested objects,
// arrays, numbers, booleans, nulls, escapes and non-ASCII text), stringified and parsed
// back. Prints a checksum (the same on every engine) and the time of each half.

let seed = 12345;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'Ärger', 'naïve', 'Ωmega', 'quote"d', 'back\\slash', 'tab\there', '日本'];
const word = () => words[Math.floor(rand() * words.length)];

const records = [];
for (let i = 0; i < 2500; i++) {
  records.push({
    id: i,
    uuid: 'r-' + i.toString(16) + '-' + Math.floor(rand() * 1e9).toString(36),
    name: word() + ' ' + word(),
    active: rand() > 0.3,
    score: Math.round(rand() * 100000) / 100,
    tags: [word(), word(), word()],
    owner: { id: Math.floor(rand() * 1000), email: 'user' + i + '@example.com', manager: rand() > 0.8 ? null : { id: i % 97 } },
    lines: [
      { sku: 'A' + (i % 50), qty: 1 + (i % 7), price: 9.99 },
      { sku: 'B' + (i % 30), qty: 2, price: 120.5, note: rand() > 0.5 ? word() : null }
    ],
    meta: { created: 1700000000000 + i * 60000, version: i % 5, flags: [true, false, i % 2 === 0] }
  });
}

let checksum = 0;
const mix = (n) => { checksum = (checksum * 31 + n) % 1000000007; };

let t = performance.now();
let text = '';
for (let r = 0; r < 10; r++) {
  text = JSON.stringify(records);
  mix(text.length);
}
const stringifyMs = performance.now() - t;

t = performance.now();
for (let r = 0; r < 10; r++) {
  const back = JSON.parse(text);
  mix(back.length);
  mix(back[1234].lines[1].qty + back[2499].owner.id);
  mix(back[42].name.length + back[777].tags[2].length);
}
const parseMs = performance.now() - t;

console.log('bytes: ' + text.length);
console.log('checksum: ' + checksum);
console.log('stringify: ' + stringifyMs.toFixed(1) + ' ms');
console.log('parse: ' + parseMs.toFixed(1) + ' ms');
