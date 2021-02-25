
if (!Date.now) Date.now = ()=>+new Date();

import ts = require('typescript');
import fs = require('fs');
import path = require('path');
import { identifierValidating } from './checkvar';
import { ErrorPosition } from './errpos';
import { findCacheDir } from './findcachedir';
import { fsp, mkdirRecursiveSync } from './fsp';
import { LineStripper } from './linestripper';
import { MemoryManager } from './memmgr';
import { namelock } from './namelock';
import { SourceMap } from './sourcemap';
import { WriterStream as FileWriter } from './streamwriter';
import { changeExt, ConcurrencyQueue, count, defaultFormatHost, dirnameModulePath, getScriptKind, joinModulePath, parsePostfix, resolved, SkipableTaskQueue, splitContent, time } from './util';
import { FilesWatcher } from './watch';
import colors = require('colors');
import globToRegExp = require('glob-to-regexp');

const cacheDir = findCacheDir('if-tsb') || './.if-tsb.cache';
const cacheMapPath = path.join(cacheDir, 'cachemap.json');
const builtin = new Set<string>(require('module').builtinModules);
const CACHE_VERSION = 'TSBC-0.10';
const CACHE_SIGNATURE = '\n'+CACHE_VERSION;
const CACHE_MEMORY_DEFAULT = 1024*1024*1024;
const memoryCache = new MemoryManager<RefinedModule>(CACHE_MEMORY_DEFAULT);
const defaultCompilerOptions = ts.getDefaultCompilerOptions();

function getCacheFilePath(id:BundlerModuleId):string
{
    return path.join(cacheDir, id.number+'');
}

function getOutFileName(options:TsConfig, name:string):string
{
    if (options.output)
    {
        const filename = path.basename(name);
        const ext = path.extname(filename);
        
        const varmap = new Map<string, string>();
        varmap.set('name', filename.substr(0, filename.length - ext.length));
        varmap.set('dirname', path.dirname(name));

        const regex = /\[.+\]/g;
        return options.output.replace(regex, matched=>{
            return varmap.get(matched) || process.env[matched] || '';
        });
    }
    else
    {
        const ext = path.extname(name);
        return name.substr(0, name.length - ext.length)+'.bundle.js';
    }
}

enum ExportRule
{
    None,
    CommonJS,
    ES2015,
    Var,
    Direct,
}

enum CheckState
{
    None,Entered,Checked,
}

enum IfTsbError
{
    InternalError=20000,
    Unsupported=20001,
    JsError=20002,
    Dupplicated=20003,
    ModuleNotFound=2307,
}

enum ExternalMode
{
    NoExternal=0,
    Manual=-1,
    Preimport=-2
}

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

export class ImportInfo
{
    constructor(
        public readonly apath:string,
        public readonly mpath:string,
        public readonly codepos: ErrorPosition|null)
    {
    }

    getExternalMode():ExternalMode|null
    {
        if (/^[0-9]$/.test(this.apath)) return -+this.apath;
        return null;
    }

    static stringify(imports:ImportInfo[]):string
    {
        type SerializedInfo = [string, string, number?, number?, number?, string?];
        const out:SerializedInfo[] = [];
        for (const info of imports)
        {
            const line:SerializedInfo = [info.apath, info.mpath];
            if (info.codepos !== null)
            {
                const pos = info.codepos;
                line[2] = pos.line;
                line[3] = pos.column;
                line[4] = pos.width;
                line[5] = pos.lineText;
            }
            out.push(line);
        }
        return JSON.stringify(out);
    }
    static parse(str:string):ImportInfo[]
    {
        const imports = JSON.parse(str);
        const out:ImportInfo[] = [];
        for (const [apath, mpath, line, column, width, lineText] of imports)
        {
            const codepos = line === undefined ? null : new ErrorPosition(line, column, width, lineText);
            out.push(new ImportInfo(apath, mpath, codepos));
        }
        return out;
    }

}

export class RefinedModule
{
    firstLineComment:string|null = null;
    sourceMapOutputLineOffset:number = 0;
    outputLineCount:number;
    imports:ImportInfo[] = [];
    sourceMapText:string|null = null;
    content:string = '';
    size:number;
    errored = false;
    sourceMtime:number;
    tsconfigMtime:number;

    constructor(
        public readonly id:BundlerModuleId)
    {
    }

    private readonly saving = new SkipableTaskQueue;

    checkRelativePath(rpath:string):boolean {
        const lineend = this.content.indexOf('\n');
        if (lineend === -1) return false;
        const matched = this.content.substr(0, lineend).match(/^\/\/ (.+)$/);
        if (matched === null) return false;
        return matched[1] === rpath;
    }

    clear():void
    {
        this.firstLineComment = null;
        this.imports.length = 0;
        this.sourceMapText = null;
        this.content = '';
        this.size = 0;
    }

    save(bundler:Bundler):void
    {
        if (this.errored) return;
        bundler.taskQueue.ref();
        this.saving.run(async()=>{
            try
            {
                namelock.lock(this.id.number);
                const writer = new FileWriter(getCacheFilePath(this.id));
                await writer.write(`${this.sourceMtime}\n`);
                await writer.write(ImportInfo.stringify(this.imports)+'\n');
                await writer.write(this.firstLineComment ? this.firstLineComment+'\n' : '\n');
                await writer.write(this.sourceMapOutputLineOffset+'\n');
                await writer.write(this.outputLineCount+'\n');
                await writer.write(this.sourceMapText ? this.sourceMapText.replace(/[\r\n]/g, '')+'\n' : '\n');
                await writer.write(this.content);
                await writer.write(CACHE_SIGNATURE);
                await writer.end();
                bundler.taskQueue.unref();
            }
            finally
            {
                namelock.unlock(this.id.number);
            }
        });
    }

    async load():Promise<void>
    {
        const cachepath = getCacheFilePath(this.id);
        let content:string;
        try
        {
            namelock.lock(this.id.number);
            content = await fsp.readFile(cachepath);
        }
        finally
        {
            namelock.unlock(this.id.number);
        }
        if (!content.endsWith(CACHE_SIGNATURE)) throw Error('Outdated cache or failed data');
        const [
            sourceMtime,
            tsconfigMtime,
            imports, 
            firstLineComment, 
            sourceMapOutputLineOffset,
            outputLineCount,
            sourceMapText,
            source
        ] = splitContent(content, 8, '\n');
        this.sourceMtime = +sourceMtime;
        this.tsconfigMtime = +tsconfigMtime;
        this.imports = imports === '' ? [] : ImportInfo.parse(imports);
        this.firstLineComment = firstLineComment || null;
        this.sourceMapOutputLineOffset = +sourceMapOutputLineOffset;
        this.outputLineCount = +outputLineCount;
        this.sourceMapText = sourceMapText || null;
        this.content = source.substr(0, source.length - CACHE_SIGNATURE.length);
        this.size = this.content.length + 2048;
    }
    
    static async getRefined(id:BundlerModuleId, tsconfigMtime:number):Promise<{refined:RefinedModule|null, sourceMtime:number}>
    {
        let sourceMtime = -1;
        _error:try
        {
            const cached = memoryCache.take(id.number);
            if (cached !== undefined)
            {
                const file = await fsp.stat(id.apath);
                sourceMtime = +file.mtime;
                if (cached.sourceMtime !== sourceMtime) break _error;
                if (cached.tsconfigMtime !== tsconfigMtime) break _error;
                return {refined:cached, sourceMtime};
            }
            else
            {
                try
                {
                    namelock.lock(id.number);
                    const cachepath = getCacheFilePath(id);
                    let cacheMtime = -1;
                    await Promise.all([fsp.stat(cachepath).then(cache=>{
                        cacheMtime = +cache.mtime;
                    }, ()=>{}), fsp.stat(id.apath).then(source=>{
                        sourceMtime = +source.mtime;
                    }, ()=>{})]);
                    if (cacheMtime === -1) break _error;
                    if (cacheMtime < tsconfigMtime) break _error;
                    if (cacheMtime < sourceMtime) break _error;
                }
                finally
                {
                    namelock.unlock(id.number);
                }
                const refined = new RefinedModule(id);
                await refined.load();
                if (refined.sourceMtime !== sourceMtime) break _error;
                if (refined.tsconfigMtime !== tsconfigMtime) break _error;
                return {refined, sourceMtime};
            }
        }
        catch (err)
        {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
        return {refined:null, sourceMtime};
    }
    
}

export class Bundler
{
    private readonly names = new Map<string, BundlerModuleId>();

    private writingProm:Promise<FileWriter>|null = null;
    private mapgen:SourceMap|null = null;
    private lineOffset = 0;
    public entryModuleIsAccessed = false;

    public readonly output:string;
    public readonly outdir:string;
    public readonly globalVarName:string;
    public readonly clearConsole:boolean;
    public readonly watchWaiting:number|undefined;
    public readonly verbose:boolean;
    public readonly checkCircularDependency:boolean;
    public readonly suppressDynamicImportErrors:boolean;
    public readonly faster:boolean;
    public readonly bundleExternals:boolean;
    public readonly externals:RegExp[];
    public readonly cacheMemory:number|undefined;
    public readonly exportRule:ExportRule;
    public readonly exportVarKeyword:string|null = null;
    public readonly exportVarName:string|null = null;
    public readonly needWrap:boolean;

    private readonly moduleByName = new Map<string, BundlerModule>();
    public readonly deplist:string[] = [];
    public readonly files:string[] = [];
    public readonly taskQueue:ConcurrencyQueue;
    private readonly sourceFileCache = new Map<string, ts.SourceFile>();
    public readonly tsconfigMtime:number;
    public readonly moduleResolutionCache:ts.ModuleResolutionCache;
    public readonly sys:ts.System;
    public readonly compilerHost:ts.CompilerHost;
    public readonly entryApath:string;
    public readonly entryRpath:string;
    public readonly constKeyword:string;
    public readonly preimportTargets:Set<string>;
    private readonly cache:Record<string, BundlerModuleId>;

    private csResolve:(()=>void)[] = [];
    private csEntered = false;

    constructor(
        public readonly main:BundlerMainContext,
        public readonly basedir:string, 
        entry:string, 
        resolvedOutput:string,
        options:TsConfig, 
        public readonly tsconfig:string|null,
        public readonly tsoptions:ts.CompilerOptions)
    {
        this.entryApath = path.join(this.basedir, entry);
        this.entryRpath = path.relative(this.basedir, this.entryApath);
        this.cache = main.getCacheMap(this.entryApath);

        if (this.tsoptions.target === undefined)
        {
            this.tsoptions.target = ts.ScriptTarget.ES3;
        }
        if (this.tsoptions.target >= ts.ScriptTarget.ES2015)
        {
            this.constKeyword = 'const';
        }
        else
        {
            this.constKeyword = 'var';
        }
        delete this.tsoptions.outFile;
        delete this.tsoptions.outDir;
        delete this.tsoptions.out;
        this.tsoptions.allowJs = true;
        this.tsoptions.outDir = '/.if-tsb';

        const that = this;
        this.sys = {
            getCurrentDirectory():string
            {
                return that.basedir;
            },
            directoryExists(filepath:string):boolean
            {
                try
                {
                    const stat = fs.statSync(that.resolvePath(filepath));
                    return stat.isDirectory();
                }
                catch (err)
                {
                    return false;
                }
            },
            fileExists(filepath:string):boolean
            {
                return fs.existsSync(that.resolvePath(filepath));
            },
        } as any;
        Object.setPrototypeOf(this.sys, ts.sys);

        this.compilerHost = ts.createCompilerHost(this.tsoptions);
        this.compilerHost.getCurrentDirectory = function() { return that.sys.getCurrentDirectory(); },
        this.compilerHost.readFile = function(fileName:string) { return that.sys.readFile(fileName); },
        this.compilerHost.directoryExists = function(dirName:string) { return that.sys.directoryExists(dirName); },
        this.compilerHost.getDirectories = function(dirName:string) { return that.sys.getDirectories(dirName); }

        if (tsconfig !== null)
        {
            this.tsconfigMtime = +fs.statSync(tsconfig).mtime;
        }
        else
        {
            this.tsconfigMtime = 0;
        }
        this.output = resolvedOutput;
        this.outdir = path.dirname(this.output);
        const boptions = options.bundlerOptions || {};

        this.taskQueue = new ConcurrencyQueue(Number(boptions.concurrency) || undefined);
        this.globalVarName = (boptions.globalModuleVarName || '__tsb').toString();
        this.clearConsole = boptions.clearConsole === true;
        this.taskQueue.verbose = this.verbose = boptions.verbose === true;
        this.checkCircularDependency = boptions.checkCircularDependency === true;
        this.suppressDynamicImportErrors = boptions.suppressDynamicImportErrors === true;
        this.faster = boptions.faster === true;
        this.watchWaiting = boptions.watchWaiting;
        this.bundleExternals = boptions.bundleExternals === true;
        this.externals = boptions.externals instanceof Array ? boptions.externals.map(glob=>globToRegExp(glob)) : [];
        this.preimportTargets = boptions.preimport instanceof Array ? new Set(boptions.preimport) : new Set;
        this.preimportTargets.add('tslib');

        this.cacheMemory = parsePostfix(boptions.cacheMemory);
        if (boptions.module === undefined)
        {
            this.exportRule = ExportRule.None;
        }
        else
        {
            const exportRule = (boptions.module+'').toLowerCase();
            switch (exportRule)
            {
            case 'none': this.exportRule = ExportRule.None; break;
            case 'commonjs': this.exportRule = ExportRule.CommonJS; break;
            case 'es2015': this.exportRule = ExportRule.ES2015; break;
            case 'es2020': this.exportRule = ExportRule.ES2015; break;
            case 'esnext': this.exportRule = ExportRule.ES2015; break;
            case 'this':
            case 'window':
            case 'self': 
                this.exportRule = ExportRule.Direct;
                this.exportVarName = exportRule;
                break;
            default:
                const [rule, param] = splitContent(boptions.module, 2, ' ');
                switch (rule.toLowerCase())
                {
                case 'var': 
                    this.exportRule = ExportRule.Var;
                    this.exportVarKeyword = 'var';
                    this.exportVarName = identifierValidating(param);
                    break;
                case 'let': 
                    this.exportRule = ExportRule.Var;
                    this.exportVarKeyword = 'let';
                    this.exportVarName = identifierValidating(param);
                    break;
                case 'const': 
                    this.exportRule = ExportRule.Var;
                    this.exportVarKeyword = 'const';
                    this.exportVarName = identifierValidating(param);
                    break;
                default:
                    this.exportRule = ExportRule.Direct;
                    this.exportVarName = exportRule;
                    console.error(colors.red(`if-tsb: Unsupported module type: ${boptions.module}, it treats as a direct export`));
                    break;
                }
                break;
            }
        }
        this.needWrap = (this.exportRule === ExportRule.Direct) || (this.exportRule === ExportRule.Var);
        
        this.moduleResolutionCache = ts.createModuleResolutionCache(this.basedir, ts.sys.useCaseSensitiveFileNames ? v=>v.toLocaleLowerCase() : v=>v);
    }

    private async _lock():Promise<FileWriter>
    {
        const writer = await this.writingProm!;
        await this._lockWithoutWriter();
        return writer;
    }
    private _lockWithoutWriter():Promise<void>
    {
        if (!this.csEntered)
        {
            this.csEntered = true;
            return resolved;
        }
        return new Promise<void>(resolve=>{
            this.csResolve.push(resolve);
        });
    }

    private _unlock():void
    {
        if (this.csResolve.length === 0)
        {
            if (this.csEntered)
            {
                this.csEntered = false;
                return;
            }
            this.main.reportMessage(IfTsbError.InternalError, 'unlock more than lock');
            return;
        }
        const resolve = this.csResolve.pop()!;
        resolve();
    }

    getModuleId(apath:string, mode:ExternalMode, forceModuleName:string|null):BundlerModuleId
    {
        let id = this.cache[apath];
        if (id === undefined)
        {
            id = {
                number: mode === ExternalMode.NoExternal ? this.main.allocateCacheId() : mode,
                apath,
                varName: ''
            };
            if (mode === ExternalMode.Manual)
            {
                forceModuleName = apath;
            }
            if (forceModuleName !== null)
            {
                id.varName = forceModuleName;
                this.addModuleVarName(id);
            }
            else
            {
                let varName = path.basename(apath);
                const dotidx = varName.lastIndexOf('.');
                if (dotidx !== -1) varName = varName.substr(0, dotidx);
                if (varName === 'index')
                {
                    varName = path.basename(path.dirname(apath));
                }
                this.allocModuleVarName(id, varName);
            }
            this.cache[apath] = id;
            this.main.cacheJsonModified = true;
        }
        return id;
    }

    deleteModuleId(apath:string):boolean
    {
        const id = this.cache[apath];
        if (!id) return false;
        delete this.cache[apath];
        this.main.freeCacheId(id.number);
        this.deleteModuleVarName(id.varName);
        return true;
    }

    resolvePath(filepath:string):string
    {
        return path.isAbsolute(filepath) ? path.join(filepath) : path.join(this.basedir, filepath);
    }

    async getSourceFile(filepath:string):Promise<ts.SourceFile>
    {
        let sourceFile = this.sourceFileCache.get(filepath);
        if (sourceFile) return sourceFile;
        
        const source = await fsp.readFile(filepath);
        sourceFile = ts.createSourceFile(filepath, source, this.tsoptions.target!);
        this.sourceFileCache.set(filepath, sourceFile);
        
        return sourceFile;
    }

    getSourceFileSync(filepath:string, languageVersion?: ts.ScriptTarget):ts.SourceFile|undefined
    {
        let sourceFile = this.sourceFileCache.get(filepath);
        if (sourceFile) return sourceFile;
        const source = fs.readFileSync(filepath, 'utf-8');
        sourceFile = ts.createSourceFile(filepath, source, languageVersion || this.tsoptions.target!);
        this.sourceFileCache.set(filepath, sourceFile);

        return sourceFile;
    }

    addModuleVarName(module:BundlerModuleId):BundlerModuleId|null
    {
        const old = this.names.get(module.varName);
        this.names.set(module.varName, module);
        return old || null;
    }

    allocModuleVarName(module:BundlerModuleId, name:string):void
    {
        name = identifierValidating(name);
        if (this.names.has(name))
        {
            const base = name;
            let num = 2;
            for (;;)
            {
                name = base + num;
                if (!this.names.has(name)) break;
                num++;
            }
        }
        this.names.set(name, module);
        module.varName = name;
    }

    deleteModuleVarName(name:string):boolean
    {
        return this.names.delete(name);
    }
    
    async write(module:BundlerModule, refined:RefinedModule):Promise<void>
    {
        const writer = await this._lock();
        if (this.verbose) console.log(refined.id.apath+': writing');
        try
        {
            await writer.write(refined.content);
        }
        finally
        {
            if (this.verbose) console.log(refined.id.apath+': writing end');
            this._unlock();
        }
        const offset = this.lineOffset + refined.sourceMapOutputLineOffset;
        this.lineOffset += refined.outputLineCount;

        if (refined.sourceMapText)
        {
            try
            {
                this.mapgen!.append(refined.id.apath, refined.sourceMapText, offset);
            }
            catch (err)
            {
                module.error(null, IfTsbError.InternalError, `Invalid source map (${refined.sourceMapText.substr(0, 16)})`);
            }
        }
    }
        
    private async _appendChildren(module:BundlerModule, refined:RefinedModule):Promise<void>
    {
        if (module.children.length === 0)
        {
            module.importLines.length = 0;

            for (const info of refined.imports)
            {
                const mode = info.getExternalMode();
                if (mode !== null)
                {
                    this.getExternal(info.mpath, mode);
                }
                else
                {
                    const childModule = this.getModule(info.mpath, info.apath);
                    module.children.push(childModule);
                    module.importLines.push(info.codepos);
                }
            }
        }
        
        for (const child of module.children)
        {
            if (child.isEntry)
            {
                this.entryModuleIsAccessed = true;
                continue;
            }
            if (child.isAppended) continue;
            child.isAppended = true;
            await this.taskQueue.run(async()=>{
                const childRefined = await child.refine();
                if (childRefined === null) {
                    try {
                        const writer = await this._lock();
                        await writer.write(`${child.id.varName}(){ throw Error("Cannot find module '${child.mpath}'"); }\n`);
                    } finally {
                        this._unlock();
                    }
                    module.error(null, IfTsbError.ModuleNotFound, `Cannot find module '${child.mpath}'`);
                    return;
                }
                this.deplist.push(child.id.apath);
                this._appendChildren(child, childRefined);

                await this.write(child, childRefined);
                if (!childRefined.errored) {
                    memoryCache.put(childRefined.id.number, childRefined);
                }
            });
        }
    }

    async bundle():Promise<boolean>
    {
        if (this.writingProm !== null) throw Error('bundler is busy');
        this.mapgen = SourceMap.newInstance(this.output);
            
        this.deplist.length = 0;
        if (this.tsconfig !== null) this.deplist.push(this.tsconfig);
        const filename = path.basename(this.entryApath);
        const mpath = filename.substr(0, filename.length - getScriptKind(filename).ext.length);

        let resolveWriter:(writer:FileWriter)=>void;
        let rejectWriter:(err:Error)=>void;
        this.writingProm = new Promise((resolve, reject)=>{
            resolveWriter = resolve;
            rejectWriter = reject;
        });

        let writer:FileWriter|null = null;

        const entryModule = this.getModule('./'+mpath, this.entryApath, '__entry');
        entryModule.isEntry = true;
        entryModule.isAppended = true;
        this.deplist.push(this.entryApath);
        
        let entryRefined:RefinedModule|null = null;
        this.taskQueue.run(async()=>{
            try
            {
                entryRefined = await entryModule.refine();
                if (entryRefined === null) return;
                this._appendChildren(entryModule, entryRefined);
                await fsp.mkdirRecursive(this.outdir);
        
                await this._lockWithoutWriter();
                try
                {
                    writer = new FileWriter(this.output);
                    if (entryRefined.firstLineComment !== null)
                    {
                        await writer.write(entryRefined.firstLineComment+'\n');
                        this.lineOffset++;
                    }
                    if (this.tsoptions.alwaysStrict)
                    {
                        await writer.write('"use strict";\n');
                        this.lineOffset++;
                    }
                    if (this.needWrap)
                    {
                        let assign = '';
                        if (this.exportRule === ExportRule.Var)
                        {
                            assign = `${this.exportVarKeyword} ${this.exportVarName}=`;
                        }
                        if (this.tsoptions.target! >= ts.ScriptTarget.ES2015)
                        {
                            await writer.write(`${assign}(()=>{\n`);
                        }
                        else
                        {
                            await writer.write(`${assign}(function(){\n`);
                        }
                        this.lineOffset++;
                    }
                    await writer.write(`${this.constKeyword} ${this.globalVarName} = {\n`);
                    this.lineOffset++;
                    resolveWriter(writer);
                }
                finally
                {
                    this._unlock();
                }
            }
            catch (err)
            {
                rejectWriter(err);
            }
        });
        await this.taskQueue.onceEnd();
        if (writer === null) return false; // writer is null if the build is failed.

        for (const apath in this.cache)
        {
            const module = this.cache[apath];
            if (module.number !== ExternalMode.Preimport) continue;
            await writer!.write(`${module.varName}:require('${apath}'),\n`);
            this.lineOffset ++;
        }
        if ('__resolve' in this.cache)
        {
            if (this.tsoptions.target! >= ts.ScriptTarget.ES2015)
            {
                await writer!.write(`__resolve(rpath){\n`);
            }
            else
            {
                await writer!.write(`__resolve:function(rpath){\n`);
            }
            const path = this.cache.path;
            await writer!.write(`return this.${path.varName}.join(this.__dirname, rpath);\n},\n`);
            if (this.tsoptions.target! >= ts.ScriptTarget.ES2015)
            {
                await writer!.write(`__dirname,\n`);
            }
            else
            {
                await writer!.write(`__dirname:__dirname,\n`);
            }
            this.lineOffset += 4;
        }

        if (this.entryModuleIsAccessed || this.tsoptions.target! < ts.ScriptTarget.ES5)
        {
            await writer!.write(`entry:exports\n};\n`);
            this.lineOffset += 2;
        }
        else
        {
            await writer!.write(`};\n`);
            this.lineOffset ++;
        }
        if (this.verbose) console.log(this.entryRpath+': starting');
        await this.write(entryModule, entryRefined!);
        if (this.verbose) console.log(this.entryRpath+': writing end');
        memoryCache.put(entryRefined!.id.number, entryRefined!);

        await Promise.all([(async()=>{
            await writer!.write('\n');
            if (this.entryModuleIsAccessed)
            {
                await writer!.write(`${this.globalVarName}.entry=module.exports;\n`);
            }
            if (this.needWrap)
            {
                if (this.tsoptions.target! >= ts.ScriptTarget.ES2015)
                {
                    await writer!.write(`})();\n`);
                }
                else
                {
                    if (this.exportRule === ExportRule.Direct && this.exportVarName === 'this')
                    {
                        await writer!.write(`}).call(this);\n`);
                    }
                    else
                    {
                        await writer!.write(`})();\n`);
                    }
                }
            }
            await writer!.write(`//# sourceMappingURL=${path.basename(this.output)}.map`);
            await writer!.end();
        })(), this.mapgen.save()]);

        this.main.clearCache(this, this.moduleByName);

        if (this.verbose) console.log(this.entryRpath+': done');
        this.mapgen = null;
        this.lineOffset = 0;
        this.writingProm = null;
        this.moduleByName.clear();
        this.sourceFileCache.clear();
        
        const parents:BundlerModule[] = [];
        function checkModuleDep(m:BundlerModule, i:number):void
        {
            if (m.checkState === CheckState.Checked) return;
            if (m.checkState === CheckState.Entered)
            {
                const parent = parents[parents.length-1];
                const loopPoint = parents.lastIndexOf(m);
                const looping = parents.slice(loopPoint);
                looping.push(m);
                parent.error(parent.importLines![i], 1005, 'Circular dependency '+looping.map(m=>colors.yellow(m.rpath)).join(' → '));
                return;
            }
            m.checkState = CheckState.Entered;
            parents.push(m);

            const n = m.children.length;
            for (let i=0;i<n;i++)
            {
                checkModuleDep(m.children[i], i);
            }
            m.checkState = CheckState.Checked;
            parents.pop();
        }   

        if (this.checkCircularDependency)
        {
            checkModuleDep(entryModule, -1);
        }

        return true;
    }

    getExternal(name:string, mode:ExternalMode):BundlerModuleId
    {
        if (name.startsWith('.'))
        {
            this.main.reportMessage(IfTsbError.InternalError, `${name}: external module starts with dot`);
        }
        return this.getModuleId(name, mode, null);
    }

    getModule(mpath:string, apath:string, forceModuleName?:string):BundlerModule
    {
        let module = this.moduleByName.get(apath);
        if (module) return module;
        
        module = new BundlerModule(this, mpath, apath, forceModuleName || null);
        this.moduleByName.set(apath, module);
        return module;
    }
}

export class BundlerModule
{
    public readonly id:BundlerModuleId;
    public readonly rpath:string;
    public readonly children:BundlerModule[] = [];
    public readonly importLines:(ErrorPosition|null)[] = [];
    public isAppended = false;
    public isEntry = false;
    public checkState = CheckState.None;

    constructor(
        public readonly bundler:Bundler, 
        public readonly mpath:string,
        apath:string,
        forceModuleName:string|null)
    {
        this.id = bundler.getModuleId(apath, ExternalMode.NoExternal, forceModuleName);
        this.rpath = path.relative(bundler.basedir, apath);
    }

    error(pos:ErrorPosition|null, code:number, message:string):void
    {
        if (pos === null)
        {
            this.bundler.main.report(this.rpath, 0, 0, code, message, '', 0);
        }
        else
        {
            this.bundler.main.report(this.rpath, pos.line, pos.column, code, message, pos.lineText, pos.width);
        }
    }

    makeErrorPosition(node:ts.Node):ErrorPosition|null
    {
        const source = node.getSourceFile();
        if (source === undefined)
        {
            return null;
        }
        const pos = source.getLineAndCharacterOfPosition(node.getStart());
        const width = node.getWidth();

        const sourceText = source.getFullText();
        const lines = source.getLineStarts();
        const start = lines[pos.line];
        const linenum = pos.line+1;
        const end = linenum < lines.length ? lines[linenum]-1 : sourceText.length;

        const lineText = sourceText.substring(start, end);
        return {
            line: linenum,
            column: pos.character,
            lineText: lineText,
            width: width
        };
    }

    errorWithNode(node:ts.Node, code:number, message:string):void
    {
        return this.error(this.makeErrorPosition(node), code, message);
    }

    async refine():Promise<RefinedModule|null>
    {
        let {refined, sourceMtime} = await RefinedModule.getRefined(this.id, this.bundler.tsconfigMtime);
        if (refined !== null) {
            if (refined.checkRelativePath(this.rpath)) {
                return refined;
            }
            // cache changed
        }
        if (sourceMtime === -1) {
            this.error(null, IfTsbError.ModuleNotFound, `Cannot find module ${this.mpath}`);
            return null;
        }

        this.children.length = 0;
        this.importLines.length = 0;

        refined = new RefinedModule(this.id);
        refined.content = `// ${this.rpath}\n`;
        refined.sourceMtime = sourceMtime;
        refined.tsconfigMtime = this.bundler.tsconfigMtime;

        let useDirName = false;
        let useFileName = false;
        let useModule = false;
        let useExports = false;
        const bundler = this.bundler;
        const basedir = bundler.basedir;

        const addExternalList = (name:string, mode:ExternalMode, codepos:ErrorPosition|null)=>{
            const childModule = bundler.getExternal(name, mode);
            refined!.imports.push(new ImportInfo((-mode)+'', name, codepos));
            return childModule;
        };

        const addToImportList = (mpath:string, apath:string, codepos:ErrorPosition|null, forceModuleName?:string)=>{
            const childModule = bundler.getModule(mpath, apath, forceModuleName);
            refined!.imports.push(new ImportInfo(childModule.id.apath, mpath, codepos));
            return childModule;
        };

        const factory = (ctx:ts.TransformationContext)=>{
            const stacks:ts.Node[] = [];

            const preimport = (mpath:string)=>{
                const module = addExternalList(mpath, ExternalMode.Preimport, getErrorPosition());
                return ctx.factory.createPropertyAccessExpression(
                    ctx.factory.createIdentifier(this.bundler.globalVarName),
                    ctx.factory.createIdentifier(module.varName));
            };

            const getErrorPosition = ():ErrorPosition|null=>{
                for (let i = stacks.length-1; i >= 0; i--)
                {
                    let node = stacks[i];
                    const ori = (node as any).original;
                    if (ori) node = ori;
                    if (node.pos === -1) continue;
                    return this.makeErrorPosition(node);
                }
                return this.makeErrorPosition(sourceFile);
            };
    
            const importFromStringLiteral = (_node:ts.Node, base:ts.Node):ts.Node=>{
                if (_node.kind !== ts.SyntaxKind.StringLiteral)
                {
                    if (!bundler.suppressDynamicImportErrors)
                    {
                        refined!.errored = true;
                        this.error(getErrorPosition(), IfTsbError.Unsupported, `if-tsb does not support dynamic import for local module, (${ts.SyntaxKind[_node.kind]} is not string literal)`);
                    }
                    return base;
                }
                const node = _node as ts.StringLiteral;
                const importName = node.text;                
                const oldsys = this.bundler.sys;
                const sys:ts.System = Object.setPrototypeOf({
                    fileExists(path: string): boolean
                    {
                        if (getScriptKind(path).kind === ts.ScriptKind.External) return false;
                        return oldsys.fileExists(path);
                    }
                }, oldsys);

                let childModuleMpath:string;
                if (!this.id.apath.endsWith(`${path.sep}index`) && !this.mpath.endsWith('/index')) {
                    childModuleMpath = joinModulePath(this.mpath, importName);
                } else {
                    const dirmodule = dirnameModulePath(this.mpath);
                    childModuleMpath = joinModulePath(dirmodule, importName);
                }
                if (childModuleMpath === 'path')
                {
                    return preimport('path');
                }
                if (bundler.preimportTargets.has(childModuleMpath))
                {
                    return preimport(childModuleMpath);
                }
                for (const glob of bundler.externals)
                {
                    if (glob.test(childModuleMpath)) return base;
                }

                let module = ts.nodeModuleNameResolver(importName, this.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
                if (!module.resolvedModule && importName === '.') 
                    module = ts.nodeModuleNameResolver(path.join(basedir, 'index'), this.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
                const info = module.resolvedModule;
                if (!info)
                {
                    if (!importName.startsWith('.'))
                    {
                        if (builtin.has(childModuleMpath))
                        {
                            return preimport(childModuleMpath);
                        }
                        if (!this.bundler.bundleExternals) return base;
                    }
                    refined!.errored = true;
                    this.error(getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importName}' or its corresponding type declarations.`);
                    return base;
                }

                if (info.isExternalLibraryImport)
                {
                    if (!this.bundler.bundleExternals) return base;
                }
                
                let childmoduleApath = path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(bundler.basedir, info.resolvedFileName);
                const kind = getScriptKind(childmoduleApath);
                if (kind.kind === ts.ScriptKind.External)
                {
                    childmoduleApath = childmoduleApath.substr(0, childmoduleApath.length-kind.ext.length+1)+'js';
                    if (!fs.existsSync(childmoduleApath))
                    {
                        refined!.errored = true;
                        this.error(getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${node.text}' or its corresponding type declarations.`);
                        return base;
                    }
                }
    
                const childModule = addToImportList(childModuleMpath, childmoduleApath, getErrorPosition());
                const moduleVar = ctx.factory.createPropertyAccessExpression(
                    ctx.factory.createIdentifier(this.bundler.globalVarName),
                    ctx.factory.createIdentifier(childModule.id.varName));

                if (childModule.isEntry) return moduleVar;
                return ctx.factory.createCallExpression(
                    moduleVar, [], []);
            };
    
            const visit = (_node:ts.Node):ts.Node=>{
                stacks.push(_node);

                switch (_node.kind)
                {
                case ts.SyntaxKind.Identifier: {
                    const node = _node as ts.Identifier;
                    const parent = stacks[stacks.length-1];
                    if (parent && parent.kind === ts.SyntaxKind.PropertyAccessExpression) break;
                    switch (node.text)
                    {
                    case '__dirname': useDirName = true; break;
                    case '__filename': useFileName = true; break;
                    case 'module': useModule = true; break;
                    case 'exports': useExports = true; break;
                    } 
                    break;
                }
                case ts.SyntaxKind.ImportEqualsDeclaration: {
                    const node = _node as ts.ImportEqualsDeclaration;
                    
                    const ref = node.moduleReference as ts.ExternalModuleReference;
                    if (ref.kind === ts.SyntaxKind.ExternalModuleReference)
                    {
                    const nnode = importFromStringLiteral(ref.expression, _node);
                    if (nnode === _node) return _node;
                    return ctx.factory.createVariableDeclaration(node.name, undefined, undefined, nnode as ts.Expression);
                    }
                    break;
                }
                case ts.SyntaxKind.ImportDeclaration: {
                    const node = _node as ts.ImportDeclaration;
                    return importFromStringLiteral(node.moduleSpecifier, _node);
                }
                case ts.SyntaxKind.CallExpression: {
                    const node = _node as ts.CallExpression;
                    switch (node.expression.kind)
                    {
                    case ts.SyntaxKind.ImportKeyword: {
                        if (node.arguments.length !== 1)
                        {
                            refined!.errored = true;
                            this.error(getErrorPosition(), IfTsbError.Unsupported, `Cannot call import with multiple parameters`);
                            return _node;
                        }
                        return importFromStringLiteral(node.arguments[0], _node);
                    }
                    case ts.SyntaxKind.Identifier: {
                        const identifier = node.expression as ts.Identifier;
                        if (identifier.escapedText === 'require')
                        {
                            return importFromStringLiteral(node.arguments[0], _node);
                        }
                        break;
                    }}
                    break;
                }}
                const ret = ts.visitEachChild(_node, visit, ctx);
                stacks.pop();
                return ret;
            };
            
            return (sourceFile:ts.SourceFile)=>ts.visitNode(sourceFile, visit);
        };

        let filepath = this.id.apath;
        const info = getScriptKind(filepath);
        
        let sourceFile:ts.SourceFile;
        try
        {
            sourceFile = await bundler.getSourceFile(filepath);
        }
        catch (err)
        {
            this.error(null, IfTsbError.ModuleNotFound, err.message+' '+filepath);
            return null;
        }
        
        let sourceMapText:string|null = null;
        let stricted = false;

        if (info.kind === ts.ScriptKind.JSON)
        {
            if (this.isEntry)
            {
                switch (bundler.exportRule)
                {
                case ExportRule.None:
                    break;
                case ExportRule.ES2015:
                    this.error(null, IfTsbError.Unsupported, `if-tsb does not support export JSON as ES2015 module`);
                    break;
                case ExportRule.Direct:
                    this.error(null, IfTsbError.Unsupported, `if-tsb does not support export JSON to ${bundler.exportVarName}`);
                    break;
                case ExportRule.Var:
                    refined.content += `return ${sourceFile.text.trim()};\n`;
                    break;
                default:
                    refined.content += `module.exports=${sourceFile.text.trim()};\n`;
                    break;
                }
            }
            else
            {
                if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015)
                {
                    refined.content += `${refined.id.varName}(){\n`;
                }
                else
                {
                    refined.content += `${refined.id.varName}:function(){\n`;
                }
                refined.content += `if(${bundler.globalVarName}.${refined.id.varName}.exports) return ${bundler.globalVarName}.${refined.id.varName}.exports;\n`;
                refined.content += `\nreturn ${bundler.globalVarName}.${refined.id.varName}.exports=${sourceFile.text};\n},\n`;
            }
        }
        else
        {
            let content = '';
            const isEntryModule = this.isEntry;
            const compilerHost:ts.CompilerHost = Object.setPrototypeOf({
                getSourceFile(fileName:string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void, shouldCreateNewSourceFile?: boolean) {
                    if (bundler.faster)
                    {
                        if (path.join(fileName) === filepath) return sourceFile;
                        return undefined;
                    }
    
                    return bundler.getSourceFileSync(fileName, languageVersion);
                },
                writeFile(name:string, text:string) {
                    const info = getScriptKind(name);
                    if (info.kind === ts.ScriptKind.JS) {
                        content = text;
                    }
                    else if (info.kind === ts.ScriptKind.External) {
                        if (isEntryModule)
                        {
                            bundler.taskQueue.ref();
                            if (bundler.verbose) console.log(`${name}: writing`);
                            fsp.writeFile(changeExt(bundler.output, 'd.ts'), text).then(()=>{
                                bundler.taskQueue.unref();
                            }, err=>bundler.taskQueue.error(err));
                        }
                    }
                    else if (info.ext === '.MAP') {
                        sourceMapText = text;
                    }
                },
                fileExists(fileName:string) { return bundler.resolvePath(fileName) === filepath; }
            }, this.bundler.compilerHost);
    
            let diagnostics:ts.Diagnostic[]|undefined = bundler.faster ? undefined : [];
            const program = ts.createProgram([filepath], this.bundler.tsoptions, compilerHost, undefined, diagnostics);
            
            if (diagnostics !== undefined)
            {
                diagnostics.push(...program.getSyntacticDiagnostics(sourceFile));
                // diagnostics.push(...program.getOptionsDiagnostics());
            }
            
            program.emit(
                /*targetSourceFile*/ undefined, 
                /*writeFile*/ undefined, 
                /*cancellationToken*/ undefined, 
                /*emitOnlyDtsFiles*/ undefined, 
                { 
                    after: [factory] 
                });
            
            if (diagnostics !== undefined && diagnostics.length !== 0)
            {
                refined!.errored = true;
                this.bundler.main.reportFromDiagnostics(diagnostics);
            }
            if (!content)
            {
                if (diagnostics === undefined)
                {
                    diagnostics = [...program.getSyntacticDiagnostics(sourceFile)];
                    this.bundler.main.reportFromDiagnostics(diagnostics);
                }
                this.bundler.main.reportMessage(IfTsbError.Unsupported, `Failed to parse ${filepath}`);
                return null;
            }
            
            const stripper = new LineStripper(content);
            refined.firstLineComment = stripper.strip(line=>line.startsWith('#'));
            stricted = (stripper.strip(line=>line==='"use strict";') !== null) || (stripper.strip(line=>line==="'use strict';") !== null);
            stripper.strip(line=>line==='Object.defineProperty(exports, "__esModule", { value: true });');
            stripper.strip(line=>line==='exports.__esModule = true;');
        
            let lastLineIdx = content.lastIndexOf('\n')+1;
            let contentEnd = content.length;
            const lastLine = content.substr(lastLineIdx);
            if (lastLine.startsWith('//# sourceMappingURL='))
            {
                lastLineIdx -= 2;
                if (content.charAt(lastLineIdx) !== '\r') lastLineIdx++;
                contentEnd = lastLineIdx;
            }
            if (this.isEntry)
            {
                let exportTarget = '{}';
                switch (bundler.exportRule)
                {
                case ExportRule.Direct:
                    exportTarget = bundler.exportVarName!;
                case ExportRule.Var:
                    if (useExports)
                    {
                        refined.content += `${bundler.constKeyword} exports=${exportTarget};\n`;
                        if (useModule)
                        {
                            if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015)
                            {
                                refined.content += `const module={exports}\n`;
                            }
                            else
                            {
                                refined.content += `var module={exports:exports}\n`;
                            }
                        }
                    }
                    else
                    {
                        if (useModule)
                        {
                            refined.content += `${bundler.constKeyword} module={}\n`;
                        }
                    }
                    break;
                }
            }
            else
            {
                const useStrict = !bundler.tsoptions.alwaysStrict && stricted;
    
                if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015)
                {
                    refined.content += `${refined.id.varName}(){\n`;
                }
                else
                {
                    refined.content += `${refined.id.varName}:function(){\n`;
                }
                if (useStrict) refined.content += '"use strict";\n';
                
                refined.content += `if(${bundler.globalVarName}.${refined.id.varName}.exports) return ${bundler.globalVarName}.${refined.id.varName}.exports;\n`;
                refined.content += `${bundler.constKeyword} exports=${bundler.globalVarName}.${refined.id.varName}.exports={};\n`;
                if (useModule)
                {
                    if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015)
                    {
                        refined.content += `const module={exports};\n`;
                    }
                    else
                    {
                        refined.content += `var module={exports:exports};\n`;
                    }
                }
            }
    
            if (useFileName || useDirName)
            {
                const prefix = this.isEntry ? '' : `${bundler.constKeyword} `;
                let rpath = path.relative(path.dirname(bundler.output), this.id.apath);
                if (useFileName)
                {
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__filename=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    addExternalList('path', ExternalMode.Preimport, null);
                    addExternalList('__resolve', ExternalMode.Manual, null);
                    addExternalList('__dirname', ExternalMode.Manual, null);
                }
                if (useDirName)
                {
                    rpath = path.dirname(rpath);
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__dirname=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    addExternalList('path', ExternalMode.Preimport, null);
                    addExternalList('__resolve', ExternalMode.Manual, null);
                    addExternalList('__dirname', ExternalMode.Manual, null);
                }
            }
            refined.content += stripper.strippedComments;
    
            refined.sourceMapOutputLineOffset = count(refined.content, '\n') - stripper.stripedLine;
            refined.content += content.substring(stripper.index, contentEnd);
            refined.content += '\n';
            if (this.isEntry)
            {
                switch (bundler.exportRule)
                {
                case ExportRule.Var:
                    if (useExports)
                    {
                        if (useModule)
                        {
                            refined.content += `return module.exports;\n`;
                        }
                        else
                        {
                            refined.content += `return exports;\n`;
                        }
                    }
                    else
                    {
                        refined.content += `return {};\n`;
                    }
                    break;
                }
            }
            else
            {
                if (useModule) refined.content += `return ${bundler.globalVarName}.${refined.id.varName}.exports=module.exports;\n`;
                else refined.content += `return exports;\n`;
                refined.content += `},\n`;
            }
            refined.sourceMapText = sourceMapText;
        }

        refined.outputLineCount = count(refined.content, '\n');
        refined.size = refined.content.length + 2048;
        refined.save(bundler);
        return refined;
    }
}

export class BundlerModuleId
{
    constructor(
        public readonly number:number,
        public varName:string,
        public readonly apath:string)
    {
    }
}

export class BundlerMainContext
{
    public errorCount = 0;
    private readonly cache:Record<string, Record<string, BundlerModuleId>>;
    private readonly cacheUnusingId:number[] = [];
    private lastCacheId = -1;
    public cacheJsonModified = false;
    private readonly outputs = new Set<string>();

    constructor()
    {
        process.on('exit', ()=>this.saveCacheJson());
        
        try
        {
            const cache = JSON.parse(fs.readFileSync(cacheMapPath, 'utf-8'));;
            if (cache.version !== CACHE_VERSION)
            {
                this.cache = {};
                this.lastCacheId = -1;
                return;
            }
            delete cache.version;
            this.cache = cache;
            let count = 0;
            const using = new Set<number>();
            for (const entryApath in this.cache)
            {
                const cache = this.cache[entryApath];
                for (const apath in cache)
                {
                    const id = cache[apath];
                    cache[apath] = new BundlerModuleId(id.number, id.varName, apath);
                    if (id.number >= 0) {
                        if (using.has(id.number)) {
                            console.error(colors.red(`if-tsb: cache file is corrupted (${apath})`));
                            delete cache[apath];
                        } else {
                            count++;
                            using.add(id.number);
                        }
                    }
                }
            }
            for (let i=0; count !== 0; i++)
            {
                if (using.has(i))
                {
                    count--;
                    this.lastCacheId = i;
                    continue;
                }
                this.cacheUnusingId.push(i);
            }
        }
        catch (err)
        {
            this.cache = {};
            this.lastCacheId = -1;
        }
    }

    saveCacheJson():void
    {
        if (!this.cacheJsonModified) return;
        this.cacheJsonModified = false;

        const output:Record<string, any> = {};
        output.version = CACHE_VERSION;
        for (const entrypath in this.cache)
        {
            const cache = this.cache[entrypath];
            const outcache:Record<string,any> = output[entrypath] = {};
            for (const apath in cache)
            {
                const id = cache[apath];
                outcache[apath] = {
                    number:id.number,
                    varName:id.varName
                };
            }
        }
        fs.writeFileSync(cacheMapPath, JSON.stringify(output), 'utf-8');
    }

    reportFromDiagnostics(diagnostics:readonly ts.Diagnostic[]):void
    {
        this.errorCount++;
        console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, defaultFormatHost));
    }

    /**
     * mimic TS errors
     */
    report(source:string, line:number, column:number, code:number, message:string, lineText:string, width:number):void
    {
        this.errorCount++;
        
        const linestr = line+'';
        console.log(`${colors.cyan(source)}:${colors.yellow(linestr)}:${colors.yellow((column)+'')} - ${colors.red('error')} ${colors.gray('TS'+code+':')} ${message}`);
        console.log();

        if (line !== 0) {
            console.log(colors.black(colors.bgWhite(linestr))+' '+lineText);
            console.log(colors.bgWhite(' '.repeat(linestr.length))+' '.repeat(column+1)+colors.red('~'.repeat(width)));
            console.log();   
        }
    }

    /**
     * mimic TS errors
     */
    reportMessage(code:number, message:string):void
    {
        this.errorCount++;
        console.log(`${colors.red('error')} ${colors.gray(`TS${code}:`)} ${message}`);
    }

    /**
     * mimic TS errors
     */
    reportFromCatch(err:any):boolean
    {
        if (err.code === 'ENOENT')
        {
            this.reportMessage(IfTsbError.ModuleNotFound, err.message);
            return true;
        }
        this.errorCount++;
        console.error(err);
        return false;
    }

    getErrorCountString():string
    {
        if (this.errorCount === 1)
            return `Found 1 error`;
        else 
            return `Found ${this.errorCount} errors`;
    }

    private _removeCache(bundler:Bundler, cache:Record<string, BundlerModuleId>, id:BundlerModuleId):void
    {
        bundler.deleteModuleVarName(id.varName);
        if (id.number < 0) return;
        this.freeCacheId(id.number);
        delete cache[id.apath];
        this.cacheJsonModified = true;

        namelock.lock(id.number);
        function unlock(){ namelock.unlock((id as BundlerModuleId).number); }
        fsp.unlink(getCacheFilePath(id)).then(unlock, unlock);
    }

    clearCache(bundler:Bundler, modules:Map<string, BundlerModule>):void
    {
        const map = this.cache[bundler.entryApath];
        if (!map) return;

        const names = new Set<string>(modules.keys());
        for (const apath in map)
        {
            if (names.has(apath)) continue;
            this._removeCache(bundler, map, map[apath]);
        }
    }


    allocateCacheId():number
    {
        if (this.cacheUnusingId.length === 0)
        {
            return ++this.lastCacheId;
        }
        else
        {
            return this.cacheUnusingId.pop()!;
        }
    }

    freeCacheId(id:number):void
    {
        if (id < 0) return;
        if (id === this.lastCacheId)
        {
            --this.lastCacheId;

            for (;;)
            {
                const idx = this.cacheUnusingId.lastIndexOf(this.lastCacheId);
                if (idx === -1) return;
                this.lastCacheId--;
                const last = this.cacheUnusingId.pop()!;
                if (last === this.lastCacheId) continue;
                this.cacheUnusingId[idx] = last;
            }
        }
        else
        {
            this.cacheUnusingId.push(id);
        }
    }

    getCacheMap(apath:string):Record<string,BundlerModuleId>
    {
        const map = this.cache[apath];
        if (map) return map;
        return this.cache[apath] = {};
    }

    private _makeBundlers(options:TsConfig, basedir:string, tsconfig:string|null, compilerOptions:ts.CompilerOptions):Bundler[]
    {
        for (const key in defaultCompilerOptions)
        {
            if (compilerOptions[key] !== undefined) continue;
            compilerOptions[key] = defaultCompilerOptions[key];
        }

        if (compilerOptions.module !== ts.ModuleKind.CommonJS)
        {
            if (compilerOptions.module === undefined) compilerOptions.module = ts.ModuleKind.None;
            options.bundlerOptions = Object.assign({}, options.bundlerOptions);
            options.bundlerOptions.module = ts.ModuleKind[compilerOptions.module!];
            compilerOptions.module = ts.ModuleKind.CommonJS;
        }

        let entry = options.entry;
        if (entry === undefined)
        {
            const name = './index.ts';
            entry = {[name]: getOutFileName(options, name)};
        }
        else if (typeof entry === 'string')
        {
            entry = {[entry]: getOutFileName(options, entry)};
        }
        else if (entry instanceof Array)
        {
            const out:Record<string, string> = {};
            for (const filepath of entry)
            {
                out[filepath] = getOutFileName(options, filepath);
            }
            entry = out;
        }
        const bundlers:Bundler[] = [];
        for (const entryfile in entry)
        {
            let output = entry[entryfile];
            let newoptions = options;
            if (typeof output === 'object')
            {
                newoptions = Object.assign({}, newoptions);
                newoptions.bundlerOptions = Object.assign({}, output, newoptions.bundlerOptions);
                output = getOutFileName(newoptions, entryfile);
            }
            const resolvedOutput = path.resolve(basedir, output);
            if (this.outputs.has(resolvedOutput))
            {
                this.reportMessage(IfTsbError.Dupplicated, `outputs are dupplicated. ${output}`);
                continue;
            }
            try
            {
                const bundler = new Bundler(this, basedir, entryfile, resolvedOutput, newoptions, tsconfig, compilerOptions);
                bundlers.push(bundler);
                const cache = this.cache[bundler.entryApath];
                for (const apath in cache)
                {
                    const moduleId = cache[apath];
                    const oldid = bundler.addModuleVarName(moduleId);
                    if (oldid !== null)
                    {
                        this._removeCache(bundler, cache, oldid);
                        this._removeCache(bundler, cache, moduleId);
                    }
                }
            }
            catch (err)
            {
                this.reportFromCatch(err);
            }
        }
        return bundlers;
    }

    makeBundlersWithPath(configPath:string, output?:string):Bundler[]
    {
        configPath = path.resolve(configPath);
        let basedir:string;
        try
        {
            const stat = fs.statSync(configPath);
            if (stat.isDirectory())
            {
                basedir = configPath;
                const npath = path.join(configPath, 'tsconfig.json');
                if (fs.existsSync(npath))
                {
                    configPath = npath;
                }
                else
                {
                    configPath = path.join(configPath, 'index.ts');
                }
            }
            else
            {
                basedir = path.dirname(configPath);
            }

            if (configPath.endsWith('.json'))
            {
                const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
                const tsoptions = ts.parseJsonConfigFileContent(configFile.config, ts.sys, './').options;
        
                if (configFile.error)
                {
                    console.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], defaultFormatHost));
                }
                const options = configFile.config as TsConfig;
                if (output) options.output = output;
                return this._makeBundlers(
                    options, 
                    basedir,
                    configPath,
                    tsoptions);
            }
            else
            {
                return this._makeBundlers(
                    { entry: configPath, output }, 
                    basedir,
                    null,
                    {});
            }
        }
        catch (err)
        {
            this.reportFromCatch(err);
            return [];
        }
    }

    makeBundlers(options:TsConfig):Bundler[]
    {
        let tsoptions:ts.CompilerOptions;
        let tsconfig:string|null = null;
        const basedir = process.cwd();
        
        try
        {
            if (options.compilerOptions)
            {
                tsoptions = options.compilerOptions;
            }
            else
            {
                tsconfig = path.resolve('./tsconfig.json');
                const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile);
                tsoptions = ts.parseJsonConfigFileContent(configFile.config, ts.sys, './').options;
            }
        }
        catch (err)
        {
            this.reportFromCatch(err);
            return [];
        }

        return this._makeBundlers(options, basedir, tsconfig, tsoptions);
    }
}

export async function clearBundlerCache():Promise<void>
{
    const filecount = await fsp.deleteAll(cacheDir);

    if (filecount === 1) console.log(`${filecount} cache file deleted`);
    else console.log(`${filecount} cache files deleted`);
}

export async function bundle(entries:string[], output?:string):Promise<void>
{
    mkdirRecursiveSync(cacheDir);
    const started = process.hrtime();
    const ctx = new BundlerMainContext;
    const bundlers:Bundler[] = [];
    for (const p of entries)
    {
        bundlers.push(...ctx.makeBundlersWithPath(p, output));
    }
    for (const bundler of bundlers)
    {
        try
        {
            await bundler.bundle();
        }
        catch (err)
        {
            ctx.reportFromCatch(err);
        }
    }
    ctx.saveCacheJson();
    if (ctx.errorCount !== 0)
    {
        console.error(ctx.getErrorCountString());
    }
    await namelock.waitAll();
    const duration = process.hrtime(started);
    console.log((duration[0]*1000+duration[1]/1000000).toFixed(6)+'ms');
}

export function bundleWatch(entries:string[], output?:string):void
{
    mkdirRecursiveSync(cacheDir);
    (async()=>{
        const ctx = new BundlerMainContext;
        const bundlers:Bundler[] = [];
        for (const p of entries)
        {
            bundlers.push(...ctx.makeBundlersWithPath(p, output));
        }
        if (bundlers.length === 0) return;
        
        async function bundle(infos:[Bundler, string[]][]):Promise<void>
        {
            const started = process.hrtime();
            watcher.pause();
            if (infos.length === 0)
            {
                console.log('no changes');
            }
            else
            {
                const reloads = new Set<string>();

                for (const [bundler, modifies] of infos)
                {
                    if (bundler.tsconfig !== null && modifies.indexOf(bundler.tsconfig) !== -1)
                    {
                        watcher.clear(bundler);
                        reloads.add(bundler.tsconfig);
                        continue;
                    }
                    try
                    {
                        await bundler.bundle();
                    }
                    catch (err)
                    {
                        ctx.reportFromCatch(err);
                    }
                    const files = bundler.deplist;
                    watcher.reset(bundler, files);
                }

                for (const tsconfigPath of reloads)
                {
                    for (const bundler of ctx.makeBundlersWithPath(tsconfigPath, output))
                    {
                        try
                        {
                            await bundler.bundle();
                        }
                        catch (err)
                        {
                            ctx.reportFromCatch(err);
                        }
                        const files = bundler.deplist;
                        watcher.reset(bundler, files);
                    }
                }
            }

            console.log(`[${time()}] ${ctx.getErrorCountString()}. Watching for file changes.`);
            ctx.errorCount = 0;
            ctx.saveCacheJson();
            watcher.resume();

            const duration = process.hrtime(started);
            console.log((duration[0]*1000+duration[1]/1000000).toFixed(6)+'ms');
        }

        // avg watch waiting settings
        let clearConsole = false;
        let watchWaiting = 0;
        let watchWaitingCount = 0;
        let cacheMemory = 0;
        let cacheMemoryCount = 0;
        for (const bundler of bundlers)
        {
            if (bundler.clearConsole) clearConsole = true;
            if (bundler.watchWaiting !== undefined)
            {
                watchWaiting += bundler.watchWaiting;
                watchWaitingCount ++;
            }
            if (bundler.cacheMemory !== undefined)
            {
                cacheMemory += bundler.cacheMemory;
                cacheMemoryCount ++;
            }
        }
        if (watchWaitingCount === 0) watchWaiting = 30;
        else watchWaiting /= watchWaitingCount;
        if (cacheMemoryCount === 0) cacheMemory = CACHE_MEMORY_DEFAULT;
        else cacheMemory /= cacheMemoryCount;
        memoryCache.maximum = cacheMemory;

        // watch
        const watcher = new FilesWatcher<Bundler>(watchWaiting, async(list)=>{
            if (clearConsole)
            {
                if ((console as any).clear) (console as any).clear();
                else console.log(`node@${process.version} does not support console.clear`);
            }
            console.log(`[${time()}] File change detected. Starting incremental compilation...`);
            bundle([...list]);
        });
        console.log(`[${time()}] Starting compilation in watch mode...`);
        bundle(bundlers.map(bundle=>[bundle, []]));
    })();
}
