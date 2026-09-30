// node:timers: the timers as Node has them (runtime/node-timers.mjs, which the globals are too), and
// timers/promises as its promises.
import {
	Immediate,
	Timeout,
	clearImmediate,
	clearTimeout,
	setImmediate,
	setInterval,
	setTimeout
} from '../node-timers.mjs';
import * as promises from './timers/promises.mjs';

export {
	Immediate,
	Timeout,
	clearImmediate,
	clearTimeout,
	clearTimeout as clearInterval,
	promises,
	setImmediate,
	setInterval,
	setTimeout
};

export default {
	setTimeout,
	setInterval,
	setImmediate,
	clearTimeout,
	clearInterval: clearTimeout,
	clearImmediate,
	Timeout,
	Immediate,
	promises
};
