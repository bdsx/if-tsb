import { asm } from "x64asm";
import { PESection } from "./section";

export class PESectionAddressT<T extends PESection> implements asm.Address {
    constructor(public section: T | null, public address: number = 0) {}

    getAddress(): number {
        if (this.section === null) throw Error("section is not resolved");
        return this.section.getAddress() + this.address;
    }
}

export class PESectionAddress extends PESectionAddressT<PESection> {}

export class PEDataSectionAddress extends PESectionAddressT<PESection.Data> {
    writer(): PESectionWriter {
        if (this.section === null) throw Error("section is not resolved");
        return new PESectionWriter(this.section, this.address);
    }
}

export class PESectionWriter {
    constructor(
        public readonly section: PESection.Data,
        public address: number
    ) {}

    writeInt8(n: number): void {
        this.section.setInt8(this.address++, n);
    }

    writeInt16(n: number): void {
        this.section.setInt16(this.address, n);
        this.address += 2;
    }

    writeInt32(n: number): void {
        this.section.setInt32(this.address, n);
        this.address += 4;
    }

    writeRva(address: number | PESectionAddress): void {
        this.section.setRva(this.address, address);
        this.address += 4;
    }

    writeString(str: string): void {
        this.section.setString(this.address, str);
        this.address += str.length + 1;
    }
}

export class AddressResolver extends PEDataSectionAddress {
    constructor(
        section: PESection.Data,
        address: number,
        public readonly base: asm.Address
    ) {
        super(section, address);
    }

    getRva(): number {
        if (this.section === null) throw Error("section is null");
        const base = this.base.getAddress();
        const offset = this.section.getInt32(this.address);
        const rva = (base + offset) | 0;
        if (rva < 0)
            throw Error(`int32 overflow (base=${base}, offset=${offset})`);
        return rva;
    }

    resolve(): void {
        if (this.section === null) throw Error("section is null");
        const rva = this.getRva();
        this.section.setInt32(this.address, rva);
    }
}

export class PESectionData extends PEDataSectionAddress {
    constructor(
        section: PESection.Data | null = null,
        address: number = 0,
        public size: number = 0
    ) {
        super(section, address);
    }
    set(other: PESectionData) {
        this.section = other.section;
        this.address = other.address;
        this.size = other.size;
    }

    view(): DataView {
        if (this.section === null) return new DataView(new ArrayBuffer(0));
        return this.section.partialView(this.address, this.size);
    }

    subarray(begin?: number, end?: number): PESectionData {
        if (begin === undefined) begin = this.address;
        else begin += this.address;
        if (end === undefined) end = this.address + this.size;
        else end += this.address;
        if (end > this.size) throw Error(`out of range: ${end}`);
        const size = end - begin;
        return new PESectionData(this.section, begin, size);
    }
}
