
import ts = require('typescript');
import os = require('os');
import fs = require('fs');
import path = require('path');

export const cpuCount = os.cpus().length;
const concurrencyCount = Math.min(Math.max(cpuCount*2, 8), cpuCount);
const drainThreshold = cpuCount>>1;

export const resolved = Promise.resolve();

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

export function count(content:string, chr:string):number
{
    const code = chr.charCodeAt(0);
    const n = content.length;
    let count = 0;
    for (let i=0;i<n;i++)
    {
        if (content.charCodeAt(i) === code) count++;
    }
    return count;
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
    private drainResolve:(()=>void)|null = null;
    private drainReject:((err:any)=>void)|null = null;
    private drainPromise:Promise<void>|null = null;

    private readonly _next:()=>(Promise<void>|void) = ()=>{
        if (this.drainResolve !== null && this.reserved.length < drainThreshold) {
            this.drainResolve();
            this.drainResolve = null;
            this.drainReject = null;
            this.drainPromise = null;
        }
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
        if (this.drainReject !== null) 
        {
            this.drainReject(err);
            this.drainResolve = null;
            this.drainReject = null;
        }
        this.drainPromise = this.idlePromise = this.endPromise = Promise.reject(this._error);
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
        if (this.idles !== 0) return Promise.resolve();
        return this.idlePromise = new Promise((resolve, reject)=>{
            this.idleResolve = resolve;
            this.idleReject = reject;
        });
    }

    onceEnd():Promise<void>
    {
        if (this.endPromise !== null) return this.endPromise;
        if (this.idles === concurrencyCount) return Promise.resolve();
        return this.endPromise = new Promise((resolve, reject)=>{
            this.endResolve = resolve;
            this.endReject = reject;
        });
    }

    run(task:()=>Promise<void>):Promise<void>
    {
        this.reserved.push(task);
        if (this.idles === 0) {
            if (this.reserved.length > drainThreshold) {
                if (this.drainPromise !== null) return this.drainPromise;
                return this.drainPromise = new Promise((resolve, reject)=>{
                    this.drainResolve = resolve;
                    this.drainReject = reject;
                });
            }
            return resolved;
        }
        this.idles--;
        this._next();
        return resolved;
    }

    getTaskCount():number {
        return this.reserved.length + concurrencyCount - this.idles;
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

export function parsePostfix(str:string|number|undefined):number|undefined
{
    switch (typeof str)
    {
    case 'string': break;
    case 'number': return str;
    default: return undefined;
    }
    const n = str.length;
    let value = 0;
    for (let i=0;i<n;i++)
    {
        const code = str.charCodeAt(i);
        if (0x30 <= code && code <= 0x39)
        {
            value *= 10;
            value += code - 0x30;
            continue;
        }
        if (i !== n-1)
        {
            console.error(`Unknown nummer character: ${str.charAt(i)}`);
            continue;
        }
        switch (code)
        {
        case 0x62: case 0x42:
            break;
        case 0x6b: case 0x4b: // K
            value *= 1024;
            break;
        case 0x6d: case 0x4d: // M
            value *= 1024*1024;
            break;
        case 0x67: case 0x47: // G
            value *= 1024*1024*1024;
            break;
        case 0x74: case 0x54: // T
            value *= 1024*1024*1024*1024;
            break;
        default:
            console.error(`Unknown number postfix: ${str.charAt(i)}`);
            break;
        }
        break;
    }
    return value;
}

export function joinModulePath(...pathes:string[]):string
{
    const out:string[] = [];
    let backcount = 0;

    let absolute:string|null = null;
    for (const child of pathes)
    {
        let prev = 0;

        if (!child.startsWith('.'))
        {
            out.length = 0;
            backcount = 0;
            const dot = child.indexOf('/', prev);
            absolute = (dot === -1) ? child.substr(prev) : child.substring(prev, dot);
            if (dot === -1) break;
            prev = dot + 1;
        }

        for (;;)
        {
            const dot = child.indexOf('/', prev);
            const partname = (dot === -1) ? child.substr(prev) : child.substring(prev, dot);
            switch (partname)
            {
            case '.': break;
            case '..':
                if (!out.pop())
                {
                    backcount++;
                }
                break;
            default:
                out.push(partname);
                break;
            }
            if (dot === -1) break;
            prev = dot + 1;
        }
    }
    let outstr = '';
    if (absolute !== null) outstr += absolute + '/';
    if (backcount === 0)
    {
        if (absolute === null) outstr += './';
    }
    else outstr += '../'.repeat(backcount);
    
    if (out.length === 0) return outstr.substr(0, outstr.length-1);
    else return outstr + out.join('/');
}