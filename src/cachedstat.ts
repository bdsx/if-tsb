import fs = require("fs");
import { fsp } from "./fsp";

class Cache {
    public stat?: fs.Stats;

    public message?: string;
    public errno?: number;
    public code?: string;
    public path?: string;
    public syscall?: string;

    constructor(public prom: Promise<fs.Stats | null>) {}

    promise(): Promise<fs.Stats> {
        const err: NodeJS.ErrnoException = Error("");
        return this.prom.then((stat) => {
            if (stat !== null) {
                return stat;
            } else {
                if (err.stack != null) {
                    err.stack =
                        "Error: " +
                        this.message +
                        "\n" +
                        err.stack.substr(err.stack.indexOf("\n"));
                }
                err.message = this.message!;
                err.errno = this.errno;
                err.code = this.code;
                err.path = this.path;
                err.syscall = this.syscall;
                throw err;
            }
        });
    }

    setError(err: NodeJS.ErrnoException): void {
        this.message = err.message;
        this.errno = err.errno;
        this.code = err.code;
        this.path = err.path;
        this.syscall = err.syscall;
    }

    error(): NodeJS.ErrnoException {
        const err: NodeJS.ErrnoException = Error(this.message);
        err.errno = this.errno;
        err.code = this.code;
        err.path = this.path;
        err.syscall = this.syscall;
        return err;
    }
}

const caches = new Map<string, Cache>();

export function cachedStat(apath: string): Promise<fs.Stats> {
    let cache = caches.get(apath);
    if (cache == null) {
        const prom = fsp.stat(apath).then(
            (stat) => {
                cache!.stat = stat;
                return stat;
            },
            (err) => {
                cache!.setError(err);
                return null;
            }
        );
        cache = new Cache(prom);
        caches.set(apath, cache);
    }
    return cache.promise();
}
export namespace cachedStat {
    export function clear(): void {
        caches.clear();
    }
    export function sync(apath: string): fs.Stats {
        let cache = caches.get(apath);
        if (cache != null) {
            if (cache.stat != null) return cache.stat;
            if (cache.message != null) throw cache.error();
        }
        try {
            const stat = fs.statSync(apath);
            const prom = Promise.resolve(stat);
            if (cache == null) {
                cache = new Cache(prom);
            } else {
                cache.prom = prom;
            }
            cache.stat = stat;
        } catch (err) {
            if (cache == null) {
                cache = new Cache(Promise.resolve(null));
            } else {
                cache.prom = Promise.resolve(null);
            }
            cache.setError(err);
        }
        caches.set(apath, cache);
        if (cache.message != null) throw cache.error();
        return cache.stat!;
    }
    export async function exists(apath: string): Promise<boolean> {
        try {
            await cachedStat(apath);
            return true;
        } catch (err) {
            return false;
        }
    }
    export function existsSync(apath: string): boolean {
        try {
            cachedStat.sync(apath);
            return true;
        } catch (err) {
            return false;
        }
    }
    export async function mtime(apath: string): Promise<number> {
        return +(await cachedStat(apath)).mtime;
    }
    export function mtimeSync(apath: string): number {
        return +cachedStat.sync(apath).mtime;
    }
}
