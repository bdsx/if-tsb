import ts = require("typescript");
import { tshelper } from "./tshelper";

export interface BundlerOptions {
    clearConsole?: boolean;
    verbose?: boolean;
    checkCircularDependency?: boolean;
    suppressDynamicImportErrors?: boolean;
    suppressModuleNotFoundErrors?: boolean;
    faster?: boolean;
    watchWaiting?: number;
    globalModuleVarName?: string;
    bundleExternals?: boolean | string[];
    browser?: boolean;
    externals?: string[];
    module?: string;
    preimport?: string[];
    concurrency?: number;
    exportLib?: boolean;
    noSourceMapWorker?: boolean;
    wrapBegin?: string;
    wrapEnd?: string;
    declWrapBegin?: string;
    declWrapEnd?: string;
}

export enum ExportRule {
    None,
    CommonJS,
    ES2015,
    Var,
    Direct,
    Private,
}

export enum IfTsbError {
    InternalError = 20000,
    Unsupported = 20001,
    JsError = 20002,
    Dupplicated = 20003,
    WrongUsage = 20004,
    TooSlow = 20005,
    ModuleNotFound = 2307,
}

export interface OutputOptions {
    output: string;
    bundlerOptions?: BundlerOptions;
    compilerOptions?: ts.CompilerOptions;
}

export interface TsConfig extends tshelper.TsConfigJson {
    exclude?: string[];
    include?: string[];
    entry?: string[] | Record<string, string | OutputOptions> | string;
    output?: string | null;
    import?: string[];

    bundlerOptions?: BundlerOptions;

    /**
     * compiler option override.
     * if not define it, it will load [cwd]/tsconfig.json
     */
    compilerOptions?: ts.CompilerOptions;
}

export enum ExternalMode {
    NoExternal,
    Manual,
    Preimport,
}
