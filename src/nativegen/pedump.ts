import { BufferReader } from "bdsx-util/writer/bufferstream";
import { FileBufferReader } from "bdsx-util/writer/filereader";
import { asm } from "x64asm";
import { disasm } from "x64asm/disassembler";
import { ImageDirectoryEntryId } from "./imagedirectoryentry";
import { ImageImportDescriptor } from "./imageimportdesc";
import { PEHeader } from "./peheader";
import { peUtil } from "./peutil";
import { PESection } from "./section";

type Print = Record<string, string | number>;
function print(name: string | null, info: Print): void {
    console.log();
    if (name !== null) {
        console.log(` [ ${name} ]`);
    }
    for (const key in info) {
        const value = info[key];
        if (typeof value === "number") {
            console.log(`${key}: 0x${value.toString(16)}`);
        } else {
            console.log(`${key}: ${value}`);
        }
    }
}

class Section {
    constructor(
        public readonly index: number,
        public readonly name: string,
        public readonly virtualSize: number,
        public readonly virtualAddress: number,
        public readonly sizeOfRawData: number,
        public readonly pointerToRawData: number,
        public readonly characteristics: number,
        public readonly buffer: Uint8Array
    ) {}

    dump(): void {
        const sinfo = {
            Name: this.name,
            VirtualSize: this.virtualSize,
            VirtualAddress: this.virtualAddress,
            SizeOfRawData: this.sizeOfRawData,
            PointerToRawData: this.pointerToRawData,
            Characteristics: this.characteristics,
        };
        print(`Section ${this.index}`, sinfo);
    }
}

class PEViewer {
    public readonly header = new PEHeader();
    public readonly list: Section[] = [];
    private readonly fis: FileBufferReader;
    public readonly info = {
        SectionCount: 0,
        AddressOfEntryPoint: 0,
        ImageBase: 0,
        ImageBase2: 0,
        SizeOfHeaders: 0,
        NumberOfRvaAndSizes: 0,
    };

    constructor(filepath: string) {
        this.fis = new FileBufferReader(filepath);
    }

    async load(): Promise<void> {
        await this.header.readFromFile(this.fis);

        this.info.SectionCount = this.header.pe.getUint16(0x06, true);
        this.info.AddressOfEntryPoint = this.header.optional.getUint32(
            0x10,
            true
        );
        this.info.ImageBase = this.header.optional.getUint32(0x18, true);
        this.info.ImageBase2 = this.header.optional.getUint32(0x1c, true);
        this.info.SizeOfHeaders = this.header.optional.getUint32(0x3c, true);
        this.info.NumberOfRvaAndSizes = this.header.optional.getUint32(
            0x6c,
            true
        );

        // sections
        const count = this.info.SectionCount;
        const sectionBuffer = await this.fis.read(count * PESection.SIZE);
        const sectionView = new DataView(sectionBuffer.buffer);
        let off = 0;
        for (let i = 0; i !== count; i = (i + 1) | 0) {
            await this._add(i, sectionBuffer, sectionView, off);
            off += PESection.SIZE;
        }
    }

    dumpCode(): void {
        for (const section of this.list) {
            if (section.name !== ".text") continue;
            const code = section.buffer;
            console.log();
            console.log(` [ Section ${section.index}: Code ]`);
            const opers = disasm.process(new BufferReader(code), code.length);
            opers.strip((oper) => oper.code !== asm.code.int3);
            console.log(opers.toString());
        }
    }

    getSectionFromRva(name: string, address: number): Section | null {
        for (const section of this.list) {
            if (address < section.virtualAddress) continue;
            const raddr = address - section.virtualAddress;
            if (raddr >= section.virtualSize) continue;
            if (raddr >= section.sizeOfRawData) break;
            return section;
        }
        console.log(
            `${name} - 0x${address.toString(16)} // Address out of range`
        );
        return null;
    }

    getUint8(name: string, address: number): number {
        const section = this.getSectionFromRva(name, address);
        if (section === null) return 0;
        address -= section.virtualAddress;
        return section.buffer[address];
    }

    getUint16(name: string, address: number): number {
        const section = this.getSectionFromRva(name, address);
        if (section === null) return 0;
        address -= section.virtualAddress;
        const a = section.buffer[address++];
        const b = section.buffer[address++];
        return a | (b << 8);
    }

    getInt32(name: string, address: number): number {
        const section = this.getSectionFromRva(name, address);
        if (section === null) return 0;
        address -= section.virtualAddress;
        const a = section.buffer[address++];
        const b = section.buffer[address++];
        const c = section.buffer[address++];
        const d = section.buffer[address++];
        return a | (b << 8) | (c << 16) | (d << 24);
    }

    getUint32(name: string, address: number): number {
        return this.getInt32(name, address) >>> 0;
    }

    getString(name: string, rva: number): string {
        if (rva === 0) return "{{null}}";
        const section = this.getSectionFromRva(name, rva);
        if (section === null) return "{{invalid}}";
        return peUtil.getAscii(
            section.buffer,
            undefined,
            rva - section.virtualAddress
        );
    }

    getBuffer(name: string, address: number, size?: number): Uint8Array | null {
        const section = this.getSectionFromRva(name, address);
        if (section === null) return null;

        const raddr = address - section.virtualAddress;
        if (size === undefined) return section.buffer.subarray(raddr);
        return section.buffer.subarray(raddr, raddr + size);
    }

    private async _add(
        index: number,
        sections: Uint8Array,
        sectionView: DataView,
        off: number
    ): Promise<void> {
        const SizeOfRawData = sectionView.getUint32(off + 0x10, true); // SizeOfRawData
        const PointerToRawData = sectionView.getUint32(off + 0x14, true); // PointerToRawData

        this.fis.p = PointerToRawData;
        const buffer = await this.fis.read(SizeOfRawData);
        const section = new Section(
            index,
            peUtil.getAscii(sections, 8, off), // Name
            sectionView.getUint32(off + 0x08, true), // VirtualSize
            sectionView.getUint32(off + 0x0c, true), // VirtualAddress
            SizeOfRawData,
            PointerToRawData,
            sectionView.getInt32(off + 0x24, true), // Characteristics,
            buffer
        );
        this.list.push(section);
    }

    dumpDirectory(id: ImageDirectoryEntryId): void {
        const name = ImageDirectoryEntryId[id];
        const off = id << 3;
        const info = {
            VirtualAddress: this.header.imageDirectoryEntries.getUint32(
                off,
                true
            ),
            Size: this.header.imageDirectoryEntries.getUint32(off + 4, true),
        };
        if (info.VirtualAddress === 0 && info.Size === 0) return;
        print(`Directory ${name}`, info);
        const buffer = this.getBuffer(
            "ImportDirectory",
            info.VirtualAddress,
            info.Size
        );
        if (buffer === null) return;
        switch (id) {
            case ImageDirectoryEntryId.IMPORT:
                this._dumpImportDirectory(buffer);
                break;
            case ImageDirectoryEntryId.EXPORT:
                this._dumpExportDirectory(buffer);
                break;
        }
    }

    private _dumpImportDirectory(buffer: Uint8Array): void {
        if (buffer === null) return;
        const view = new DataViewFromBuffer(buffer);
        let off = 0;
        for (; off < buffer.length; off += ImageImportDescriptor.SIZE) {
            const name = view.getInt32(off + 0x0c, true);
            const dllInfo = {
                OriginalFirstThunk: view.getInt32(off + 0x00, true),
                TimeDateStamp: view.getInt32(off + 0x04, true),
                ForwarderChain: view.getInt32(off + 0x08, true),
                FirstThunk: view.getInt32(off + 0x10, true),
            };
            if (name === 0) {
                for (const key in dllInfo) {
                    const value = dllInfo[key as keyof typeof dllInfo];
                    if (value !== 0) {
                        console.log(
                            `Invalid ${key}: 0x${value}, but name is null`
                        );
                    }
                }
                console.log();
                console.log(" [ Directory IMPORT End ] ");
            } else {
                print(
                    "Directory IMPORT: " + this.getString("Import Name", name),
                    dllInfo
                );
                const originalFirstThunk = this.getBuffer(
                    "OriginalFirstThunk",
                    dllInfo.OriginalFirstThunk
                );
                if (originalFirstThunk === null) continue;
                const firstThunk = this.getBuffer(
                    "FirstThunk",
                    dllInfo.FirstThunk
                );
                if (firstThunk === null) continue;

                const firstThunkView = new DataViewFromBuffer(firstThunk);
                const originalFirstThunkView = new DataViewFromBuffer(
                    firstThunk
                );
                let off = 0;
                for (;;) {
                    const a = firstThunkView.getInt32(off, true);
                    const b = originalFirstThunkView.getInt32(off, true);
                    if (a !== b) {
                        console.log(
                            `address mismatch (0x${a.toString(
                                16
                            )} !== 0x${b.toString(16)})`
                        );
                    }
                    off += 8;
                    if (a === 0 || b === 0) break;
                    const hint = this.getUint16("ImportFunctionHint", a);
                    const fnname = this.getString("ImportFunctionName", a + 2);
                    if (fnname !== null) {
                        console.log(`> ${fnname}(${hint})`);
                    }
                }
            }
        }
    }

    private _dumpExportDirectory(buffer: Uint8Array): void {
        if (buffer === null) return;
        const view = new DataViewFromBuffer(buffer);
        const name = view.getInt32(0x0c, true);
        const dllInfo = {
            Characteristics: view.getInt32(0x00, true),
            TimeDateStamp: view.getInt32(0x04, true),
            MajorVersion: view.getInt16(0x08, true),
            MinorVersion: view.getInt16(0x0a, true),
            Base: view.getInt32(0x10, true),
            NumberOfFunctions: view.getInt32(0x14, true),
            NumberOfNames: view.getInt32(0x18, true),
            AddressOfFunctions: view.getInt32(0x1c, true),
            AddressOfNames: view.getInt32(0x20, true),
            AddressOfNameOrdinals: view.getInt32(0x24, true),
        };
        if (dllInfo.Characteristics !== 0) {
            console.log("Unexpected Characteristics");
        }
        if (dllInfo.Base !== 1) {
            console.log("Unexpected Base");
        }
        print(
            `Directory EXPORT: ${this.getString("Export Name", name)}`,
            dllInfo
        );
        const exportAddressTable = this.getBuffer(
            "AddressOfFunctions",
            dllInfo.AddressOfFunctions
        );
        const namePointer = this.getBuffer(
            "AddressOfNames",
            dllInfo.AddressOfNames
        );
        const ordinalTable = this.getBuffer(
            "AddressOfNameOrdinals",
            dllInfo.AddressOfNameOrdinals
        );
        if (
            exportAddressTable === null ||
            namePointer === null ||
            ordinalTable === null
        )
            return;
        const exportAddressTableView = new DataViewFromBuffer(
            exportAddressTable
        );
        const namePointerView = new DataViewFromBuffer(namePointer);
        const ordinalTableView = new DataViewFromBuffer(ordinalTable);
        for (let i = 0; i !== dllInfo.NumberOfNames; i = (i + 1) | 0) {
            const nameRva = namePointerView.getInt32(i << 2, true);
            const index = ordinalTableView.getUint16(i << 1, true);
            const ordinal = index + dllInfo.Base;
            const fnName = this.getString("FunctionName", nameRva);
            const funcAddr = exportAddressTableView.getInt32(index << 2, true);
            const section = this.getSectionFromRva(fnName, funcAddr);
            if (section === null) continue;
            if (section.name !== ".text") {
                // forwarder
                console.log(
                    `> ${fnName}(${ordinal}): ${this.getString(
                        fnName,
                        funcAddr
                    )}`
                );
            } else {
                console.log(
                    `> ${fnName}(${ordinal}): 0x${(funcAddr >>> 0).toString(
                        16
                    )}`
                );
            }
        }
    }

    dumpAll(): void {
        print("PE", this.info);
        for (const section of this.list) {
            section.dump();
        }

        for (let i = 0; i !== this.info.NumberOfRvaAndSizes; i = (i + 1) | 0) {
            this.dumpDirectory(i);
        }
    }

    close(): Promise<void> {
        return this.fis.close();
    }
}

class DataViewFromBuffer extends DataView {
    constructor(buffer: Uint8Array) {
        super(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
}

export async function peDump(filepath: string): Promise<void> {
    const peViewer = new PEViewer(filepath);
    await peViewer.load();
    peViewer.dumpAll();
    await peViewer.close();
}
