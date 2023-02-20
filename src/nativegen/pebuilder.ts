import { FileBufferWriter } from "bdsx-util/writer/filewriter";
import * as path from "path";
import {
    ImageDirectoryEntry,
    ImageDirectoryEntryId,
} from "./imagedirectoryentry";
import { ImageExportDirectory } from "./imageexportdirectory";
import { ImageImportDescriptorList } from "./imageimportdesc";
import { PEHeader } from "./peheader";
import { peUtil } from "./peutil";
import { PESection } from "./section";

const LINKER_VERSION_MAJOR = 0;
const LINKER_VERSION_MINOR = 0;

const IMAGE_FILE_RELOCS_STRIPPED = 0x0001; // Relocation information was stripped from the file. The file must be loaded at its preferred base address. If the base address is not available, the loader reports an error.
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002; // The file is executable (there are no unresolved external references).
const IMAGE_FILE_LINE_NUMS_STRIPPED = 0x0004; // COFF line numbers were stripped from the file.
const IMAGE_FILE_LOCAL_SYMS_STRIPPED = 0x0008; // COFF symbol table entries were stripped from file.
const IMAGE_FILE_AGGRESIVE_WS_TRIM = 0x0010; // Aggressively trim the working set. This value is obsolete.
const IMAGE_FILE_LARGE_ADDRESS_AWARE = 0x0020; // The application can handle addresses larger than 2 GB.
const IMAGE_FILE_BYTES_REVERSED_LO = 0x0080; // The bytes of the word are reversed. This flag is obsolete.
const IMAGE_FILE_32BIT_MACHINE = 0x0100; // The computer supports 32-bit words.
const IMAGE_FILE_DEBUG_STRIPPED = 0x0200; // Debugging information was removed and stored separately in another file.
const IMAGE_FILE_REMOVABLE_RUN_FROM_SWAP = 0x0400; // If the image is on removable media, copy it to and run it from the swap file.
const IMAGE_FILE_NET_RUN_FROM_SWAP = 0x0800; // If the image is on the network, copy it to and run it from the swap file.
const IMAGE_FILE_SYSTEM = 0x1000; // The image is a system file.
const IMAGE_FILE_DLL = 0x2000; // The image is a DLL file. While it is an executable file, it cannot be run directly.
const IMAGE_FILE_UP_SYSTEM_ONLY = 0x4000; // The file should be run only on a uniprocessor computer.
const IMAGE_FILE_BYTES_REVERSED_HI = 0x8000; // The bytes of the word are reversed. This flag is obsolete.

const IMAGE_DLL_CHARACTERISTICS_HIGH_ENTROPY_VA = 0x0020; // ASLR with 64 bit address space.
const IMAGE_DLL_CHARACTERISTICS_DYNAMIC_BASE = 0x0040; // The DLL can be relocated at load time.
const IMAGE_DLL_CHARACTERISTICS_FORCE_INTEGRITY = 0x0080; // Code integrity checks are forced. If you set this flag and a section contains only uninitialized data, set the PointerToRawData member of const IMAGE_SECTION_HEADER for that section to zero; otherwise, the image will fail to load because the digital signature cannot be verified. = const IMAGE_DLLCHARACTERISTICS_NX_COMPAT = 0x0100; // The image is compatible with data execution prevention (DEP).
const IMAGE_DLL_CHARACTERISTICS_NX_COMPAT = 0x0100;
const IMAGE_DLL_CHARACTERISTICS_NO_ISOLATION = 0x0200; // The image is isolation aware, but should not be isolated.
const IMAGE_DLL_CHARACTERISTICS_NO_SEH = 0x0400; // The image does not use structured exception handling (SEH). No handlers can be called in this image.
const IMAGE_DLL_CHARACTERISTICS_NO_BIND = 0x0800; // Do not bind the image.
const IMAGE_DLL_CHARACTERISTICS_APPCONTAINER = 0x1000; // Image should execute in an AppContainer.
const IMAGE_DLL_CHARACTERISTICS_WDM_DRIVER = 0x2000; // A WDM driver.
const IMAGE_DLL_CHARACTERISTICS_GUARD_CF = 0x4000; // Image supports Control Flow Guard.
const IMAGE_DLL_CHARACTERISTICS_TERMINAL_SERVER_AWARE = 0x8000; // The image is terminal server aware.

class AddressCalc {
    public file: number;
    public virtual: number;
    constructor(sizeOfHeader: number) {
        this.file = peUtil.fileAlign(sizeOfHeader);
        this.virtual = peUtil.sectionAlign(sizeOfHeader);
    }

    next(size: number): void {
        const raddr = peUtil.fileAlign(this.file + size) | 0;
        const vaddr = peUtil.sectionAlign(this.virtual + size) | 0;
        if (raddr < 0 || vaddr < 0) {
            throw Error(
                `int32 overflow (rawAddress=${this.file}, virtualAddress=${this.virtual}, section.size=${size})`
            );
        }
        this.file = raddr;
        this.virtual = vaddr;
    }
}

export class PEFile {
    public readonly text = new PESection.Text();
    public readonly rdata = new PESection.RData();
    public readonly dataDirectories = new Array<ImageDirectoryEntry>(16);
    public readonly imports = new ImageImportDescriptorList(this.rdata);
    public readonly exports = new ImageExportDirectory(this);
    public readonly timestamp = Math.floor(Date.now() / 1000);

    constructor(public readonly filePath: string) {
        if (this.timestamp > 0xffffffff)
            throw Error(
                `timestamp is too big: 0x${this.timestamp.toString(16)}`
            );
        for (let i = 0; i !== this.dataDirectories.length; i = (i + 1) | 0) {
            this.dataDirectories[i] = new ImageDirectoryEntry();
        }
    }

    async save(): Promise<void> {
        const sections = [this.text, this.rdata];
        const sectionCount = sections.length;
        if (sectionCount > 0xffff)
            throw Error(
                `sections are too many: 0x${sectionCount.toString(16)}`
            );

        let characteristics: number;
        let dllCharacteristics: number;
        let imageBase: number;

        if (path.extname(this.filePath).toLowerCase() === ".dll") {
            imageBase = 0x180000000;
            characteristics =
                IMAGE_FILE_DLL |
                IMAGE_FILE_LARGE_ADDRESS_AWARE |
                IMAGE_FILE_EXECUTABLE_IMAGE;
            dllCharacteristics =
                IMAGE_DLL_CHARACTERISTICS_HIGH_ENTROPY_VA |
                IMAGE_DLL_CHARACTERISTICS_DYNAMIC_BASE |
                IMAGE_DLL_CHARACTERISTICS_NX_COMPAT;
        } else {
            imageBase = 0x140000000;
            characteristics =
                IMAGE_FILE_LARGE_ADDRESS_AWARE | IMAGE_FILE_EXECUTABLE_IMAGE;
            dllCharacteristics =
                IMAGE_DLL_CHARACTERISTICS_HIGH_ENTROPY_VA |
                IMAGE_DLL_CHARACTERISTICS_DYNAMIC_BASE |
                IMAGE_DLL_CHARACTERISTICS_APPCONTAINER |
                IMAGE_DLL_CHARACTERISTICS_TERMINAL_SERVER_AWARE;
        }
        const sizeOfHeadersFit = sectionCount * PESection.SIZE + PEHeader.SIZE;
        const sizeOfHeaders = peUtil.fileAlign(sizeOfHeadersFit);

        if (!this.imports.empty()) {
            const iid = this.imports.end();
            this.dataDirectories[ImageDirectoryEntryId.IMPORT].set(iid);
        }
        if (!this.exports.empty()) {
            const eat = this.exports.end();
            this.dataDirectories[ImageDirectoryEntryId.EXPORT].set(eat);
        }

        const sectionAddr = new AddressCalc(sizeOfHeaders);

        // build code
        let sizeOfCode = 0;
        this.text.pointerToRawData = sectionAddr.file;
        this.text.virtualAddress = sectionAddr.virtual;
        this.text.build();
        sizeOfCode += this.text.dataSize;
        sectionAddr.next(this.text.dataSize);

        // resolve section address
        let sizeOfInitializedData = sizeOfCode;
        this.rdata.pointerToRawData = sectionAddr.file;
        this.rdata.virtualAddress = sectionAddr.virtual;
        this.rdata.update();
        sizeOfInitializedData += this.rdata.dataSize;
        sectionAddr.next(this.rdata.dataSize);
        const sizeOfImage = sectionAddr.virtual;

        // resolve
        this.rdata.resolve();
        this.text.resolve(this.rdata, null);

        // writing buffer
        const peHeader = new PEHeader();
        peHeader.pe.setUint16(0x06, sectionCount, true);
        peHeader.pe.setUint32(0x08, this.timestamp, true);
        peHeader.pe.setUint16(0x16, characteristics, true);
        peHeader.optional.setUint8(0x02, LINKER_VERSION_MAJOR);
        peHeader.optional.setUint8(0x03, LINKER_VERSION_MINOR);
        peHeader.optional.setUint32(0x04, sizeOfCode, true);
        peHeader.optional.setUint32(0x08, sizeOfInitializedData, true);
        peHeader.optional.setUint32(0x10, this.text.virtualAddress, true);
        peHeader.optional.setUint32(0x18, imageBase % 0x100000000, true);
        peHeader.optional.setUint32(
            0x1c,
            Math.floor(imageBase / 0x100000000),
            true
        );
        peHeader.optional.setUint32(0x20, peUtil.SECTION_ALIGNMENT, true);
        peHeader.optional.setUint32(0x24, peUtil.FILE_ALIGNMENT, true);

        peHeader.optional.setUint32(0x38, sizeOfImage, true);
        peHeader.optional.setUint32(0x3c, sizeOfHeaders, true);
        peHeader.optional.setUint16(0x46, dllCharacteristics, true);

        for (let i = 0; i !== this.dataDirectories.length; i = (i + 1) | 0) {
            this.dataDirectories[i].writeTo(peHeader, i);
        }

        // writing file
        const writer = new FileBufferWriter(this.filePath);
        await writer.write(peHeader.buffer);
        for (const section of sections) {
            await section.writeHeaderTo(writer);
        }
        await writer.write(new Uint8Array(sizeOfHeaders - sizeOfHeadersFit));
        for (const section of sections) {
            await section.writeContentTo(writer);
        }
        await writer.end();
    }
}

// async function checksum(data:Uint8Array, checksumOffset:number):number {
//     let checksum = 0;
//     const top = Math.pow(2, 32);

//     for (let i = 0; i < checksumOffset >> 2; i=i+1|0) {
//         let temp = data[i];
//         checksum = (checksum & 0xffffffff) + temp + (checksum >> 32);
//         if (checksum > top) {
//             checksum = (checksum & 0xffffffff) + (checksum >> 32);
//         }
//     }

//     let stop = data.length >> 2;
//     for (let i = (checksumOffset >> 2)+ 1; i < stop; i++) {
//         let temp = data[i];
//         checksum = (checksum & 0xffffffff) + temp + (checksum >> 32);
//         if (checksum > top) {
//             checksum = (checksum & 0xffffffff) + (checksum >> 32);
//         }
//     }

//     //Perform the same calculation on the padded remainder
//     let remainder = data.Length % 4;
//     if (remainder !== 0) {
//         cli::array<Byte>^ a = gcnew cli::array<Byte>(4);
//         let index = data.Length - remainder;
//         for (let i = 0; i < 4; i++) {
//             if (i < remainder) {
//                 a[i] = data[data.Length - remainder + i];
//             }
//             else {
//                 a[i] = 0;
//             }
//         }
//         pin_ptr<unsigned char> pin2 = &a[0];
//         let* pointer2 = (let*)pin2;

//         unsigned int temp = pointer2[0];
//         checksum = (checksum & 0xffffffff) + temp + (checksum >> 32);
//         if (checksum > top) {
//             checksum = (checksum & 0xffffffff) + (checksum >> 32);
//         }
//     }

//     checksum = (checksum & 0xffff) + (checksum >> 16);
//     checksum = (checksum)+(checksum >> 16);
//     checksum = checksum & 0xffff;

//     checksum += data.length;

//     return checksum;
// }
