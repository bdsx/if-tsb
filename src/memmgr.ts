
interface Node{
    clear():void;
    size:number;

    _key?:keyof any;
    _next?:Node;
    _prev?:Node;
    _cacheTimer?:number;
    _host?:CacheMap<any, any>;
    _ref?:number;
}

const axis = {} as Node;
axis._next = axis;
axis._prev = axis;

let timer:NodeJS.Timer|null = null;

function renew(node:Node, cacheTimeout:number):void {
    node._cacheTimer = Date.now() + cacheTimeout;
    if (node._next !== axis) {
        const next = node._next!;
        const prev = node._prev!;
        next._prev = prev;
        prev._next = next;

        const last = axis._prev!;
        last._next = node;
        node._prev = last;
        node._next = axis;
        axis._prev = node;
    }
}

function detach(node:Node):void {
    CacheMap.usage -= node.size;

    const next = node._next!;
    const prev = node._prev!;
    prev._next = next;
    next._prev = prev;

    delete node._prev;
    delete node._next;
    delete node._key;
    delete node._cacheTimer;
    delete node._host;
}

export class CacheMap<K extends keyof any, V extends Node> {
    public static maximum = 1024*1024*1024;
    public static usage = 0;
    public static verbose = false;

    private readonly map = new Map<K, V>();

    constructor(public readonly cacheTimeout = 20*60*1000) {
    }

    private static _pollTimer():void{
        const now = Date.now();
        for (;;) {
            const front = axis._next!;
            if (front === axis) {
                timer = null;
                return;
            }
            const remained = front._cacheTimer! - now;
            if (remained <= 0) {
                CacheMap._reduce();
                continue;
            }
            timer = setTimeout(CacheMap._pollTimer, remained+1);
            timer.unref();
            return;
        }
    }

    private static _reduce():boolean {
        const node = axis._next!;
        if (node === axis) return false;
        node._host!.map.delete(node._key);
        detach(node);
        node.clear();
        if (CacheMap.verbose) console.log('[CacheMap] reducing...');
        return true;
    }
    
    release(key:K, node:V):void {
        if (node.size > CacheMap.maximum) return;
        CacheMap.usage += node.size;
        while (CacheMap.usage > CacheMap.maximum) {
            CacheMap._reduce();
        }
        if (node._ref != null) {
            node._ref--;
            if (node._ref !== 0) return;
        } else {
            this.map.set(key, node);
            node._ref = 0;
        }
        
        const last = axis._prev!;
        last._next = node;
        node._key = key;
        node._prev = last;
        node._next = axis;
        axis._prev = node;
        node._cacheTimer = Date.now() + this.cacheTimeout;
        node._host = this;

        if (timer === null) {
            timer = setTimeout(CacheMap._pollTimer, this.cacheTimeout+1);
            timer.unref();
        }
    }

    register(key:K, node:V):void {
        if (node.size > CacheMap.maximum) return;
        CacheMap.usage += node.size;
        while (CacheMap.usage > CacheMap.maximum) {
            CacheMap._reduce();
        }
        if (node._ref != null) {
            node._ref++;
        } else {
            node._ref = 1;
            this.map.set(key, node);
        }
    }

    takeOrCreate(key:K, creator:()=>V):V {
        let v = this.take(key);
        if (v == null) {
            this.register(key, v = creator());
        }
        return v;
    }

    take(key:K):V|undefined {
        const node = this.map.get(key);
        if (node != null) {
            if (node._ref === 0) {
                detach(node);
            }
            node._ref! ++;
        }
        return node;
    }

    clear():void {
        for (const item of this.map.values()) {
            CacheMap.usage -= item.size;
            delete item._prev;
            delete item._next;
            delete item._key;
            delete item._cacheTimer;
            delete item._host;
            delete item._ref;
            item.clear();
        }
        this.map.clear();
    }
}
