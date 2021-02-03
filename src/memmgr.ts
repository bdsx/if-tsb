
export class MemoryManager<T extends {clear():void, size:number, _key?:string|number, _next?:T, _prev?:T, _cacheTimer?:number}>
{
    private readonly map = new Map<string|number, T>();
    public current = 0;
    private timer:NodeJS.Timer|null = null;

    private readonly cacheTimeout = 20*60*1000;

    private readonly axis = {} as T;

    constructor(public maximum = 1024*1024*1024)
    {
        this.axis._next = this.axis;
        this.axis._prev = this.axis;
    }

    private _reduce():boolean
    {
        const node = this.axis._next!;
        if (node === this.axis) return false;
        this.current -= node.size;
        
        const next = node._next!;
        this.axis._next = next;
        next._prev = this.axis;

        this.map.delete(node._key!);
        delete node._prev;
        delete node._next;
        delete node._key;
        delete node._cacheTimer;
        node.clear();
        return true;
    }

    release(key:string|number, node:T):void
    {
        if (node.size > this.maximum) return;
        this.current += node.size;
        while (this.current > this.maximum)
        {
            this._reduce();
        }
        this.map.set(key, node);
        
        const last = this.axis._prev!;
        last._next = node;
        node._prev = last;
        node._next = this.axis;
        this.axis._prev = node;
        node._cacheTimer = Date.now() + this.cacheTimeout;

        if (this.timer === null)
        {
            this.timer = setTimeout(this._pollTimer, this.cacheTimeout+1);
            this.timer.unref();
        }
    }

    private readonly _pollTimer = ()=>{
        const now = Date.now();
        for (;;)
        {
            const front = this.axis._next!;
            if (front === this.axis)
            {
                this.timer = null;
                return;
            }
            const remained = front._cacheTimer! - now;
            if (remained <= 0)
            {
                this._reduce();
                continue;
            }
            this.timer = setTimeout(this._pollTimer, remained+1);
            this.timer.unref();
            return;
        }
    };

    get(key:string|number):T|undefined
    {
        const node = this.map.get(key);
        if (node)
        {
            node._cacheTimer = Date.now() + this.cacheTimeout;
            if (node._next !== this.axis)
            {
                const next = node._next!;
                const prev = node._prev!;
                next._prev = prev;
                prev._next = next;
    
                const last = this.axis._prev!;
                last._next = node;
                node._prev = last;
                node._next = this.axis;
                this.axis._prev = node;
            }
        }
        return node
    }
}