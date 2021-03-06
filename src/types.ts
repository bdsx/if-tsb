import ts = require("typescript");

export interface BundlerOptions
{
    clearConsole?:boolean;
    verbose?:boolean;
    checkCircularDependency?:boolean;
    suppressDynamicImportErrors?:boolean;
    faster?:boolean;
    watchWaiting?:number;
    globalModuleVarName?:string;
    bundleExternals?:boolean;
    externals?:string[];
    cacheMemory?:number|string;
    module?:string;
    preimport?:string[];
    concurrency?:number;
    exportLib?:boolean;
}

export enum ExportRule
{
    None,
    CommonJS,
    ES2015,
    Var,
    Direct
}

export enum IfTsbError
{
    InternalError=20000,
    Unsupported=20001,
    JsError=20002,
    Dupplicated=20003,
    ModuleNotFound=2307,
}

export interface BundlerOptionsWithOutput extends BundlerOptions
{
    output?:string;
}

export interface TsConfig
{
    entry:string[]|Record<string, (string|BundlerOptionsWithOutput)>|string;
    output?:string;

    bundlerOptions?:BundlerOptions;
    
    /**
     * compiler option override.
     * if not define it, it will load [cwd]/tsconfig.json
     */
    compilerOptions?:ts.CompilerOptions;
}

export enum ExternalMode
{
    NoExternal=0,
    Manual=-1,
    Preimport=-2
}
