interface Node {
    clear(): void;
    size: number;

    _next?: Node;
    _prev?: Node;
    _cacheTimer?: number;
    _ref?: number;
    _map?: Map<keyof any, Node>;
    _key?: keyof any;
}

const axis = {} as Node;
axis._next = axis;
axis._prev = axis;

let timer: NodeJS.Timer | null = null;

function renew(node: Node, cacheTimeout: number): void {
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

function addToKeepList(node: Node): void {
    if (node._ref !== 0) throw Error("using but keeped");
    const last = axis._prev!;
    last._next = node;
    node._prev = last;
    node._next = axis;
    axis._prev = node;
    node._cacheTimer = Date.now() + memcache.cacheTimeout;

    if (timer === null) {
        timer = setTimeout(pollTimer, memcache.cacheTimeout + 1);
        timer.unref();
    }
}

function deleteFromKeepList(node: Node): void {
    memcacheUsage -= node.size;

    const next = node._next!;
    const prev = node._prev!;
    prev._next = next;
    next._prev = prev;

    delete node._prev;
    delete node._next;
    delete node._cacheTimer;
}

function reduceKeepList(): boolean {
    const node = axis._next!;
    if (node === axis) return false;
    deleteNow(node);
    if (memcache.verbose) console.log("[memcache] reducing...");
    return true;
}

function pollTimer(): void {
    const now = Date.now();
    for (;;) {
        const front = axis._next!;
        if (front === axis) {
            timer = null;
            return;
        }
        const remained = front._cacheTimer! - now;
        if (remained <= 0) {
            reduceKeepList();
            continue;
        }
        timer = setTimeout(pollTimer, remained + 1);
        timer.unref();
        return;
    }
}

const ESMap = Map;

let memcacheUsage = 0;
function deleteNow(item: Node): void {
    if (item._ref === undefined) throw Error(`non registered cache item`);
    if (item._ref !== 0) throw Error(`using but deleted`);
    deleteFromKeepList(item);
    item._map!.delete(item._key!);
    delete item._key;
    delete item._map;
    delete item._ref;
    item.clear();
}

export namespace memcache {
    export let verbose = false;
    export let maximum = 1024 * 1024 * 1024;
    export let cacheTimeout = 20 * 60 * 1000;

    export function release(item: Node): void {
        if (item._ref === undefined) throw Error(`non registered cache item`);
        item._ref--;
        if (item._ref === 0) {
            if (item._key === undefined) {
                // expired item
                delete item._ref;
                item.clear();
            } else {
                if (item.size > memcache.maximum) {
                    item.clear();
                    return;
                }
                memcacheUsage += item.size;
                while (memcacheUsage > memcache.maximum) {
                    reduceKeepList();
                }
                addToKeepList(item);
            }
        }
    }
    export function expire(item: Node): void {
        if (item._ref === undefined) throw Error(`non registered cache item`);
        item._map!.delete(item._key!);
        delete item._key;
        delete item._map;
        if (item._ref === 0) {
            delete item._ref;
            deleteFromKeepList(item);
            item.clear();
        }
    }

    export class Map<K extends keyof any, V extends Node> {
        private readonly map = new ESMap<K, V>();

        register(key: K, node: V): void {
            if (node.size > memcache.maximum) return;
            if (node._ref !== undefined)
                throw Error(`already registered cache item`);
            node._ref = 1;
            node._key = key;
            this.map.set(key, node);
            node._map = this.map;
        }

        takeOrCreate(key: K, creator: () => V): V {
            let node = this.take(key);
            if (node === undefined) {
                node = creator();
                this.register(key, node);
            }
            return node;
        }

        take(key: K): V | undefined {
            const node = this.map.get(key);
            if (node !== undefined) {
                if (node._ref === undefined)
                    throw Error(`non registered cache node`);
                if (node._ref === 0) {
                    deleteFromKeepList(node);
                }
                node._ref!++;
            }
            return node;
        }

        clear(): void {
            for (const item of this.map.values()) {
                memcacheUsage -= item.size;
                release(item);
                if (item._ref === 0) deleteNow(item);
            }
            this.map.clear();
        }

        createIfModified(key:K, isModified:(file:V)=>boolean, creator:()=>V):V {
            let data = this.take(key);
            if (data !== undefined) {
                if (!isModified(data)) {
                    return data;
                } else {
                    memcache.expire(data);
                }
            }
            data = creator();
            this.register(key, data);
            return data;
        }
    }
}
