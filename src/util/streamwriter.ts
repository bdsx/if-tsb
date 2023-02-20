import fs = require("fs");
import { resolved } from "./util";

export class WriterStream {
    private readonly stream: fs.WriteStream;
    private err: Error | null = null;

    constructor(output: string) {
        this.stream = fs.createWriteStream(output, { encoding: "utf-8" });
        this.stream.on("error", (err: Error) => {
            this.err = err;
        });
    }
    write(data: string | Buffer): Promise<void> {
        if (this.err !== null) throw this.err;
        if (this.stream.write(data)) return resolved;
        return new Promise((resolve) => this.stream.once("drain", resolve));
    }
    end(): Promise<void> {
        if (this.err !== null) throw this.err;
        return new Promise((resolve) => this.stream.end(resolve));
    }
}
