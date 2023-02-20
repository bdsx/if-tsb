import { BufferWriter } from "bdsx-util/writer/bufferstream";
import { FileBufferWriter } from "bdsx-util/writer/filewriter";
import { asm } from "x64asm";
import {
    AddressResolver,
    PEDataSectionAddress,
    PESectionAddress,
    PESectionData,
} from "./address";
import { CodeBuilder } from "./codebuilder";
import { peUtil } from "./peutil";

const IMAGE_SCN_TYPE_NO_PAD = 0x00000008; // The section should not be padded to the next boundary. This flag is obsolete and is replaced by IMAGE_SCN_ALIGN_1BYTES.
const IMAGE_SCN_CNT_CODE = 0x00000020; // The section contains executable code.
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040; // The section contains initialized data.
const IMAGE_SCN_CNT_UNINITIALIZED_DATA = 0x00000080; // The section contains uninitialized data.
const IMAGE_SCN_LNK_OTHER = 0x00000100; // Reserved.
const IMAGE_SCN_LNK_INFO = 0x00000200; // The section contains comments or other information. This is valid only for object files.
const IMAGE_SCN_LNK_REMOVE = 0x00000800; // The section will not become part of the image. This is valid only for object files.
const IMAGE_SCN_LNK_COMDAT = 0x00001000; // The section contains COMDAT data. This is valid only for object files.
const IMAGE_SCN_NO_DEFER_SPEC_EXC = 0x00004000; // Reset speculative exceptions handling bits in the TLB entries for this section.
const IMAGE_SCN_GPREL = 0x00008000; // The section contains data referenced through the global pointer.
const IMAGE_SCN_MEM_PURGEABLE = 0x00020000; // Reserved.
const IMAGE_SCN_MEM_LOCKED = 0x00040000; // Reserved.
const IMAGE_SCN_MEM_PRELOAD = 0x00080000; // Reserved.
const IMAGE_SCN_ALIGN_1BYTES = 0x00100000; // Align data on a 1-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_2BYTES = 0x00200000; // Align data on a 2-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_4BYTES = 0x00300000; // Align data on a 4-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_8BYTES = 0x00400000; // Align data on a 8-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_16BYTES = 0x00500000; // Align data on a 16-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_32BYTES = 0x00600000; // Align data on a 32-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_64BYTES = 0x00700000; // Align data on a 64-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_128BYTES = 0x00800000; // Align data on a 128-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_256BYTES = 0x00900000; // Align data on a 256-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_512BYTES = 0x00a00000; // Align data on a 512-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_1024BYTES = 0x00b00000; // Align data on a 1024-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_2048BYTES = 0x00c00000; // Align data on a 2048-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_4096BYTES = 0x00d00000; // Align data on a 4096-byte boundary. This is valid only for object files.
const IMAGE_SCN_ALIGN_8192BYTES = 0x00e00000; // Align data on a 8192-byte boundary. This is valid only for object files.
const IMAGE_SCN_LNK_NRELOC_OVFL = 0x01000000; // The section contains extended relocations. The count of relocations for the section exceeds the 16 bits that is reserved for it in the section header. If the NumberOfRelocations field in the section header is 0xffff, the actual relocation count is stored in the VirtualAddress field of the first relocation. It is an error if IMAGE_SCN_LNK_NRELOC_OVFL is set and there are fewer than 0xffff relocations in the section.
const IMAGE_SCN_MEM_DISCARDABLE = 0x02000000; // The section can be discarded as needed.
const IMAGE_SCN_MEM_NOT_CACHED = 0x04000000; // The section cannot be cached.
const IMAGE_SCN_MEM_NOT_PAGED = 0x08000000; // The section cannot be paged.
const IMAGE_SCN_MEM_SHARED = 0x10000000; // The section can be shared in memory.
const IMAGE_SCN_MEM_EXECUTE = 0x20000000; // The section can be executed as code.
const IMAGE_SCN_MEM_READ = 0x40000000; // The section can be read.
const IMAGE_SCN_MEM_WRITE = 0x80000000; // The section can be written to.

const sectionTemplate = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    // Name
    0x00, 0x00, 0x00, 0x00,
    // VirtualSize
    0x00, 0x00, 0x00, 0x00,
    // VirtualAddress
    // 0x10 bytes

    0x00, 0x00, 0x00, 0x00,
    // SizeOfRawData
    0x00, 0x00, 0x00, 0x00,
    // PointerToRawData
    0x00, 0x00, 0x00, 0x00,
    // PointerToRelocations
    0x00, 0x00, 0x00, 0x00,
    // PointerToLinenumbers
    // 0x20 bytes

    0x00, 0x00,
    // NumberOfRelocations
    0x00, 0x00,
    // NumberOfLinenumbers
    0x00, 0x00, 0x00, 0x00,
    // Characteristics
]);

export enum SectionName {
    text = ".text", //Contains the executable code of the program.
    data = ".data", //Contains the initialized data.
    bss = ".bss", //Contains uninitialized data.
    rdata = ".rdata", //Contains read-only initialized data.
    edata = ".edata", //Contains the export tables.
    idata = ".idata", //Contains the import tables.
    reloc = ".reloc", //Contains image relocation information.
    rsrc = ".rsrc", //Contains resources used by the program, these include images, icons or even embedded binaries.
    tls = ".tls", //(Thread Local Storage), provides storage for every executing thread of the program.
}

export abstract class PESection implements asm.Address {
    public virtualAddress: number = 0;
    public pointerToRawData: number = 0;

    public dataBuffer: Uint8Array | null = null;
    public dataSize: number = 0;

    constructor(
        public readonly name: SectionName,
        public readonly characteristics: number
    ) {}

    getPadValue(): number {
        return 0;
    }

    setBuffer(buffer: Uint8Array): void {
        this.dataBuffer = buffer;
        this.dataSize = peUtil.fileAlign(buffer.length);
    }

    getAddress(): number {
        if (this.virtualAddress === 0)
            throw Error("section address is not resolved");
        return this.virtualAddress;
    }

    async writeHeaderTo(writer: FileBufferWriter): Promise<void> {
        if (this.dataBuffer === null) throw Error("is not ready");

        const sectionBuf = sectionTemplate.slice();
        peUtil.setAscii(sectionBuf, 0, this.name, 8);
        const sectionView = new DataView(sectionBuf.buffer);
        sectionView.setUint32(0x08, this.dataBuffer!.length, true);
        sectionView.setUint32(0x0c, this.virtualAddress, true);
        sectionView.setUint32(0x10, this.dataSize, true);
        sectionView.setUint32(0x14, this.pointerToRawData, true);
        sectionView.setInt32(0x24, this.characteristics, true);
        await writer.write(sectionBuf);
    }

    async writeContentTo(writer: FileBufferWriter): Promise<void> {
        await peUtil.writeBufferWithPad(
            writer,
            this.dataBuffer!,
            this.dataSize,
            this.getPadValue()
        );
        this.dataBuffer = null;
    }

    static readonly SIZE = sectionTemplate.length;
}

export namespace PESection {
    export class Text extends PESection {
        public builder: CodeBuilder | null = null;

        constructor() {
            super(
                SectionName.text,
                IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_EXECUTE
            );
        }

        getPadValue(): number {
            return 0xcc;
        }

        resolve(rdata: PESection.RData, wdata: PESection.WData | null) {
            if (this.builder !== null) {
                const buffer = this.builder.resolve(
                    this.getAddress(),
                    rdata.getAddress()
                );
                this.setBuffer(buffer);
            }
        }
        build(): void {
            if (this.builder !== null) {
                this.dataSize = this.builder.build(this.virtualAddress);
            } else {
                this.dataSize = 0;
            }
        }
    }

    export class Data extends PESection {
        private readonly data = new BufferWriter();
        private readonly dynamicAddress: AddressResolver[] = [];
        private _view: DataView | null = null;

        getUint8(address: number): number {
            return this.view().getUint8(address);
        }

        getUint16(address: number): number {
            return this.view().getUint16(address, true);
        }

        getInt32(address: number): number {
            return this.view().getInt32(address, true);
        }

        setInt8(address: number, value: number): void {
            this.view().setInt8(address, value);
        }

        setInt16(address: number, value: number): void {
            this.view().setInt16(address, value, true);
        }

        setInt32(address: number, value: number): void {
            this.view().setInt32(address, value, true);
        }

        setRva(
            address: number,
            value: number | PESectionAddress,
            base: asm.Address = this
        ): void {
            if (typeof value !== "number") {
                if (value.section === null)
                    throw Error("Section is not defined");
                base = value.section;
                value = value.address;
            }
            this.setInt32(address, value);
            this.dynamicAddress.push(new AddressResolver(this, address, base));
        }

        setString(address: number, str: string): void {
            peUtil.setAscii(this.data.array, address, str);
        }

        setZero(address: number, size: number): void {
            const array = this.data.array;
            array.fill(0, address, address + size);
        }

        view(): DataView {
            const view = this._view;
            const buffer = this.data.array.buffer;
            if (view !== null && view.buffer === buffer) return view;
            return (this._view = new DataView(buffer));
        }

        partialView(address: number, size: number): DataView {
            return new DataView(this.data.array.buffer, address, size);
        }

        update(): void {
            this.setBuffer(this.data.buffer());
        }

        resolve(): void {
            for (const resolver of this.dynamicAddress) {
                resolver.resolve();
            }
            this.dynamicAddress.length = 0;
        }

        write(buffer: Uint8Array): PESectionData {
            const address = this.data.size;
            this.data.write(buffer);
            return new PESectionData(this, address, buffer.length);
        }

        prepare(size: number, align: number = 1): PESectionData {
            if (align > 1) {
                this.writeAlignPad(align);
            }
            const address = this.data.size;
            this.data.prepare(size);
            return new PESectionData(this, address, size);
        }

        writeAlignPad(align: number): void {
            align -= 1;
            const address = this.data.size;
            const nextAddr = (address + align) & ~align;
            this.data.writeZero(nextAddr - address);
        }

        writeString(str: string): PESectionData {
            const buffer = new Uint8Array(str.length + 1);
            peUtil.setAscii(buffer, 0, str);
            return this.write(buffer);
        }
    }

    export class WData extends Data {
        constructor() {
            super(
                SectionName.data,
                IMAGE_SCN_CNT_INITIALIZED_DATA |
                    IMAGE_SCN_MEM_READ |
                    IMAGE_SCN_MEM_WRITE
            );
        }
    }

    export class RData extends Data {
        constructor() {
            super(
                SectionName.rdata,
                IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ
            );
        }
    }
}
