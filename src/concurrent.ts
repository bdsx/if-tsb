const EMPTY = {};

import os = require("os");
import { resolved } from "./util";

export const cpuCount = os.cpus().length;
const concurrencyCount = Math.min(Math.max(cpuCount * 2, 8), cpuCount);

interface TaskObject {
    name: string;
    task: () => Promise<void>;
}

export class ConcurrencyQueue {
    private readonly reserved: TaskObject[] = [];
    private readonly allTasks = new Set<TaskObject>();
    private endResolve: (() => void) | null = null;
    private endReject: ((err: any) => void) | null = null;
    private endPromise: Promise<void> | null = null;
    private idleResolve: (() => void) | null = null;
    private idleReject: ((err: any) => void) | null = null;
    private idlePromise: Promise<void> | null = null;
    private _ref = 0;
    private _error: any = EMPTY;
    public static verbose = false;

    constructor(
        public readonly name: string,
        private readonly concurrency = concurrencyCount
    ) {}

    private _verbose(post: string): void {
        post = " " + post;
        let names = [...this.allTasks].map((task) => task.name).join(", ");
        const pre = `${this.name} - `;
        const maximum = process.stdout.columns - pre.length - post.length;
        if (names.length > maximum) {
            names = names.substr(0, maximum - 3) + "...";
        }
        console.log(pre + names + post);
    }

    private readonly _next: (
        lastTask: TaskObject | null
    ) => Promise<void> | void = (lastTask: TaskObject | null) => {
        if (lastTask !== null) {
            this.allTasks.delete(lastTask);

            if (ConcurrencyQueue.verbose) {
                const names = this.reserved.map((task) => task.name);
                const idx = names.indexOf(lastTask.name);
                names.splice(idx, 1);
                this._verbose(`(- ${lastTask.name})`);
            }
        }

        if (this.reserved.length === 0) {
            if (this.idleResolve !== null) {
                if (this.allTasks.size < this.concurrency) {
                    this.idleResolve();
                    this.idleResolve = null;
                    this.idleReject = null;
                    this.idlePromise = null;
                }
            }
            this._fireEnd();
            return;
        }
        const task = this.reserved.shift()!;
        return task.task().then(
            () => this._next(task),
            (err) => this.error(err)
        );
    };

    private _fireEnd(): void {
        if (this._ref === 0 && this.allTasks.size === 0) {
            if (this.endResolve !== null) {
                if (ConcurrencyQueue.verbose) console.log(`${this.name} - End`);
                this.endResolve();
                this.endResolve = null;
                this.endReject = null;
                this.endPromise = null;
            }
        }
    }

    error(err: any): void {
        this._error = err;
        if (this.endReject !== null) {
            this.endReject(err);
            this.endResolve = null;
            this.endReject = null;
        }
        if (this.idleReject !== null) {
            this.idleReject(err);
            this.idleResolve = null;
            this.idleReject = null;
        }
        this.idlePromise = this.endPromise = Promise.reject(this._error);
    }

    ref(): void {
        this._ref++;
    }

    unref(): void {
        this._ref--;
        this._fireEnd();
    }

    onceHasIdle(): Promise<void> {
        if (this.idlePromise !== null) return this.idlePromise;
        if (this.allTasks.size < this.concurrency) return resolved;
        return (this.idlePromise = new Promise((resolve, reject) => {
            this.idleResolve = resolve;
            this.idleReject = reject;
        }));
    }

    onceEnd(): Promise<void> {
        if (this.endPromise !== null) return this.endPromise;
        if (this.allTasks.size === 0) return resolved;
        return (this.endPromise = new Promise((resolve, reject) => {
            this.endResolve = resolve;
            this.endReject = reject;
        }));
    }

    run(name: string, task: () => Promise<void>): Promise<void> {
        const taskobj = { name, task };
        this.allTasks.add(taskobj);

        this.reserved.push(taskobj);
        if (ConcurrencyQueue.verbose) this._verbose(`(+ ${name})`);

        if (this.allTasks.size >= this.concurrency) {
            if (this.reserved.length > this.concurrency >> 1) {
                if (ConcurrencyQueue.verbose)
                    console.log(`${this.name} - Drain`);
                return this.onceHasIdle();
            }
            return resolved;
        }
        this._next(null);
        return resolved;
    }

    getTaskCount(): number {
        return this.allTasks.size;
    }
}
