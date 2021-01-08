
import ts = require('typescript');

export interface TsBundlerOptions
{
    entry:Record<string, string>|string;
    globalModuleVarName?:string;

    /**
     * compiler option override.
     * if not define it, it will load [cwd]/tsconfig.json
     */
    compilerOptions?:ts.CompilerOptions
}

export interface TsBundlerModuleId
{
    number:number;
    varName:string;
    apath:string;
}

export interface TsBundleResult
{
    files:string[];
}

export class TsBundlerRefined
{
    firstLineComment:string|null;
    varname:string;
    rpath:string;
    apath:string;
    sourceMapOutputLineOffset:number;
    outputLineCount:number;
    content:string;
    sourceMapText:string|null;

    save(ctx:TsBundlerMainContext):void;
}

export class TsBundler
{
    public readonly outdir:string;
    public readonly globalVarName:string;
    public readonly entryModule:TsBundlerModule;
    public readonly main:TsBundlerMainContext;
    public readonly entry:string;
    public readonly output:string;
    public readonly tsoptions:ts.CompilerOptions;

    constructor(
        main:TsBundlerMainContext,
        entry:string, 
        output:string,
        options:TsBundlerOptions, 
        tsoptions:ts.CompilerOptions);

    allocModuleVarName(name:string):string;
    
    add(filepath:string):TsBundlerModule;
    refine(id:TsBundlerModuleId, dependency:string[], content:string, sourceMapText?:string):TsBundlerRefined;
    write(refined:TsBundlerRefined):void;
    end():Promise<void>;
}

export class TsBundlerModule
{
    public readonly rpath:string;
    public readonly name:string;
    public readonly bundler:TsBundler;
    public readonly apath:string;

    constructor(bundler:TsBundler, apath:string, mpath:string);

    error(node:ts.Node, code:number, message:string):void;

    refine():Promise<TsBundlerRefined|null>;
    load():Promise<void>;
}

export class TsBundlerMainContext
{
    public errorCount:number;

    constructor();

    saveCacheJson():void;

    reportFromDiagnostics(diagnostics:ts.Diagnostic[]):void;

    /**
     * mimic TS errors
     */
    report(source:string, line:number, column:number, code:number, message:string, lineText:string, width:number):void;

    /**
     * mimic TS errors
     */
    reportFromCatch(err:any):boolean;

    getErrorCountString():string;

    getModuleId(bundler:TsBundler, apath:string):TsBundlerModuleId;

    bundleWithPath(tsconfigPath:string):Promise<boolean>;
    
    bundle(tsconfigPath:TsBundlerOptions):Promise<boolean>;
}

export function bundle():Promise<void>;
export function bundleWatch(...entries:string[]):void;