// 2 プロセスから同時に updateStore を叩く側。folded に count 件足す。
// argv: [bundlePath, storePath, tag, count]
const { updateStore } = require(process.argv[2]);
const storePath = process.argv[3];
const tag = process.argv[4];
const count = Number(process.argv[5]);

for (let i = 0; i < count; i++) {
	updateStore(storePath, (store) => {
		store.folded.push(`${tag}-${i}`);
	});
}
