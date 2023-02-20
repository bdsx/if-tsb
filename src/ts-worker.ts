import { parentPort, workerData } from "worker_threads";
import { tshelper } from "./tshelper";
if (parentPort === null) {
    console.error(`Invalid usage`);
    process.exit(-1);
}

const tsconfig = workerData.tsconfig;
const basedir = workerData.basedir;
if (workerData.watch) {
    tshelper.tswatch(tsconfig, basedir, {
        onStart() {
            parentPort!.postMessage("start");
        },
        onFinish() {
            parentPort!.postMessage("finish");
        },
    });
} else {
    tshelper.tsbuild(tsconfig, basedir);
    parentPort.postMessage(null);
    parentPort.close();
}
