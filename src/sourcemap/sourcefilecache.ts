import ts = require("typescript");
import fs = require("fs");
import path = require("path");
import { CacheMap } from "../memmgr";
import { cachedStat } from "../util/cachedstat";
import { fsp } from "../util/fsp";

const fileMap = new CacheMap<string, StringFileData>();
export class StringFileData {
    public readonly size: number;
    constructor(
        public readonly filename: string,
        public contents: string | null,
        private readonly mtime: number,
    ) {}

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

    static takeSync(apath: string): StringFileData {
        const file = fileMap.get(apath);
        if (file !== undefined && !file.isModifiedSync()) {
            return file;
        }
        const contents = fs.readFileSync(apath, "utf8");
        const mtime = cachedStat.mtimeSync(apath);
        const newFile = new StringFileData(apath, contents, mtime);
        fileMap.set(apath, newFile);
        return newFile;
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
}

const all = new Map<ts.ScriptTarget, SourceFileCache>();

export class SourceFileCache {
    private readonly map = new CacheMap<string, SourceFileData>();

    private constructor(private readonly languageVersion: ts.ScriptTarget) {}

    take(filename: string): SourceFileData {
        const apath = path.join(filename);
        const file = StringFileData.takeSync(apath);
        const data = this.map.get(apath);
        if (data !== undefined && data.file === file) {
            return data;
        }
        const newData = new SourceFileData(file, this.languageVersion);
        this.map.set(apath, newData);
        return newData;
    }

    delete(key: string) {
        this.map.delete(key);
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
