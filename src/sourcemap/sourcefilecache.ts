import ts = require("typescript");
import fs = require("fs");
import path = require("path");
import { fsp } from "../util/fsp";
import { memcache } from "../memmgr";
import { cachedStat } from "../util/cachedstat";
import { disposeSymbol } from "../util/disposable";

const fileMap = new memcache.Map<string, StringFileData>();
export class StringFileData implements Disposable {
    public readonly size: number;
    constructor(
        public readonly filename: string,
        public contents: string | null,
        private readonly mtime: number,
    ) {}

    [Symbol.dispose](): void {
        memcache.release(this);
    }

    clear() {
        this.contents = null;
    }

    async isModified(): Promise<boolean> {
        const mtime = await cachedStat.mtime(this.filename);
        return mtime !== this.mtime;
    }

    isModifiedSync(): boolean {
        const mtime = cachedStat.mtimeSync(this.filename);
        return mtime !== this.mtime;
    }

    static take(apath: string): StringFileData {
        return fileMap.createIfModified(
            apath,
            (file) => file.isModifiedSync(),
            () => {
                const contents = fs.readFileSync(apath, "utf8");
                const mtime = cachedStat.mtimeSync(apath);
                return new StringFileData(apath, contents, mtime);
            },
        );
    }
}

export class SourceFileData {
    public sourceFile: ts.SourceFile | null;
    public readonly size: number;
    constructor(
        public readonly file: StringFileData,
        public readonly languageVersion: ts.ScriptTarget,
    ) {
        if (fsp.verbose) console.log(`createSourceFile ${this.file.filename}`);
        this.size = file.size;
        this.sourceFile = ts.createSourceFile(
            this.file.filename,
            file.contents!,
            this.languageVersion,
        );
    }

    clear(): void {
        this.sourceFile = null;
    }

    [disposeSymbol]() {
        memcache.release(this);
    }
}

const all = new Map<ts.ScriptTarget, SourceFileCache>();

export class SourceFileCache {
    private readonly map = new memcache.Map<string, SourceFileData>();

    private constructor(private readonly languageVersion: ts.ScriptTarget) {}

    take(filename: string): SourceFileData {
        const apath = path.join(filename);
        using file = StringFileData.take(apath);
        return this.map.createIfModified(
            apath,
            (data) => data.file !== file,
            () => new SourceFileData(file, this.languageVersion),
        );
    }

    static getInstance(languageVersion: ts.ScriptTarget): SourceFileCache {
        let cache = all.get(languageVersion);
        if (cache == null) {
            all.set(
                languageVersion,
                (cache = new SourceFileCache(languageVersion)),
            );
        }
        return cache;
    }
}
