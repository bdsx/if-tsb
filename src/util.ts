
import ts = require('typescript');
import os = require('os');
import fs = require('fs');
import path = require('path');

const cpuCount = os.cpus().length;
const concurrencyCount = Math.min(Math.max(cpuCount*2, 8), cpuCount);

export const defaultFormatHost: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getCanonicalFileName: fileName => fileName,
    getNewLine: () => ts.sys.newLine
  };

export function printNode(node:ts.Node, name:string, tab:string):void
{
    let line = node.getFullText();
    const lineidx = line.indexOf('\n');
    if (lineidx !== -1) line = line.substr(0, lineidx);

    console.log(`${tab}[${name}:${ts.SyntaxKind[node.kind]}] ${line}`);
    tab += '  ';
    const nodes:Record<string, ts.Node> = {};
    for (const key in node)
    {
        if (key === 'parent') continue;
        if (key === 'pos') continue;
        if (key === 'end') continue;
        if (key === 'flags') continue;
        if (key === 'modifierFlagsCache') continue;
        if (key === 'transformFlags') continue;
        if (key === 'kind') continue;
        if (key === 'originalKeywordKind') continue;
        if (key === 'flowNode') continue;
        const v = (node as any)[key];
        if (v instanceof Function) continue;
        if (v && v['kind']) nodes[key] = v;
        else console.log(`${tab}${key}=${v}`);
    }
    for (const key in nodes)
    {
        printNode((nodes as any)[key], key, tab);
    }
}


/**
 * const [a,b] = splitContent('a,b,b', 2, ',')
 * a = 'a'
 * b = 'b,b'
 * const [a,b] = 'a,b,b'.split(',', 2)
 * a = 'a'
 * b = 'b'
 */
export function splitContent(text:string, count:number, needle:string):string[]
{
    if (count === 0) return [];

    let from = 0;
    const out = new Array(count);
    const last_i = count-1;
    let i = 0;
    for (;;)
    {
        if (i === last_i)
        {
            out[i] = text.substr(from);
            break;
        }
        const next = text.indexOf(needle, from);
        if (next === -1)
        {
            out[i++] = text.substr(from);
            out.length = i;
            break;
        }
        out[i++] = text.substring(from, next);
        from = next + 1;
    }
    return out;
}

export function concurrency<T,R>(items:T[], forEach:(item:T)=>Promise<R>):Promise<R[]>
{
    if (items.length <= concurrencyCount)
    {
        return Promise.all(items.map(forEach));
    }
    let itemi = 0;
    const out:R[] = new Array(items.length);
    function next():Promise<void>|void
    {
        if (itemi >= items.length) return;
        const idx = itemi++;
        forEach(items[idx]).then(r=>{
            out[idx] = r;
            next();
        });
    }
    const promises = new Array(concurrencyCount);
    for (let i=0;i<concurrencyCount;i++)
    {
        promises[i] = next();
    }
    return Promise.all(promises).then(()=>out);
}

export function identifierValidating(name:string):string
{
    name = name.replace(/[^0-9A-Za-z$_\u007f-\uffff]+/g, '_');
    if (name === '') return '_';
    const first = name.charCodeAt(0);
    if (0x30 <= first && first <= 0x39) return '_'+name;
    return name;
}

export function instanceProxy(instance:any):void
{

    for (const name in instance)
    {
        const fn = instance[name];
        if (fn instanceof Function)
        {
            instance[name] = function(...args:any[]):any
            {
                console.log(name, '(', args.join(', '), ')');
                return fn.apply(this, args);
            };
        }
        else
        {
            instance[name] = fn;
        }
    }
}

export function changeExt(filepath:string, ext:string):string
{
    const extidx = filepath.lastIndexOf('.');
    const pathidx = filepath.lastIndexOf(path.sep);
    if (extidx < pathidx) return filepath;
    return filepath.substr(0, extidx+1)+ext;
}

export function time():string
{
    return new Date().toLocaleTimeString();
}

const EMPTY = {};

export class ConcurrencyQueue
{
    private idles = concurrencyCount;
    private readonly reserved:(()=>Promise<void>)[] = [];
    private endResolve:(()=>void)|null = null;
    private endReject:((err:any)=>void)|null = null;
    private endPromise:Promise<void>|null = null;
    private idleResolve:(()=>void)|null = null;
    private idleReject:((err:any)=>void)|null = null;
    private idlePromise:Promise<void>|null = null;
    private _ref = 0;
    private _error:any = EMPTY;

    private readonly _next:()=>(Promise<void>|void) = ()=>{
        if (this.reserved.length === 0)
        {
            if (this.idles === 0 && this.idleResolve !== null)
            {
                this.idleResolve();
                this.idleResolve = null;
                this.idleReject = null;
                this.idlePromise = null;                
            }
            this.idles++;
            this._fireEnd();
            return;
        }
        const task = this.reserved.shift()!;
        return task().then(this._next, err=>this.error(err));
    };

    private _fireEnd():void
    {
        if (this.endResolve !== null && this._ref === 0 && this.idles === concurrencyCount)
        {
            this.endResolve();
            this.endResolve = null;
            this.endReject = null;
            this.endPromise = null;
        }
    }

    error(err:any):void
    {
        this._error = err;
        if (this.endReject !== null)
        {
            this.endReject(err);
            this.endResolve = null;
            this.endReject = null;
        }
        if (this.idleReject !== null)
        {
            this.idleReject(err);
            this.idleResolve = null;
            this.idleReject = null;
        }
    }

    ref():void
    {
        this._ref++;
    }

    unref():void
    {
        this._ref--;
        this._fireEnd();
    }

    onceHasIdle():Promise<void>
    {
        if (this.idlePromise !== null) return this.idlePromise;
        if (this._error !== EMPTY) return this.idlePromise = Promise.reject(this._error);
        if (this.idles !== 0) return Promise.resolve();
        return this.idlePromise = new Promise((resolve, reject)=>{
            this.idleResolve = resolve;
            this.idleReject = reject;
        });
    }

    onceEnd():Promise<void>
    {
        if (this.endPromise !== null) return this.endPromise;
        if (this._error !== EMPTY) return this.endPromise = Promise.reject(this._error);
        if (this.idles === concurrencyCount) return Promise.resolve();
        return this.endPromise = new Promise((resolve, reject)=>{
            this.endResolve = resolve;
            this.endReject = reject;
        });
    }

    run(task:()=>Promise<void>):void
    {
        this.reserved.push(task);
        if (this.idles === 0) return;
        this.idles--;
        this._next();
    }
}

export class SkipableTaskQueue
{
    private reserved:(()=>Promise<void>)|null = null;
    private processing = false;
    private endResolve:(()=>void)|null = null;
    private endReject:((err:any)=>void)|null = null;
    private endPromise:Promise<void>|null = null;
    private err = null;
    private readonly _continue = ()=>{
        if (this.reserved !== null)
        {
            this.reserved().then(this._continue, err=>{ 
                this.err = err; 
                if (this.endReject !== null)
                {
                    this.endReject(err);
                    this.endResolve = null;
                    this.endReject = null;
                    this.endPromise = null;
                }
            });
        }
        else
        {
            this.processing = false;
            if (this.endResolve !== null)
            {
                this.endResolve();
                this.endResolve = null;
                this.endReject = null;
                this.endPromise = null;
            }
        }
    };

    onceEnd():Promise<void>
    {
        if (this.err !== null) return Promise.reject(this.err);
        if (this.endPromise === null)
        {
            this.endPromise = new Promise((resolve, reject)=>{
                this.endResolve = resolve;
                this.endReject = reject;
            });
        }
        return this.endPromise;
    }

    run(task:()=>Promise<void>):void
    {
        if (this.processing)
        {
            this.reserved = task;
        }
        else
        {
            this.processing = true;
            task().then(this._continue);
        }
    }
}

class WatchItem<T>
{
    public readonly targets = new Set<T>();

    constructor(public readonly path:string, private readonly watcher:fs.FSWatcher)
    {
    }

    close():void
    {
        this.targets.clear();
        this.watcher.close();
    }
}

export class FilesWatcher<T>
{
    private readonly watching = new Map<string, WatchItem<T>>();
    private readonly modified = new Set<WatchItem<T>>();
    private timeout: NodeJS.Timeout|null = null;
    private paused = false;

    constructor(private readonly waiting = 100, private readonly onchange:(ev:IterableIterator<[T, string[]]>)=>void)
    {
    }

    pause():void
    {
        this.paused = true;
        if (this.timeout !== null)
        {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }

    resume():void
    {
        if (!this.paused) return;
        this.paused = false;
        if (this.modified.size !== 0)
        {
            this._fire();
        }
    }

    private _fire():void
    {
        if (this.timeout === null)
        {
            this.timeout = setTimeout(()=>{
                this.timeout = null;
                const targets = new Map<T, string[]>();
                for (const item of this.modified.values())
                {
                    for (const target of item.targets)
                    {
                        let files = targets.get(target);
                        if (!files) targets.set(target, [item.path]);
                        else files.push(item.path);
                    }
                }
                this.modified.clear();
                this.onchange(targets.entries());
            }, this.waiting);
        }
    }

    addWatch(target:T, file:string):void
    {
        let item = this.watching.get(file);
        if (item)
        {
            item.targets.add(target);
            return;
        }

        const watcher = fs.watch(file, 'utf-8');
        watcher.on('change', ()=>{
            this.modified.add(item!);
            if (this.paused) return;
            this._fire();
        });
        item = new WatchItem(file, watcher);
        item.targets.add(target);
        this.watching.set(file, item);
    }

    watch(target:T, files:string[]):void
    {
        const set = new Set<string>();
        for (const file of this.watching.keys())
        {
            set.add(file);
        }

        for (const file of files)
        {
            set.delete(file);
            this.addWatch(target, file);
        }

        for (const file of set)
        {
            const item = this.watching.get(file)!;
            if (item.targets.delete(target))
            {
                if (item.targets.size === 0)
                {
                    this.watching.delete(file);
                    this.modified.delete(item);
                    item.close();
                }
            }
        }
    }

}

const _kindMap = new Map<string, ts.ScriptKind>();
_kindMap.set('.TS', ts.ScriptKind.TS);
_kindMap.set('.TSX', ts.ScriptKind.TSX);
_kindMap.set('.JS', ts.ScriptKind.JS);
_kindMap.set('.JSX', ts.ScriptKind.JSX);
_kindMap.set('.JSON', ts.ScriptKind.JSON);

export function getScriptKind(filepath:string):{kind:ts.ScriptKind, ext:string}
{
    let ext = path.extname(filepath).toUpperCase();
    let kind = _kindMap.get(ext) || ts.ScriptKind.Unknown;
    switch (kind)
    {   
    case ts.ScriptKind.TS:
        const nidx = filepath.lastIndexOf('.', filepath.length - ext.length - 1);
        if (nidx !== -1)
        {
            const next = filepath.substr(nidx).toUpperCase();
            if (next === '.D.TS')
            {
                ext = next;
                kind = ts.ScriptKind.External;
            }
        }
        break;
    }
    return {kind, ext};
}
