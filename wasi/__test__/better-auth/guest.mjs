// The better-auth fixture: better-auth's handler behind a fetch handler, its data in memory
// (the memory adapter), email and password sign-up and sign-in.

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

const db = { user: [], session: [], account: [], verification: [] };

const auth = betterAuth({
	baseURL: 'http://localhost',
	secret: 'a-test-secret-that-is-long-enough-for-better-auth',
	database: memoryAdapter(db),
	emailAndPassword: { enabled: true }
});

export default {
	fetch(request) {
		return auth.handler(request);
	}
};
