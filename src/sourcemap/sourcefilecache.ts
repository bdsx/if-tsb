import ts = require("typescript");
import fs = require("fs");
import path = require("path");
import { fsp } from "../util/fsp";
import { memcache } from "../memmgr";
import { cachedStat } from "../util/cachedstat";

export class SourceFileData {
    public sourceFile: ts.SourceFile;
    public readonly size: number;

    constructor(
        public readonly filename: string,
        public readonly languageVersion: ts.ScriptTarget,
        contents: string,
        private readonly mtime: number
    ) {
        if (fsp.verbose) console.log(`createSourceFile ${this.filename}`);
        const sourceFile = ts.createSourceFile(
            this.filename,
            contents,
            this.languageVersion
        );
        this.sourceFile = sourceFile;
        this.size = contents.length * 2;
    }

    static loadSync(
        filename: string,
        languageVersion: ts.ScriptTarget
    ): SourceFileData {
        const contents = fs.readFileSync(filename, "utf8");
        const mtime = cachedStat.mtimeSync(filename);
        return new SourceFileData(filename, languageVersion, contents, mtime);
    }
    static async load(
        filename: string,
        languageVersion: ts.ScriptTarget
    ): Promise<SourceFileData> {
        const [contents, mtime] = await Promise.all([
            fsp.readFile(filename),
            cachedStat.mtime(filename),
        ]);
        return new SourceFileData(filename, languageVersion, contents, mtime);
    }

    async isModified(): Promise<boolean> {
        const mtime = await cachedStat.mtime(this.filename);
        return mtime !== this.mtime;
    }

    isModifiedSync(): boolean {
        const mtime = cachedStat.mtimeSync(this.filename);
        return mtime !== this.mtime;
    }

    clear(): void {
        this.sourceFile = null as any;
    }

    release(): void {
        memcache.release(this);
    }
}

const all = new Map<ts.ScriptTarget, SourceFileCache>();
export class SourceFileCache {
    private readonly map = new memcache.Map<string, SourceFileData>();

    private constructor(private readonly languageVersion: ts.ScriptTarget) {}

    take(filename: string): SourceFileData {
        const apath = path.join(filename);
        return this.map.takeOrCreate(apath, () =>
            SourceFileData.loadSync(apath, this.languageVersion)
        );
    }

    static getInstance(languageVersion: ts.ScriptTarget): SourceFileCache {
        let cache = all.get(languageVersion);
        if (cache == null) {
            all.set(
                languageVersion,
                (cache = new SourceFileCache(languageVersion))
            );
        }
        return cache;
    }
}
