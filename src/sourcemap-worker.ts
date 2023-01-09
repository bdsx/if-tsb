import sourceMap = require("source-map");
import path = require("path");

import { parentPort, workerData } from "worker_threads";
import { fsp } from "./fsp";

if (parentPort === null) {
    console.error(`Invalid usage`);
    process.exit(-1);
}

const data: { output: string; verbose: boolean } = workerData;
const outdir = path.dirname(data.output);
fsp.verbose = data.verbose;

const mapgen = new sourceMap.SourceMapGenerator({
    file: path.basename(data.output),
});

function append(apath: string, sourceMapText: string, offset: number): void {
    let rpath = path.relative(outdir, apath);
    if (path.sep === "\\") rpath = rpath.replace(/\\/g, "/");
    const consumer = new sourceMap.SourceMapConsumer(JSON.parse(sourceMapText));
    consumer.eachMapping((entry) => {
        mapgen.addMapping({
            generated: {
                column: entry.generatedColumn,
                line: entry.generatedLine + offset,
            },
            original: {
                column: entry.originalColumn,
                line: entry.originalLine,
            },
            name: entry.name,
            source: rpath,
        });
    });
}

parentPort.on("message", (message: [string, string, number] | string) => {
    if (typeof message === "string") {
        switch (message) {
            case "writeFile":
                fsp.writeFileSync(data.output + ".map", mapgen!.toString());
                parentPort!.postMessage(null);
                parentPort!.close();
                break;
            case "toDataURL":
                parentPort!.postMessage(
                    "data:application/json;base64," +
                        Buffer.from(mapgen!.toString()).toString("base64")
                );
                parentPort!.close();
                break;
        }
    } else {
        append(...message);
    }
});
