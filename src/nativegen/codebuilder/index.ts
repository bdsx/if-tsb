export abstract class CodeBuilder {
    abstract call(fn: CodeFunction): void;
    abstract build(base: number): number;
    abstract resolve(base: number, constBase: number): Uint8Array;
}

export abstract class CodeFunction {}
