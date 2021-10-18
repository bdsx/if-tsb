import ts = require('typescript');
import { fsp } from './fsp';
import fs = require('fs');
import { CacheMap } from './memmgr';

export class SourceFileData {
    private checkTime:number = 0;
    private mtime:number = 0;
    private sourceFile:ts.SourceFile|null = null;
    public size = 0;

    constructor(
        public readonly filename:string,
        public readonly languageVersion:ts.ScriptTarget,
    ) {
    }

    getSync():ts.SourceFile {
        const now = Date.now();
        if (this.checkTime >= now) {
            return this.sourceFile!;
        }
        const stats = fs.statSync(this.filename);
        const mtime = +stats.mtime;
        this.checkTime = now + 500;
        if (this.mtime >= mtime) {
            return this.sourceFile!;
        }
        const contents = fs.readFileSync(this.filename, 'utf8');
        if (fsp.verbose) console.log(`createSourceFile ${this.filename}`);
        const file = ts.createSourceFile(this.filename, contents, this.languageVersion);
        this.sourceFile = file;
        this.mtime = mtime;
        this.size = contents.length * 2;
        return file;
    }

    async get():Promise<ts.SourceFile> {
        const now = Date.now();
        if (this.checkTime >= now) {
            return this.sourceFile!;
        }
        const stats = await fsp.stat(this.filename);
        const mtime = +stats.mtime;
        this.checkTime = now + 500;
        if (this.mtime >= mtime) {
            return this.sourceFile!;
        }
        const contents = await fsp.readFile(this.filename);
        if (fsp.verbose) console.log(`createSourceFile ${this.filename}`);
        const file = ts.createSourceFile(this.filename, contents, this.languageVersion);
        this.sourceFile = file;
        this.mtime = mtime;
        this.size = contents.length * 2;
        return file;
    }

    clear():void {
        this.sourceFile = null;
        this.checkTime = 0;
    }
}

const all = new Map<ts.ScriptTarget, SourceFileCache>();
export class SourceFileCache {
    private readonly map = new CacheMap<string, SourceFileData>();

    private constructor(
        private readonly languageVersion:ts.ScriptTarget
    ) {
    }

    get(filename:string):SourceFileData {
        return this.map.takeOrCreate(filename, ()=>new SourceFileData(filename, this.languageVersion));
    }

    release(file:SourceFileData):void {
        this.map.release(file.filename, file);
    }

    static getInstance(languageVersion:ts.ScriptTarget):SourceFileCache {
        let cache = all.get(languageVersion);
        if (cache == null) {
            all.set(languageVersion, cache = new SourceFileCache(languageVersion));
        }
        return cache;
    }
}

