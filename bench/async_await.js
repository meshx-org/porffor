// async/await and promises: a long chain of sequential awaits, Promise.all fan-out over
// async calls, async generators consumed with for await, and plain microtask churn
// (.then chains). Everything settles in microtasks, no timers. Prints a checksum (the
// same on every engine) and the time of each part, once all of them have finished.

let checksum = 0;
const mix = (n) => { checksum = (checksum * 31 + n) % 1000000007; };
const times = [];

const step = async (x) => x + 1;

async function sequential(n) {
  let x = 0;
  for (let i = 0; i < n; i++) x = await step(x);
  return x;
}

async function fanOut(rounds, width) {
  let total = 0;
  for (let r = 0; r < rounds; r++) {
    const batch = [];
    for (let i = 0; i < width; i++) batch.push(step(i));
    const results = await Promise.all(batch);
    for (const v of results) total += v;
  }
  return total;
}

async function* numbers(n) {
  for (let i = 0; i < n; i++) {
    await null;
    yield i;
  }
}

async function generators(n) {
  let total = 0;
  for await (const v of numbers(n)) total += v % 7;
  return total;
}

function thenChains(n) {
  let p = Promise.resolve(0);
  for (let i = 0; i < n; i++) p = p.then((v) => v + (i & 3));
  return p;
}

async function main() {
  let t = performance.now();
  mix(await sequential(200000));
  times.push('sequential awaits: ' + (performance.now() - t).toFixed(1) + ' ms');

  t = performance.now();
  mix(await fanOut(2000, 50));
  times.push('Promise.all fan-out: ' + (performance.now() - t).toFixed(1) + ' ms');

  t = performance.now();
  mix(await generators(100000));
  times.push('async generator: ' + (performance.now() - t).toFixed(1) + ' ms');

  t = performance.now();
  mix(await thenChains(200000));
  times.push('then chains: ' + (performance.now() - t).toFixed(1) + ' ms');

  console.log('checksum: ' + checksum);
  for (const line of times) console.log(line);
}

main().then(() => {}, (e) => console.log('failed: ' + e));
