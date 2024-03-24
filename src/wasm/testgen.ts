import { Wasm } from "./wasm";

const wasm = new Wasm();
const func = wasm.createFunction([Wasm.i32], [Wasm.i32]);
wasm.export("sum", func);

const buf = wasm.generate();
WebAssembly.compile(Buffer.concat(buf));
