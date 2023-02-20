import { resolved } from "./util";

export class ValueLock<T> {
    private readonly writingProm: Promise<T> | null = null;
    private csResolve: (() => void)[] = [];
    private csEntered = false;

    public resolveWriter: (writer: T) => void;

    constructor() {
        this.writingProm = new Promise((resolve) => {
            this.resolveWriter = resolve;
        });
    }

    lockWithoutWriter(): Promise<void> {
        if (!this.csEntered) {
            this.csEntered = true;
            return resolved;
        }
        return new Promise<void>((resolve) => {
            this.csResolve.push(resolve);
        });
    }

    async lock(): Promise<T> {
        const writer = await this.writingProm!;
        await this.lockWithoutWriter();
        return writer;
    }

    unlock(): void {
        if (this.csResolve.length === 0) {
            if (this.csEntered) {
                this.csEntered = false;
                return;
            }
            throw Error(`unlock more than lock`);
        }
        const resolve = this.csResolve.pop()!;
        resolve();
    }
}
