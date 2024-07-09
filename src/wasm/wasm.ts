import * as fs from "fs";
import { BufferStream, BufferWritable } from "./stream";

const HEADER = new Uint8Array([
    // .wasm
    0x00, 0x61, 0x73, 0x6d,

    // version
    0x01, 0x00, 0x00, 0x00,
]);

enum WasmSectionId {
    Custom = 0,
    Type = 1,
    Import = 2,
    Function = 3,
    Table = 4,
    Memory = 5,
    Global = 6,
    Export = 7,
    Start = 8,
    Element = 9,
    Code = 10,
    Data = 11,
    DataCount = 12,
}

abstract class WasmSection {
    constructor() {}
    abstract getId(): WasmSectionId;
    abstract generateDataBuffer(): Uint8Array;
}

abstract class WasmType implements BufferWritable {
    constructor(public readonly tag: number) {}
    abstract writeTo(s: BufferStream): void;
}

class WasmBasicType extends WasmType {
    constructor(tag: number, private readonly serializedCode_: string) {
        super(tag);
    }

    writeTo(s: BufferStream): void {
        s.leb128(this.tag);
    }
    serialize() {
        return this.serializedCode_;
    }

    static readonly i32 = new WasmBasicType(0x7f, "i");
    static readonly i64 = new WasmBasicType(0x7e, "l");
    static readonly f32 = new WasmBasicType(0x7d, "f");
    static readonly f64 = new WasmBasicType(0x7c, "d");
}

class WasmFuncType extends WasmType {
    constructor(
        public readonly params: WasmBasicType[],
        public readonly results: WasmBasicType[],
        public readonly index: number
    ) {
        super(0x60);
    }
    writeTo(s: BufferStream): void {
        s.leb128(this.tag);
        s.writeArray(this.params);
        s.writeArray(this.results);
    }
}
class WasmTypeSection extends WasmSection {
    private readonly types_ = new Map<string, WasmFuncType>();

    constructor() {
        super();
    }

    getId(): WasmSectionId {
        return WasmSectionId.Type;
    }
    generateDataBuffer(): Uint8Array {
        const s = new BufferStream();
        s.writeMapValue(this.types_);
        return s.buffer();
    }
    add(params: WasmBasicType[], results: WasmBasicType[]) {
        let key = "";
        for (const v of params) {
            key += v.serialize();
        }
        key += ":";
        for (const v of results) {
            key += v.serialize();
        }
        let res = this.types_.get(key);
        if (res !== undefined) return res;
        res = new WasmFuncType(params, results, this.types_.size);
        this.types_.set(key, res);
        return res;
    }
}

enum WasmExportTag {
    func,
    table,
    mem,
    global,
}

abstract class WasmExportable {
    constructor(public readonly index: number) {}
    abstract getType(): WasmExportTag;
}

class WasmFunction extends WasmExportable {
    constructor(public type: WasmFuncType, index: number) {
        super(index);
    }
    getType(): WasmExportTag {
        return WasmExportTag.func;
    }
}
class WasmFunctionSection extends WasmSection {
    private readonly functions_: WasmFunction[] = [];

    getId(): WasmSectionId {
        return WasmSectionId.Function;
    }
    generateDataBuffer(): Uint8Array {
        const s = new BufferStream();
        s.leb128(this.functions_.length);
        for (const func of this.functions_) {
            s.leb128(func.type.index);
        }
        return s.buffer();
    }
    add(type: WasmFuncType) {
        const func = new WasmFunction(type, this.functions_.length);
        this.functions_.push(func);
        return func;
    }
}

class WasmExport implements BufferWritable {
    constructor(
        public readonly name: string,
        public readonly item: WasmExportable
    ) {}

    writeTo(s: BufferStream) {
        s.string(this.name);
        s.i8(this.item.getType());
        s.leb128(this.item.index);
    }
}
class WasmExportSection extends WasmSection {
    public readonly exports: WasmExport[] = [];

    getId(): WasmSectionId {
        return WasmSectionId.Export;
    }

    generateDataBuffer(): Uint8Array {
        const s = new BufferStream();
        s.writeArray(this.exports);

        return s.buffer();
    }
}
class WasmStartSection extends WasmSection {
    constructor(public readonly start: WasmFunction) {
        super();
    }
    getId(): WasmSectionId {
        return WasmSectionId.Start;
    }

    generateDataBuffer(): Uint8Array {
        const s = new BufferStream();
        s.leb128(this.start.index);
        return s.buffer();
    }
}

export class Wasm {
    private readonly sections_: WasmSection[] = [];

    private start_: WasmStartSection | null = null;
    private type_: WasmTypeSection | null = null;
    private func_: WasmFunctionSection | null = null;
    private export_: WasmExportSection | null = null;

    constructor() {}

    private addFuncType_(params: WasmBasicType[], results: WasmBasicType[]) {
        if (this.type_ === null) {
            this.type_ = new WasmTypeSection();
            this.sections_.push(this.type_);
        }
        return this.type_.add(params, results);
    }

    setStart(func: WasmFunction) {
        if (this.start_ !== null) throw Error(`StartSection already exists`);
        this.start_ = new WasmStartSection(func);
        this.sections_.push(this.start_);
    }

    createFunction(params: WasmBasicType[], results: WasmBasicType[]) {
        if (this.func_ === null) {
            this.func_ = new WasmFunctionSection();
            this.sections_.push(this.func_);
        }
        const type = this.addFuncType_(params, results);
        return this.func_.add(type);
    }

    export(name: string, item: WasmExportable) {
        if (this.export_ === null) {
            this.export_ = new WasmExportSection();
            this.sections_.push(this.export_);
        }
        this.export_.exports.push(new WasmExport(name, item));
    }

    generate(): Uint8Array[] {
        const s = new BufferStream();
        const out: Uint8Array[] = [HEADER];
        for (const section of this.sections_) {
            const buf = section.generateDataBuffer();
            s.reset();
            s.i8(section.getId());
            s.leb128(buf.length);
            out.push(s.buffer(), buf);
        }
        return out;
    }

    writeTo(filename: string) {
        return fs.promises.writeFile(filename, this.generate());
    }

    public static i32 = WasmBasicType.i32;
    public static i64 = WasmBasicType.i64;
    public static f32 = WasmBasicType.f32;
    public static f64 = WasmBasicType.f64;
}
