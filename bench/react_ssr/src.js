// React server rendering: renderToString (React 19, its edge build) of a product listing
// page, rendered repeatedly. Bundled into ../react_ssr.js as one plain script (build.sh),
// so Node, QuickJS and Porffor all run the same code. Prints a checksum of the HTML (the
// same on every engine) and the time.
// QuickJS has no TextEncoder, which React's edge build constructs as it loads (renderToString
// never encodes): a stand-in there, so all three engines run the same render
import './text-encoder.js';
import React, { createContext, useContext } from 'react';
import { renderToString } from 'react-dom/server';

const h = React.createElement;
const Currency = createContext('EUR');

function Price({ cents }) {
  const currency = useContext(Currency);
  return h('span', { className: cents > 5000 ? 'price high' : 'price' }, (cents / 100).toFixed(2), ' ', currency);
}

function Badge({ stock }) {
  if (stock === 0) return h('span', { className: 'badge out' }, 'sold out');
  if (stock < 5) return h('span', { className: 'badge low' }, 'only ', stock, ' left');
  return null;
}

function Row({ item }) {
  return h('tr', { 'data-id': item.id, className: item.id % 2 ? 'odd' : 'even' },
    h('td', null, h('a', { href: '/p/' + item.id }, item.name)),
    h('td', null, h(Price, { cents: item.cents })),
    h('td', null, h(Badge, { stock: item.stock })),
    h('td', { style: { textAlign: 'right', color: item.stock ? 'inherit' : 'gray' } }, item.stock));
}

function Page({ items, title }) {
  return h(Currency.Provider, { value: 'EUR' },
    h('main', { id: 'catalog' },
      h('h1', null, title),
      h('p', null, 'Showing ', items.length, ' products & more <soon>'),
      h('table', null,
        h('thead', null, h('tr', null, ['Name', 'Price', 'Status', 'Stock'].map((c) => h('th', { key: c }, c)))),
        h('tbody', null, items.map((item) => h(Row, { key: item.id, item }))))));
}

const items = [];
for (let i = 0; i < 200; i++) items.push({ id: i, name: 'Product ' + i + (i % 7 === 0 ? ' "special"' : ''), cents: (i * 1237) % 12000, stock: i % 9 });

const hash = (s) => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
};

let html = '';
let checksum = 0;
const t = performance.now();
for (let r = 0; r < 200; r++) {
  html = renderToString(h(Page, { items, title: 'Catalog ' + (r % 3) }));
  checksum = (checksum + hash(html)) % 1000000007;
}
const ms = performance.now() - t;

console.log('bytes: ' + html.length);
console.log('checksum: ' + checksum);
console.log('render: ' + ms.toFixed(1) + ' ms');
