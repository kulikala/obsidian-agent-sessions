// One side of two processes hammering updateStore concurrently. Appends `count`
// entries to `folded`.
// argv: [bundlePath, storePath, tag, count]
const { updateStore } = require(process.argv[2]);
const storePath = process.argv[3];
const tag = process.argv[4];
const count = Number(process.argv[5]);

// The test checks that no update is lost, not the lock's time limit: one side can retake the
// lock many times while the other sleeps between retries, which on a slow CI runner outlasts the
// plugin's 2-second limit.
const lock = { timeoutMs: 20000, retryIntervalMs: 5 };

for (let i = 0; i < count; i++) {
	updateStore(
		storePath,
		(store) => {
			store.folded.push(`${tag}-${i}`);
		},
		lock
	);
}
