// TransformStream for a Porffor-compiled guest: a writable side whose chunks a
// transformer turns into the readable side's, with backpressure between them (a write
// waits while the readable side has no read waiting and no room in its queue). Injected into every guest.

import { ReadableStream } from './readable-stream.mjs';
import { deferred, error as errorReadable } from './stream-internals.mjs';
import { error as errorWritable } from './writable-internals.mjs';
import { WritableStream } from './writable-stream.mjs';

/** A pair of streams joined by a transformer: write in one side, read the other. */
export class TransformStream {
	/**
	 * @param {{ start?, transform?, flush? }} [transformer] transform(chunk, controller)
	 *   enqueues what the chunk becomes (the chunk itself when there is no transform);
	 *   flush(controller) runs when the writable side closes
	 * @param {{ highWaterMark?: number }} [writableStrategy] (1)
	 * @param {{ highWaterMark?: number }} [readableStrategy] (0)
	 */
	constructor(transformer, writableStrategy, readableStrategy) {
		const shape = transformer ?? {};
		let readableController;
		// a write waits here while the readable side wants nothing (backpressure); pull wakes it
		let demand = deferred();
		/** Backpressure: no read waiting on the readable side, and no room in its queue. */
		const full = () => this._readable._reads.length === 0 && readableController.desiredSize <= 0;

		const controller = {
			get desiredSize() {
				return readableController.desiredSize;
			},
			enqueue(chunk) {
				readableController.enqueue(chunk);
			},
			error(reason) {
				errorReadable(this._readable, reason);
				errorWritable(this._writable, reason);
			},
			terminate() {
				readableController.close();
				errorWritable(this._writable, new TypeError('TransformStream: terminated'));
			}
		};

		this._readable = new ReadableStream(
			{
				start(readable) {
					readableController = readable;
				},
				pull() {
					demand.resolve();
				},
				cancel(reason) {
					errorWritable(controller._writable, reason);
				}
			},
			{ highWaterMark: readableStrategy?.highWaterMark ?? 0 }
		);
		this._writable = new WritableStream(
			{
				start() {
					return shape.start?.(controller);
				},
				async write(chunk) {
					// checked before each wait, so a pull that came first is not missed
					while (full()) {
						demand = deferred();
						await demand.promise;
					}

					if (typeof shape.transform === 'function') await shape.transform(chunk, controller);
					else controller.enqueue(chunk);
				},
				async close() {
					await shape.flush?.(controller);
					readableController.close();
				},
				abort(reason) {
					errorReadable(controller._readable, reason);
				}
			},
			writableStrategy
		);
		controller._readable = this._readable;
		controller._writable = this._writable;
	}

	/** The side chunks come out of. */
	get readable() {
		return this._readable;
	}

	/** The side chunks go into. */
	get writable() {
		return this._writable;
	}
}
