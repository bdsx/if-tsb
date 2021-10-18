import { parentPort, workerData } from 'worker_threads';
import { tsbuild, tswatch } from "./util";
if (parentPort === null) {
	console.error(`Invalid usage`);
	process.exit(-1);
}

const tsconfig = workerData.tsconfig;
const basedir = workerData.basedir;
if (workerData.watch) {
	tswatch(tsconfig, basedir, {
		onStart() { parentPort!.postMessage('start'); },
		onFinish() { parentPort!.postMessage('finish'); },
	});
} else {
	tsbuild(tsconfig, basedir);
	parentPort.postMessage(null);
	parentPort.close();
}
