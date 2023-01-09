import path = require("path");
import type { Worker } from "worker_threads";
import { fsp } from "./fsp";

export abstract class SourceMap {
    abstract toDataURL(): Promise<string>;
    abstract append(apath: string, sourceMapText: string, offset: number): void;
    abstract save(): Promise<void>;

    static newInstance(output: string): SourceMap {
        try {
            const module = require("worker_threads");
            return new SourceMapWorker(output, module);
        } catch (err) {
            return new SourceMapDirect(output);
        }
    }
}

class SourceMapWorker extends SourceMap {
    private readonly worker: Worker;
    constructor(output: string, workerModule: typeof import("worker_threads")) {
        super();
        try {
            const { Worker } = workerModule;
            this.worker = new Worker(
                path.join(__dirname, "../worker.bundle.js"),
                { workerData: { output, verbose: fsp.verbose } }
            );
            this.worker.unref();
        } catch (err) {}
    }

    append(apath: string, sourceMapText: string, offset: number): void {
        this.worker.postMessage([apath, sourceMapText, offset]);
    }

    toDataURL(): Promise<string> {
        this.worker.postMessage("toDataURL");
        return new Promise((resolve) => {
            this.worker.once("message", (res) => {
                resolve(res);
                this.worker.unref();
            });
        });
    }

    save(): Promise<void> {
        this.worker.postMessage("writeFile");
        return new Promise((resolve) => {
            this.worker.once("message", () => {
                resolve();
                this.worker.unref();
            });
        });
    }
}
export class SourceMapDirect extends SourceMap {
    private readonly module: typeof import("source-map") = require("source-map");

    private readonly outdir: string;
    private readonly mapgen: import("source-map").SourceMapGenerator;

    constructor(private readonly output: string) {
        super();
        this.outdir = path.dirname(output);

        this.mapgen = new this.module.SourceMapGenerator({
            file: "./" + path.basename(output),
        });
    }

    append(apath: string, sourceMapText: string, offset: number): void {
        let rpath = path.relative(this.outdir, apath);
        if (path.sep === "\\") rpath = rpath.replace(/\\/g, "/");
        const consumer = new this.module.SourceMapConsumer(
            JSON.parse(sourceMapText)
        );
        consumer.eachMapping((entry) => {
            this.mapgen!.addMapping({
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

    toDataURL(): Promise<string> {
        return Promise.resolve(
            "data:application/json;base64," +
                Buffer.from(this.mapgen!.toString()).toString("base64")
        );
    }

    save(): Promise<void> {
        return fsp.writeFile(this.output + ".map", this.mapgen!.toString());
    }
}
