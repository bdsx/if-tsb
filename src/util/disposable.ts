let symbolIndexCounter = 0;
if (global.Symbol === undefined) {
    global.Symbol = ((name?: string) => {
        if (name === undefined) name = "";
        return "___symbol_" + name + "_" + symbolIndexCounter++;
    }) as any;
}
if (Symbol.dispose === undefined) {
    (Symbol as any).dispose = Symbol("dispose");
}

export const disposeSymbol: typeof Symbol.dispose = Symbol.dispose;

export class DisposableArray {
    private readonly array_: Disposable[] = [];

    constructor() {}

    append(item: Disposable) {
        this.array_.push(item);
    }

    [disposeSymbol]() {
        for (const item of this.array_) {
            item[disposeSymbol]();
        }
    }
}
