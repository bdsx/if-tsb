import ts = require('typescript');
import fs = require('fs');
import path = require('path');
import { fsp } from './fsp';
import { memcache } from './memmgr';
import { getMtime } from './mtimecache';

export class SourceFileData {
    public sourceFile:ts.SourceFile;
    public readonly size;
    private readonly mtime:number;

    constructor(
        public readonly filename:string,
        public readonly languageVersion:ts.ScriptTarget,
    ) {
        this.mtime = getMtime.sync(this.filename);

        const contents = fs.readFileSync(this.filename, 'utf8');
        if (fsp.verbose) console.log(`createSourceFile ${this.filename}`);
        const sourceFile = ts.createSourceFile(this.filename, contents, this.languageVersion);
        this.sourceFile = sourceFile;
        this.size = contents.length * 2;
    }

    async isModified():Promise<boolean> {
        const mtime = await getMtime(this.filename);
        return mtime !== this.mtime;
    }
    
    isModifiedSync():boolean {
        const mtime = getMtime.sync(this.filename);
        return mtime !== this.mtime;
    }

    clear():void {
        this.sourceFile = null as any;
    }

    release():void {
        memcache.release(this);
    }
}

const all = new Map<ts.ScriptTarget, SourceFileCache>();
export class SourceFileCache {
    private readonly map = new memcache.Map<string, SourceFileData>();

    private constructor(
        private readonly languageVersion:ts.ScriptTarget
    ) {
    }

    take(filename:string):SourceFileData {
        const apath = path.join(filename);
        return this.map.takeOrCreate(apath, ()=>new SourceFileData(apath, this.languageVersion));
    }

    static getInstance(languageVersion:ts.ScriptTarget):SourceFileCache {
        let cache = all.get(languageVersion);
        if (cache == null) {
            all.set(languageVersion, cache = new SourceFileCache(languageVersion));
        }
        return cache;
    }
}

