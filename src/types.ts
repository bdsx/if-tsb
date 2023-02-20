import ts = require("typescript");
import { tshelper } from "./tshelper";

export interface BundlerOptions {
    clearConsole?: boolean;
    verbose?: boolean;
    checkCircularDependency?: boolean;
    suppressDynamicImportErrors?: boolean;
    faster?: boolean;
    watchWaiting?: number;
    globalModuleVarName?: string;
    bundleExternals?: boolean;
    externals?: string[];
    cacheMemory?: number | string;
    module?: string;
    preimport?: string[];
    concurrency?: number;
    exportLib?: boolean;
    noSourceMapWorker?: boolean;
}

export enum ExportRule {
    None,
    CommonJS,
    ES2015,
    Var,
    Direct,
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

export interface BundlerOptionsWithOutput extends BundlerOptions {
    output?: string;
}

export interface TsConfig extends tshelper.TsConfigJson {
    exclude?: string[];
    include?: string[];
    entry?:
        | string[]
        | Record<string, string | BundlerOptionsWithOutput>
        | string;
    output?: string | null;

    bundlerOptions?: BundlerOptions;

    /**
     * compiler option override.
     * if not define it, it will load [cwd]/tsconfig.json
     */
    compilerOptions?: ts.CompilerOptions;
}

export enum ExternalMode {
    NoExternal = 0,
    Manual = -1,
    Preimport = -2,
}
