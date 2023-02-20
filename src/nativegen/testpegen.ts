import ts = require("typescript");
import { Register } from "x64asm";
import { fsp } from "../util/fsp";
import { PESectionAddress } from "./address";
import { X64CodeBuilder } from "./codebuilder/x64";
import { PEFile } from "./pebuilder";

const dll = new PEFile("test.dll");
const kernel32 = dll.imports
    .import("kernel32.dll")
    .imports("GetStdHandle", "WriteFile");
dll.imports.end();
dll.exports.export("test", new PESectionAddress(dll.text));

const test = dll.rdata.writeString("test");
const STD_OUTPUT_HANDLE = -11;

const code = new X64CodeBuilder();
code.asm
    .stack_c(0x38)
    .mov_r_c(Register.rcx, STD_OUTPUT_HANDLE)
    .call_rp(kernel32.GetStdHandle, 1, 0)
    .mov_rp_c(Register.rsp, 1, 0x20, 0)
    .mov_r_c(Register.r9, 0)
    .mov_r_c(Register.r8, 4)
    .lea_r_rp(Register.rdx, test, 1, 0)
    .mov_r_r(Register.rcx, Register.rax)
    .call_rp(kernel32.WriteFile, 1, 0);
dll.text.builder = code;

const exe = new PEFile("test.exe");
const testfn = exe.imports.import("test.dll").import("test");

exe.imports.end();
const execode = new X64CodeBuilder();
exe.text.builder = execode;

async function loadTs(filepath: string): Promise<void> {
    await execode.processFile(filepath);
}

(async () => {
    await loadTs(__dirname + "/testpegen_sample.ts");
    // await dll.save();
    await exe.save();
    // await peDump("dllloader.exe");
})();
