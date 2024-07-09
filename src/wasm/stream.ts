export class BufferStream {
    private buf = new Uint8Array(64);

    private size = 0;

    reset() {
        this.size = 0;
    }

    writeBuffer(val: Uint8Array) {
        const cap = this.buf.length;
        const nsize = this.size + val.length;
        if (nsize > cap) {
            const buf = new Uint8Array(Math.max(cap * 2, nsize));
            buf.set(this.buf);
            this.buf = buf;
        }
        this.buf.set(val, this.size);
        this.size = nsize;
    }

    i8(val: number) {
        const cap = this.buf.length;
        if (this.size >= cap) {
            const buf = new Uint8Array(cap * 2);
            buf.set(this.buf);
            this.buf = buf;
        }
        this.buf[this.size++] = val;
    }

    leb128(val: number) {
        while (val >= 0x80) {
            this.i8(val & 0x7f);
            val >>= 7;
        }
        this.i8(val);
    }

    string(val: string) {
        const enc = new TextEncoder();
        const buf = enc.encode(val);
        this.leb128(buf.length);
        this.writeBuffer(buf);
    }

    buffer() {
        return this.buf.subarray(0, this.size);
    }

    write(buf: BufferWritable) {
        buf.writeTo(this);
    }

    writeArray(bufs: BufferWritable[]) {
        this.leb128(bufs.length);
        for (const buf of bufs) {
            buf.writeTo(this);
        }
    }

    writeSet(bufs: Set<BufferWritable>) {
        this.leb128(bufs.size);
        for (const buf of bufs) {
            buf.writeTo(this);
        }
    }

    writeMapValue(bufs: Map<unknown, BufferWritable>) {
        this.leb128(bufs.size);
        for (const buf of bufs.values()) {
            buf.writeTo(this);
        }
    }
}

export interface BufferWritable {
    writeTo(s: BufferStream): void;
}
