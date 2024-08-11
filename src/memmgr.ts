export class CacheMap<K, V extends WeakKey> {
    private readonly map_ = new Map<K, WeakRef<V>>();
    private readonly finalizer_ = new FinalizationRegistry<K>((key) => {
        this.map_.delete(key);
    });

    constructor() {}

    set(key: K, val: V) {
        this.map_.set(key, new WeakRef(val));
        this.finalizer_.register(val, key);
    }

    get(key: K): V | undefined {
        const ref = this.map_.get(key);
        return ref?.deref();
    }

    delete(key: K) {
        const ref = this.map_.get(key);
        this.map_.delete(key);
        if (ref !== undefined) {
            this.finalizer_.unregister(ref.deref()!);
        }
    }

    clear() {
        for (const val of this.map_.values()) {
            this.finalizer_.unregister(val);
        }
        this.map_.clear();
    }
}
