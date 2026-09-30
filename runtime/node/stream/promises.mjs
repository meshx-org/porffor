// node:stream/promises: pipeline and finished (node:stream) as promises. They live in
// stream.mjs, as its `promises`: a module cycle between the two would leave these bindings
// unset when Porffor links them.
import { promises } from '../stream.mjs';

export const { pipeline, finished } = promises;

export default promises;
