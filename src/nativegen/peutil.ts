import { FileBufferWriter } from "bdsx-util/writer/filewriter";

export namespace peUtil {
    export const FILE_ALIGNMENT = 0x200;
    export const SECTION_ALIGNMENT = 0x1000;

    export function setAscii(
        buffer: Uint8Array,
        offset: number,
        text: string,
        length?: number
    ): number {
        let n = text.length;
        if (length !== undefined && length < n) {
            n = length;
        }
        for (let i = 0; i !== n; i = (i + 1) | 0) {
            buffer[offset] = text.charCodeAt(i);
            offset = (offset + 1) | 0;
        }
        if (length !== undefined) {
            for (let i = 0; i !== length; i = (i + 1) | 0) {
                buffer[offset] = 0;
                offset = (offset + 1) | 0;
            }
        }
        return offset;
    }
    export function getAscii(
        buffer: Uint8Array,
        length?: number,
        offset: number = 0
    ): string {
        if (length !== undefined) length += offset;
        else length = buffer.length;

        for (let i = offset; i !== length; i = (i + 1) | 0) {
            if (buffer[i] === 0) {
                length = i;
                break;
            }
        }
        return String.fromCharCode.apply(
            String,
            buffer.subarray(offset, length)
        );
    }
    export function align4(value: number): number {
        return ((value + 3) >> 2) << 2;
    }
    export function fileAlign(value: number): number {
        return Math.ceil(value / FILE_ALIGNMENT) * FILE_ALIGNMENT;
    }
    export function sectionAlign(value: number): number {
        return Math.ceil(value / SECTION_ALIGNMENT) * SECTION_ALIGNMENT;
    }
    export async function writeBufferWithPad(
        writer: FileBufferWriter,
        buffer: Uint8Array,
        total: number,
        padValue: number
    ): Promise<void> {
        const n = buffer.length;
        if (n > total) throw Error("buffer is large");
        await writer.write(buffer);

        const pads = total - n;
        if (pads > 0) {
            const buffer = new Uint8Array(pads);
            if (padValue !== 0) buffer.fill(padValue);
            await writer.write(buffer);
        }
    }
}
