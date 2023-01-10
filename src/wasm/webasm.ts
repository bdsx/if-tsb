export class Opcode {
    public readonly bytes: Uint8Array;
    constructor(bytes: number[]) {
        this.bytes = new Uint8Array(bytes);
    }
}

export class WasmHead extends Opcode {
    constructor() {
        super([
            0x00,
            0x61,
            0x73,
            0x6d, // magic
            0x0d,
            0x00,
            0x00,
            0x00, // version
        ]);
    }
}
