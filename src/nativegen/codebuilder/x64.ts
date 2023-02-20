import * as ts from "typescript";
import {
    AddressedContent,
    asm,
    AsmOperand,
    Register,
    RegisterAddressedContent,
    X64Assembler,
} from "x64asm";
import { CodeBuilder, CodeFunction } from ".";
import { tshelper } from "../../tshelper";

/**
 * The DLL is being loaded into the virtual address space of the current process as a result of the process starting up or as a result of a call to LoadLibrary. DLLs can use this opportunity to initialize any instance data or to use the TlsAlloc function to allocate a thread local storage (TLS) index.
 * The lpvReserved parameter indicates whether the DLL is being loaded statically or dynamically.
 */
const DLL_PROCESS_ATTACH = 1;
/**
 * The DLL is being unloaded from the virtual address space of the calling process because it was loaded unsuccessfully or the reference count has reached zero (the processes has either terminated or called FreeLibrary one time for each time it called LoadLibrary).
 * The lpvReserved parameter indicates whether the DLL is being unloaded as a result of a FreeLibrary call, a failure to load, or process termination.
 * The DLL can use this opportunity to call the TlsFree function to free any TLS indices allocated by using TlsAlloc and to free any thread local data.
 * Note that the thread that receives the DLL_PROCESS_DETACH notification is not necessarily the same thread that received the DLL_PROCESS_ATTACH notification.
 */
const DLL_PROCESS_DETACH = 0;
/**
 * The current process is creating a new thread. When this occurs, the system calls the entry-point function of all DLLs currently attached to the process. The call is made in the context of the new thread. DLLs can use this opportunity to initialize a TLS slot for the thread. A thread calling the DLL entry-point function with DLL_PROCESS_ATTACH does not call the DLL entry-point function with DLL_THREAD_ATTACH.
 * Note that a DLL's entry-point function is called with this value only by threads created after the DLL is loaded by the process. When a DLL is loaded using LoadLibrary, existing threads do not call the entry-point function of the newly loaded DLL.
 */
const DLL_THREAD_ATTACH = 2;
/**
 * A thread is exiting cleanly. If the DLL has stored a pointer to allocated memory in a TLS slot, it should use this opportunity to free the memory. The system calls the entry-point function of all currently loaded DLLs with this value. The call is made in the context of the exiting thread.
 */
const DLL_THREAD_DETACH = 3;

class X64CodeFunction extends CodeFunction {
    constructor(
        public readonly address: asm.Address,
        public readonly parameterCount: number
    ) {
        super();
    }
}

class StackRegister {
    public register: Register | null = null;
}

class TypeParser {
    public readonly tsconfig = tshelper.parseTsConfig(null, null);
    public readonly moduleResolutionCache =
        this.tsconfig.createModuleResolutionCache();
    public readonly program: ts.Program;
    public readonly typeChecker: ts.TypeChecker;
    public readonly sourceFiles: readonly ts.SourceFile[];

    constructor(
        public readonly entryPath: string,
        public readonly builder: X64CodeBuilder
    ) {
        this.program = ts.createProgram(
            [entryPath],
            this.tsconfig.compilerOptions
        );
        this.typeChecker = this.program.getTypeChecker();
        this.sourceFiles = this.program.getSourceFiles();
    }

    resolveType(type: ts.TypeNode): NativeType {
        const typeChecker = this.typeChecker;
        const symbol = typeChecker.getSymbolAtLocation(type);
        debugger;
        if (symbol === undefined) throw Error("symbol not found");
        const resolvedType = typeChecker.getTypeOfSymbolAtLocation(
            symbol,
            type
        );
        debugger;
        throw Error("");
    }

    parse(): void {
        for (const file of this.sourceFiles) {
            if (file.isDeclarationFile) continue;
            const parser = new SourceParser(file, this);
            parser.process();
        }
    }
}

class NativeType {
    static readonly intish = new NativeType();
    static readonly int8 = new NativeType();
    static readonly int16 = new NativeType();
    static readonly int32 = new NativeType();
    static readonly int64 = new NativeType();
    static readonly float32 = new NativeType();
    static readonly float64 = new NativeType();
}

class Variable {
    constructor(public readonly type: NativeType) {}
}

class LocalVariable extends Variable {
    constructor(type: NativeType, public readonly offset: number) {
        super(type);
    }
}

class RegisterVariable extends Variable {
    constructor(type: NativeType, public readonly regsiter: Register) {
        super(type);
    }
}

class Scope {
    public readonly variables: LocalVariable[] = [];
    public readonly nameMap = new Map<string, LocalVariable>();

    constructor(public readonly parser: SourceParser) {}
    define(name: string, type: NativeType): LocalVariable {
        if (this.nameMap.has(name)) throw Error("already defined");
        throw Error("");
    }
}

function getParameterTarget(i: number): AsmOperand {
    if (i < 0) throw TypeError(`out of range ${i}`);
    switch (i) {
        case 0:
            return Register.rcx;
        case 1:
            return Register.rdx;
        case 2:
            return Register.r8;
        case 3:
            return Register.r9;
        default:
            return new RegisterAddressedContent(null, Register.rsp, 1, i * 8);
    }
}

class SourceParser {
    private readonly scopes: Scope[] = [];
    private scope = new Scope(this);

    constructor(
        public readonly source: ts.SourceFile,
        public readonly parser: TypeParser
    ) {}

    processExpression(
        preferTarget: Register | AddressedContent | null,
        exp: ts.Expression
    ): RegisterVariable {
        if (ts.isCallExpression(exp)) {
            const args = exp.arguments;
            const n = args.length;
            for (let i = 0; i !== n; i = (i + 1) | 0) {
                const target = getParameterTarget(i);
                this.processExpression(target, args[i]);
            }
        } else if (ts.isBinaryExpression(exp)) {
        }
        tshelper.dump(exp, this.source);
        throw Error("to do");
    }

    processStatement(stat: ts.Statement): void {
        if (ts.isImportDeclaration(stat)) {
            return;
        } else if (ts.isVariableStatement(stat)) {
            for (const decl of stat.declarationList.declarations) {
                if (decl.initializer !== undefined) {
                    if (ts.isIdentifier(decl.name)) {
                        const result = this.processExpression(
                            null,
                            decl.initializer
                        );
                        const stored = this.scope.define(
                            decl.name.escapedText.toString(),
                            decl.type !== undefined
                                ? this.parser.resolveType(decl.type)
                                : result.type
                        );
                        this.parser.builder.asm.mov_rp_r(
                            Register.rsp,
                            1,
                            stored.offset,
                            result.regsiter
                        );
                    } else {
                        tshelper.dump(decl.name, this.source);
                        debugger;
                    }
                }
            }
            debugger;
        } else {
            tshelper.dump(stat, this.source);
            debugger;
        }
    }

    process(): void {
        for (const stat of this.source.statements) {
            this.processStatement(stat);
        }
    }
}

export class X64CodeBuilder extends CodeBuilder {
    public readonly asm = new X64Assembler();
    private builtCode: asm.Result | null = null;

    private readonly using = new Array<boolean>(8);
    private readonly stack: StackRegister[] = [];

    constructor() {
        super();
        this.using.fill(false);
    }

    async processFile(entryPath: string): Promise<void> {
        const parser = new TypeParser(entryPath, this);
        parser.parse();
    }

    call(fn: CodeFunction): void {
        if (!(fn instanceof X64CodeFunction))
            throw TypeError(`Unexpected parameter fn=${fn.constructor.name}`);

        // this.using[Register.rcx.];
        this.asm.call_rp(fn.address, 1, 0);
    }

    build(base: number): number {
        this.builtCode = this.asm.build({
            base,
            makeRuntimeFunctionTable: true,
            doNotResolve: true,
        });
        return this.builtCode.size;
    }

    resolve(base: number, constBase: number): Uint8Array {
        if (this.builtCode === null) throw Error("code is not ready");

        this.builtCode.resolve({
            base,
            constBase,
        });
        const buffer = this.builtCode.buffer();
        this.builtCode = null;
        return buffer;
    }
}
