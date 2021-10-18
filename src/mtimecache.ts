import fs = require('fs');
import { fsp } from './fsp';

const mtimes = new Map<string, number>();

export async function getMtime(apath:string):Promise<number> {
    const v = mtimes.get(apath);
    if (v != null) return v;
    const stat = await fsp.stat(apath);
    const mtime = +stat.mtime;
    mtimes.set(apath, mtime);
    return mtime;
}
export namespace getMtime {
    export function clear():void {
        mtimes.clear();
    }
    export function sync(apath:string):number {
        const v = mtimes.get(apath);
        if (v != null) return v;
        const stat = fs.statSync(apath);
        const mtime = +stat.mtime;
        mtimes.set(apath, mtime);
        return mtime;
    }
}
