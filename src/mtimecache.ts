import fs = require('fs');
import { fsp } from './fsp';

const mtimes = new Map<string, number|Error>();

export async function getMtime(apath:string):Promise<number> {
    const v = mtimes.get(apath);
    if (v != null) {
        if (typeof v === 'number') return v;
        else throw v;
    }
    try {
        const stat = await fsp.stat(apath);
        const mtime = +stat.mtime;
        mtimes.set(apath, mtime);
        return mtime;
    } catch (err) {
        mtimes.set(apath, err);
        throw err;
    }
}
export namespace getMtime {
    export function clear():void {
        mtimes.clear();
    }
    export function sync(apath:string):number {
        const v = mtimes.get(apath);
        if (v != null) {
            if (typeof v === 'number') return v;
            else throw v;
        }
        const stat = fs.statSync(apath);
        const mtime = +stat.mtime;
        mtimes.set(apath, mtime);
        return mtime;
    }
    export async function exists(apath:string):Promise<boolean> {
        try {
            await getMtime(apath);
            return true;
        } catch (err) {
            return false;
        }
    }
    export function existsSync(apath:string):boolean {
        try {
            getMtime.sync(apath);
            return true;
        } catch (err) {
            return false;
        }
    }
}
