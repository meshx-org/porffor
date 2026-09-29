// Dispatches events through EventTarget and records what every listener saw; the test
// compares the record with Node's own EventTarget running the same code.

export function run() {
	const log = [];
	const target = new EventTarget();
	// the phase and current target are checked on their own (below): Node reports them
	// wrongly for every listener after the first
	const seen = (name) => (event) => log.push([name, event.type, event.target === target]);
	const first = seen('first');

	target.addEventListener('ping', first);
	// added once: the same callback and capture again is ignored
	target.addEventListener('ping', first);
	// a different capture flag is a different listener
	target.addEventListener('ping', first, true);
	target.addEventListener('ping', seen('once'), { once: true });
	target.addEventListener('ping', {
		handleEvent(event) {
			log.push(['object', event.type, this !== target]);
		}
	});
	log.push(['result', target.dispatchEvent(new Event('ping'))]);

	// during a dispatch, at every listener: the target, at target
	const phases = [];
	const phase = (event) =>
		phases.push(event.eventPhase === Event.AT_TARGET && event.currentTarget === target);

	target.addEventListener('phase', phase);
	target.addEventListener('phase', (event) => phase(event));
	target.dispatchEvent(new Event('phase'));
	log.push(['spec-phase', ...phases]);
	log.push(['again', target.dispatchEvent(new Event('ping'))]);

	// cancel: only a cancelable event, and not from a passive listener
	const canceler = (event) => event.preventDefault();

	target.addEventListener('cancel', canceler);
	log.push(['not cancelable', target.dispatchEvent(new Event('cancel'))]);
	log.push(['cancelable', target.dispatchEvent(new Event('cancel', { cancelable: true }))]);
	target.removeEventListener('cancel', canceler);
	target.addEventListener('cancel', canceler, { passive: true });
	log.push(['passive', target.dispatchEvent(new Event('cancel', { cancelable: true }))]);

	// stopImmediatePropagation stops the later listeners
	target.addEventListener('stop', (event) => {
		log.push(['stopper']);
		event.stopImmediatePropagation();
	});
	target.addEventListener('stop', seen('after stop'));
	target.dispatchEvent(new Event('stop'));

	// a listener removed during a dispatch does not run in it
	const late = seen('removed');

	target.addEventListener('remove', () => target.removeEventListener('remove', late));
	target.addEventListener('remove', late);
	target.dispatchEvent(new Event('remove'));

	// the signal option removes the listener
	const controller = new AbortController();

	target.addEventListener('signal', seen('signal'), { signal: controller.signal });
	target.dispatchEvent(new Event('signal'));
	controller.abort();
	target.dispatchEvent(new Event('signal'));

	// the event after a dispatch, and a second dispatch of it while it is being dispatched
	const event = new CustomEvent('custom', { detail: { n: 1 }, bubbles: true });

	target.addEventListener('custom', (inner) => {
		log.push(['detail', inner.detail.n, inner.bubbles, inner.composedPath().length]);

		try {
			target.dispatchEvent(inner);
		} catch (error) {
			log.push(['nested', error.name]);
		}
	});
	target.dispatchEvent(event);
	log.push([
		'after',
		event.eventPhase,
		event.currentTarget,
		event.target === target,
		event.composedPath().length
	]);

	// AbortSignal is an EventTarget; onabort runs after the listeners
	const signalController = new AbortController();
	const signal = signalController.signal;

	signal.addEventListener('abort', (abort) =>
		log.push(['abort listener', abort.type, abort.target === signal])
	);
	signal.onabort = (abort) => log.push(['onabort', abort.type]);
	signalController.abort();
	log.push([
		'kinds',
		signal instanceof EventTarget,
		event instanceof Event,
		{} instanceof EventTarget,
		Event.AT_TARGET,
		new Event('x').isTrusted
	]);

	try {
		target.dispatchEvent({ type: 'fake' });
	} catch (error) {
		log.push(['not an event', error.name]);
	}

	return JSON.stringify(log);
}
