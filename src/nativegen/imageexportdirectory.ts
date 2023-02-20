import { PESectionAddress, PESectionData } from "./address";
import { PESection } from "./section";
import type { PEFile } from "./pebuilder";
import * as path from "path";

const imageExportDirectory = new Uint8Array([
    0x00, 0x00, 0x00, 0x00,
    // Characteristics
    0x00, 0x00, 0x00, 0x00,
    // TimeDateStamp
    0x00, 0x00,
    // MajorVersion
    0x00, 0x00,
    // MinorVersion
    0x00, 0x00, 0x00, 0x00,
    // Name
    0x00, 0x00, 0x00, 0x00,
    // Base
    0x00, 0x00, 0x00, 0x00,
    // NumberOfFunctions
    0x00, 0x00, 0x00, 0x00,
    // NumberOfNames
    0x00, 0x00, 0x00, 0x00,
    // AddressOfFunctions     // RVA from base of image
    0x00, 0x00, 0x00, 0x00,
    // AddressOfNames     // RVA from base of image
    0x00, 0x00, 0x00, 0x00,
    // AddressOfNameOrdinals  // RVA from base of image
]);

export class ImageExportDirectory {
    public majorVersion = 0;
    public minorVersion = 0;

    private ended: PESectionData | null = null;
    private readonly functions: [string, PESectionAddress][] = [];
    public readonly rdata: PESection.RData;

    constructor(public readonly pe: PEFile) {
        this.rdata = pe.rdata;
    }

    empty(): boolean {
        return this.ended === null && this.functions.length === 0;
    }

    isEnded(): boolean {
        return this.ended !== null;
    }

    export(name: string, address: PESectionAddress): void {
        if (this.ended !== null) throw Error("already ended");
        if (this.functions.length >= 0xffff) throw Error("too many exports");
        this.functions.push([name, address]);
    }

    end(): PESectionData {
        if (this.ended !== null) return this.ended;

        const table = this.rdata.prepare(imageExportDirectory.length, 8);
        const writer = table.writer();
        const functions = this.rdata
            .prepare(this.functions.length << 2, 8)
            .writer();
        const names = this.rdata
            .prepare(this.functions.length << 2, 8)
            .writer();
        const ordinals = this.rdata
            .prepare(this.functions.length << 1, 8)
            .writer();

        writer.address += 4; // Characteristics
        writer.writeInt32(this.pe.timestamp);
        writer.writeInt16(this.majorVersion);
        writer.writeInt16(this.minorVersion);
        writer.writeRva(
            this.rdata.writeString(path.basename(this.pe.filePath))
        ); // Name
        writer.writeInt32(1); // Base
        writer.writeInt32(this.functions.length); // NumberOfFunctions
        writer.writeInt32(this.functions.length); // NumberOfNames
        writer.writeRva(functions.address); // AddressOfFunctions
        writer.writeRva(names.address); // AddressOfNames
        writer.writeRva(ordinals.address); // AddressOfNameOrdinals

        let ordinal = 0;
        for (const [name, address] of this.functions) {
            functions.writeRva(address);
            names.writeRva(this.rdata.writeString(name));
            ordinals.writeInt16(ordinal++);
        }
        return (this.ended = table);
    }
}
