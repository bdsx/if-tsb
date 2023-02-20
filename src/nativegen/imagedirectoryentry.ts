import { PESectionData } from "./address";
import { PEHeader } from "./peheader";

export class ImageDirectoryEntry extends PESectionData {
    writeTo(peHeader: PEHeader, id: ImageDirectoryEntryId): void {
        const offset = id << 3;
        if (this.section === null) {
            peHeader.imageDirectoryEntries.setInt32(offset, 0, true);
            peHeader.imageDirectoryEntries.setInt32(offset + 4, 0, true);
        } else {
            peHeader.imageDirectoryEntries.setInt32(
                offset,
                this.section.virtualAddress + this.address,
                true
            );
            peHeader.imageDirectoryEntries.setInt32(
                offset + 4,
                this.size,
                true
            );
        }
    }
}

export enum ImageDirectoryEntryId {
    EXPORT = 0, // Export Directory
    IMPORT = 1, // Import Directory
    RESOURCE = 2, // Resource Directory
    EXCEPTION = 3, // Exception Directory
    SECURITY = 4, // Security Directory
    BASERELOC = 5, // Base Relocation Table
    DEBUG = 6, // Debug Directory
    ARCHITECTURE = 7, // Architecture Specific Data
    GLOBALPTR = 8, // RVA of GP
    TLS = 9, // TLS Directory
    LOAD_CONFIG = 10, // Load Configuration Directory
    BOUND_IMPORT = 11, // Bound Import Directory in headers
    IAT = 12, // Import Address Table
    DELAY_IMPORT = 13, // Delay Load Import Descriptors
    COM_DESCRIPTOR = 14, // COM Runtime descriptor
}
