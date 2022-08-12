
interface Node{
    clear():void;
    size:number;

    _next?:Node;
    _prev?:Node;
    _cacheTimer?:number;
    _ref?:number;
    _map?:Map<keyof any, Node>;
    _key?:keyof any;
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

function attach(node:Node):void {
    const last = axis._prev!;
    last._next = node;
    node._prev = last;
    node._next = axis;
    axis._prev = node;
    node._cacheTimer = Date.now() + memcache.cacheTimeout;

    if (timer === null) {
        timer = setTimeout(pollTimer, memcache.cacheTimeout+1);
        timer.unref();
    }
}

function detach(node:Node):void {
    memcache.usage -= node.size;

    const next = node._next!;
    const prev = node._prev!;
    prev._next = next;
    next._prev = prev;

    delete node._prev;
    delete node._next;
    delete node._cacheTimer;
}

function reduce():boolean {
    const node = axis._next!;
    if (node === axis) return false;
    node._map!.delete(node._key!);
    memcache.truncate(node);
    if (memcache.verbose) console.log('[memcache] reducing...');
    return true;
}

function pollTimer():void{
    const now = Date.now();
    for (;;) {
        const front = axis._next!;
        if (front === axis) {
            timer = null;
            return;
        }
        const remained = front._cacheTimer! - now;
        if (remained <= 0) {
            reduce();
            continue;
        }
        timer = setTimeout(pollTimer, remained+1);
        timer.unref();
        return;
    }
}

const ESMap = Map;

export namespace memcache {
    export let verbose = false;
    export let maximum = 1024*1024*1024;
    export let usage = 0;
    export let cacheTimeout = 20*60*1000;

    export function isRegistered(item:Node):boolean {
        return item._ref != null;
    }
    export function release(item:Node):void {
        if (item._ref == null) return; // if unused item
        item._ref! --;
        if (item._ref === 0) {
            if (item.size > memcache.maximum) {
                item.clear();
                return;
            }
            memcache.usage += item.size;
            while (memcache.usage > memcache.maximum) {
                reduce();
            }
            attach(item);
        }
    }
    export function ref(item:Node):void {
        if (item._ref == null) throw Error(`non registered cache item`);
        if (item._ref === 0) {
            detach(item);
        }
        item._ref! ++;
    }
    export function unuse(item:Node):void {
        if (item._ref == null) throw Error(`non registered cache item`);
        if (item._ref === 0) {
            detach(item);
        }
        item._map!.delete(item._key!);
        delete item._key;
        delete item._map;
        delete item._ref;
        item.clear();
    }
    export function truncate(item:Node):void {
        if (item._ref == null) throw Error(`non registered cache item`);
        if (item._ref !== 0) return;
        detach(item);
        item._map!.delete(item._key!);
        delete item._key;
        delete item._map;
        delete item._ref;
        item.clear();
    }

    export class Map<K extends keyof any, V extends Node> {
    
        private readonly map = new ESMap<K, V>();
        
        register(key:K, node:V):void {
            if (node.size > memcache.maximum) return;
            if (node._ref != null) throw Error(`already registered cache item`);
            node._ref = 1;
            node._key = key;
            this.map.set(key, node);
            node._map = this.map;
        }
    
        takeOrCreate(key:K, creator:()=>V):V {
            let node = this.take(key);
            if (node == null) {
                node = creator();
                this.register(key, node);
            }
            return node;
        }
    
        take(key:K):V|undefined {
            const node = this.map.get(key);
            if (node != null) {
                ref(node);
            }
            return node;
        }
    
        clear():void {
            for (const item of this.map.values()) {
                memcache.usage -= item.size;
                release(item);
                truncate(item);
            }
            this.map.clear();
        }
    }
    
}
