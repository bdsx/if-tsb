import { asm } from "x64asm";
import { PESectionData, PESectionWriter } from "./address";
import { PESection } from "./section";

export class ImageNameTableEntry {
    constructor(
        public readonly address: FunctionAddress,
        public readonly name: string,
        public readonly hint = 0
    ) {}

    /**
     * @return written address
     */
    writeTo(rdata: PESection.RData): PESectionData {
        const data = rdata.prepare(this.name.length + 3, 2);
        const writer = data.writer();
        writer.writeInt16(this.hint);
        writer.writeString(this.name);
        return data;
    }
}

export class FunctionAddress implements asm.Address {
    constructor(
        public readonly base: ImageImportDescriptor,
        public readonly offset: number
    ) {}

    getAddress(): number {
        return this.base.getAddress() + this.offset;
    }
}

export class ImageImportDescriptor implements asm.Address {
    public readonly table: ImageNameTableEntry[] = [];
    public tableAddress = -1;
    public static readonly SIZE = 0x14;

    constructor(
        public readonly list: ImageImportDescriptorList,
        public readonly dllName: string
    ) {}

    getAddress(): number {
        if (this.tableAddress === -1)
            throw Error("tableAddress is not resolved");
        return this.list.rdata.getAddress() + this.tableAddress;
    }

    import(fnName: string): FunctionAddress {
        if (this.list.isEnded()) throw Error("already ended");

        for (const name of this.table) {
            if (name.name === fnName) return name.address;
        }
        const nextTable = this.table.length << 3;
        const fnaddr = new FunctionAddress(this, nextTable);
        const name = new ImageNameTableEntry(fnaddr, fnName);
        this.table.push(name);
        return fnaddr;
    }

    imports<T extends string>(...fnNames: T[]): Record<T, FunctionAddress> {
        const out = {} as Record<T, FunctionAddress>;
        for (const name of fnNames) {
            out[name] = this.import(name);
        }
        return out;
    }

    writeTo(
        iidWriter: PESectionWriter,
        addressTableWriter: PESectionWriter,
        nameTableWriter: PESectionWriter
    ): void {
        this.tableAddress = addressTableWriter.address;
        const rdata = this.list.rdata;
        const dllName = rdata.writeString(this.dllName);

        iidWriter.writeRva(nameTableWriter.address); // OriginalFirstThunk
        // 0x04, TimeDateStamp
        // 0x08, ForwarderChain
        iidWriter.address += 8;
        iidWriter.writeRva(dllName); // Name
        iidWriter.writeRva(addressTableWriter.address); // FirstThunk

        for (const name of this.table) {
            const nameData = name.writeTo(rdata);
            addressTableWriter.writeRva(nameData);
            addressTableWriter.address += 4;
            nameTableWriter.writeRva(nameData);
            nameTableWriter.address += 4;
        }
        addressTableWriter.address += 8;
        nameTableWriter.address += 8;
    }
}

export class ImageImportDescriptorList
    implements Iterable<ImageImportDescriptor>
{
    private ended: PESectionData | null = null;
    private readonly array: ImageImportDescriptor[] = [];

    constructor(public readonly rdata: PESection.RData) {}

    [Symbol.iterator](): IterableIterator<ImageImportDescriptor> {
        return this.array.values();
    }

    empty(): boolean {
        return this.ended === null && this.array.length === 0;
    }

    import(dllName: string): ImageImportDescriptor {
        if (this.ended !== null) throw Error("already ended");

        for (const item of this.array) {
            if (item.dllName === dllName) return item;
        }
        const iid = new ImageImportDescriptor(this, dllName);
        this.array.push(iid);
        return iid;
    }

    isEnded(): boolean {
        return this.ended !== null;
    }

    end(): PESectionData {
        if (this.ended !== null) return this.ended;

        const iidArraySize =
            this.array.length * ImageImportDescriptor.SIZE +
            ImageImportDescriptor.SIZE;
        let namesArraySize = 0;
        for (const iid of this.array) {
            namesArraySize += (iid.table.length << 3) + 0x10; // 8bytes table + null
        }

        const addressTableBuf = this.rdata.prepare(namesArraySize, 8);
        const nameTableBuf = this.rdata.prepare(namesArraySize, 8);
        const iidBuf = this.rdata.prepare(iidArraySize, 4);
        const addressTableWriter = addressTableBuf.writer();
        const nameTableWriter = nameTableBuf.writer();
        const iidWriter = iidBuf.writer();
        for (const iid of this.array) {
            iid.writeTo(iidWriter, addressTableWriter, nameTableWriter);
        }
        return (this.ended = iidBuf);
    }
}
