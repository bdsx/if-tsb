import fs = require("fs");

class WatchItem<T> {
    public readonly targets = new Set<T>();

    constructor(
        public readonly path: string,
        private readonly watcher: fs.FSWatcher
    ) {}

    close(): void {
        this.targets.clear();
        this.watcher.close();
    }
}

export class FilesWatcher<T> {
    private readonly watching = new Map<string, WatchItem<T>>();
    private readonly modified = new Set<WatchItem<T>>();
    private timeout: NodeJS.Timeout | null = null;
    private paused = false;

    constructor(
        private readonly waiting = 100,
        private readonly onchange: (ev: IterableIterator<[T, string[]]>) => void
    ) {}

    pause(): void {
        this.paused = true;
        if (this.timeout !== null) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }

    resume(): void {
        if (!this.paused) return;
        this.paused = false;
        if (this.modified.size !== 0) {
            this._fire();
        }
    }

    private _fire(): void {
        if (this.timeout === null) {
            this.timeout = setTimeout(() => {
                this.timeout = null;
                const targets = new Map<T, string[]>();
                for (const item of this.modified.values()) {
                    for (const target of item.targets) {
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

    add(target: T, file: string): void {
        let item = this.watching.get(file);
        if (item) {
            item.targets.add(target);
            return;
        }

        const watcher = fs.watch(file, "utf-8");
        watcher.on("change", () => {
            this.modified.add(item!);
            if (this.paused) return;
            this._fire();
        });
        item = new WatchItem(file, watcher);
        item.targets.add(target);
        this.watching.set(file, item);
    }

    private _remove(target: T, item: WatchItem<T>): void {
        if (!item.targets.delete(target)) return;
        if (item.targets.size === 0) {
            this.watching.delete(item.path);
            this.modified.delete(item);
            item.close();
        }
    }

    clear(target: T): void {
        for (const item of this.watching.values()) {
            this._remove(target, item);
        }
    }

    reset(target: T, files: string[]): void {
        const set = new Set<string>();
        for (const file of this.watching.keys()) {
            set.add(file);
        }

        for (const file of files) {
            set.delete(file);
            this.add(target, file);
        }

        for (const file of set) {
            const item = this.watching.get(file)!;
            this._remove(target, item);
        }
    }
}
