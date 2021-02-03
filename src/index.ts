
if (!Date.now) Date.now = ()=>+new Date();

import ts = require('typescript');
import fs = require('fs');
import path = require('path');
import sourceMap = require('source-map');
import { identifierValidating } from './checkvar';
import { ErrorPosition } from './errpos';
import { findCacheDir } from './findcachedir';
import { fsp, mkdirRecursiveSync } from './fsp';
import { LineStripper } from './linestripper';
import { MemoryManager } from './memmgr';
import { namelock } from './namelock';
import { WriterStream as FileWriter } from './streamwriter';
import { changeExt, ConcurrencyQueue, count, defaultFormatHost, getScriptKind, joinModulePath, parsePostfix, resolved, SkipableTaskQueue, splitContent, time } from './util';
import { FilesWatcher } from './watch';
import colors = require('colors');
import globToRegExp = require('glob-to-regexp');

const cacheDir = findCacheDir('if-tsb') || './.if-tsb.cache';
const cacheMapPath = path.join(cacheDir, 'cachemap.json');
const builtin = new Set<string>(require('module').builtinModules);
const CACHE_SIGNATURE = '\nTSBC-0.7';
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

export class RefinedModule
{
    firstLineComment:string|null = null;
    sourceMapOutputLineOffset:number = 0;
    outputLineCount:number;
    importPathes:string[];
    importModulePathes:string[];
    importLines: (ErrorPosition|null)[];
    sourceMapText:string|null = null;
    content:string = '';
    size:number;

    constructor(public readonly id:BundlerModuleId, public readonly mtime:number)
    {
    }

    private readonly saving = new SkipableTaskQueue;

    clear():void
    {
        this.firstLineComment = null;
        this.importModulePathes.length = 0;
        this.importPathes.length = 0;
        this.importLines.length = 0;
        this.sourceMapText = null;
        this.content = '';
        this.size = 0;
    }

    save(bundler:Bundler):void
    {
        bundler.taskQueue.ref();
        this.saving.run(async()=>{
            try
            {
                namelock.lock(this.id.number);
                const writer = new FileWriter(getCacheFilePath(this.id));
                await writer.write(this.importPathes.join(path.delimiter)+'\n');
                await writer.write(this.importModulePathes.join(path.delimiter)+'\n');
                await writer.write(ErrorPosition.stringify(this.importLines)+'\n');
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
            importPathes, 
            importModulePathes, 
            importLines,
            firstLineComment, 
            sourceMapOutputLineOffset,
            outputLineCount,
            sourceMapText,
            source
        ] = splitContent(content, 6, '\n');
        this.importPathes = importPathes === '' ? [] : importPathes.split(path.delimiter);
        this.importModulePathes = importModulePathes === '' ? [] : importModulePathes.split(path.delimiter);
        this.importLines = ErrorPosition.parse(importLines);
        this.firstLineComment = firstLineComment || null;
        this.sourceMapOutputLineOffset = +sourceMapOutputLineOffset;
        this.outputLineCount = +outputLineCount;
        this.sourceMapText = sourceMapText || null;
        this.content = source.substr(0, source.length - CACHE_SIGNATURE.length);
        this.size = this.content.length + 2048;
    }
    
    static async loadCacheIfNotModified(id:BundlerModuleId, tsconfigMtime:number):Promise<RefinedModule|null>
    {
        try
        {
            const cached = memoryCache.get(id.number);
            if (cached !== undefined)
            {
                const file = await fsp.stat(id.apath);
                if (cached.mtime < tsconfigMtime) return null;
                if (cached.mtime < +file.mtime) return null;
                return cached;
            }
            else
            {
                let cachemtime = 0;
                try
                {
                    namelock.lock(id.number);
                    const cachepath = getCacheFilePath(id);
                    const [cache, file] = await Promise.all([fsp.stat(cachepath), fsp.stat(id.apath)]);
                    cachemtime = +cache.mtime;
                    if (cachemtime < tsconfigMtime) return null;
                    if (cachemtime < +file.mtime) return null;
                }
                finally
                {
                    namelock.unlock(id.number);
                }
                const refined = new RefinedModule(id, cachemtime);
                await refined.load();
                return refined;
            }
        }
        catch (err)
        {
            return null;
        }
    }
    
}

export class Bundler
{
    private readonly names = new Map<string, BundlerModuleId>();

    private writingProm:Promise<FileWriter>|null = null;
    private mapgen:sourceMap.SourceMapGenerator|null = null;
    private entryModule:BundlerModule|null = null;
    private lineOffset = 0;
    public entryModuleIsAccessed = false;
    public useDirNameResolver = false;
    public readonly preimport = new Set<string>();

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

    public readonly modules = new Map<string, BundlerModule>();
    public readonly taskQueue = new ConcurrencyQueue;
    private readonly sourceFileCache = new Map<string, ts.SourceFile>();
    public readonly tsconfigMtime:number;
    public readonly moduleResolutionCache:ts.ModuleResolutionCache;
    public readonly sys:ts.System;
    public readonly compilerHost:ts.CompilerHost;
    public readonly entryApath:string;
    public readonly entryRpath:string;
    public readonly constKeyword:string;

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

        this.globalVarName = boptions.globalModuleVarName || '__tsb';
        this.clearConsole = boptions.clearConsole || false;
        this.verbose = boptions.verbose || false;
        this.checkCircularDependency = boptions.checkCircularDependency || false;
        this.suppressDynamicImportErrors = boptions.suppressDynamicImportErrors || false;
        this.faster = boptions.faster || false;
        this.watchWaiting = boptions.watchWaiting;
        this.bundleExternals = boptions.bundleExternals || false;
        this.externals = boptions.externals ? boptions.externals.map(glob=>globToRegExp(glob)) : [];
        this.cacheMemory = parsePostfix(boptions.cacheMemory);
        if (boptions.module === undefined)
        {
            this.exportRule = ExportRule.None;
        }
        else
        {
            const exportRule = boptions.module.toLowerCase();
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

    restoreModuleVarName(id:BundlerModuleId):BundlerModuleId|null
    {
        const oldid = this.names.get(id.varName);
        if (oldid !== undefined)
        {
            return oldid;
        }
        this.names.set(id.varName, id);
        return null;
    }

    allocModuleVarName(id:BundlerModuleId, name:string):string
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
        this.names.set(name, id);
        return name;
    }

    deleteModuleVarName(name:string):boolean
    {
        return this.names.delete(name);
    }
    
    async write(module:BundlerModule, refined:RefinedModule):Promise<void>
    {
        if (this.verbose) console.log(refined.id.apath+': writing');
        const writer = await this._lock();
        try
        {
            await writer.write(refined.content);
        }
        finally
        {
            this._unlock();
        }
        const offset = this.lineOffset + refined.sourceMapOutputLineOffset;
        this.lineOffset += refined.outputLineCount;

        if (refined.sourceMapText)
        {
            try
            {
                let rpath = path.relative(this.outdir, refined.id.apath).replace(/\\/g, '/');
                // if (!path.isAbsolute(rpath) && !rpath.startsWith('.')) rpath = './'+rpath;
                const consumer = new sourceMap.SourceMapConsumer(JSON.parse(refined.sourceMapText));
                consumer.eachMapping(entry=>{
                  this.mapgen!.addMapping({
                    generated:{
                      column: entry.generatedColumn,
                      line: entry.generatedLine + offset,
                    },
                    original:{
                      column: entry.originalColumn,
                      line: entry.originalLine,
                    },
                    name: entry.name,
                    source: rpath
                  });
                });
            }
            catch (err)
            {
                module.error(null, IfTsbError.InternalError, `Invalid source map (${refined.sourceMapText.substr(0, 16)})`);
            }
        }
    }
        
    async bundle():Promise<boolean>
    {
        if (this.writingProm !== null) throw Error('bundler is busy');
        this.mapgen = new sourceMap.SourceMapGenerator({
            file:'./'+path.basename(this.output)
        });
        
        this.entryModule = null;
        this.modules.clear(); // must not clear at end, it's accessed by the watcher
        
        const filename = path.basename(this.entryApath);
        const mpath = filename.substr(0, filename.length - getScriptKind(filename).ext.length);

        let resolveWriter:(writer:FileWriter)=>void;
        let rejectWriter:(err:Error)=>void;
        this.writingProm = new Promise((resolve, reject)=>{
            resolveWriter = resolve;
            rejectWriter = reject;
        });

        let writer:FileWriter|null = null;

        this.entryModule = this.getModule(null, true, './'+mpath, this.entryApath);
        this.entryModule.isAppended = true;
        let refined:RefinedModule|null = null;
        this.taskQueue.run(async()=>{
            try
            {
                refined = await this.entryModule!.append();
                if (refined === null) return;
                await fsp.mkdirRecursive(this.outdir);
        
                await this._lockWithoutWriter();
                try
                {
                    writer = new FileWriter(this.output);
                    if (refined.firstLineComment !== null)
                    {
                        await writer.write(refined.firstLineComment+'\n');
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

        if (this.preimport.size !== 0)
        {
            await writer!.write(`__m:{\n`);
            for (const name of this.preimport.values())
            {
                await writer!.write(`    ${name}:require('${name}'),\n`);
                this.lineOffset ++;
            }
            await writer!.write(`},\n`);
        }
        if (this.useDirNameResolver)
        {
            if (this.tsoptions.target! >= ts.ScriptTarget.ES2015)
            {
                await writer!.write(`__resolve(rpath){\n`);
            }
            else
            {
                await writer!.write(`__resolve:function(rpath){\n`);
            }
            await writer!.write(`return this.__m.path.join(this.__dirname, rpath)\n},\n`);
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
        await this.write(this.entryModule, refined!);
        if (this.verbose) console.log(this.entryRpath+': writing end');
        memoryCache.release(refined!.id.number, refined!);

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
        })(), fsp.writeFile(this.output+'.map', this.mapgen!.toString())]);

        this.main.clearCache(this, this.modules);

        if (this.verbose) console.log(this.entryRpath+': done');
        this.mapgen = null;
        this.lineOffset = 0;
        this.writingProm = null;
        this.sourceFileCache.clear();
        
        function checkModuleDep(parent:BundlerModule):boolean
        {
            if (parent.checkState === CheckState.Checked) return false;
            if (parent.checkState === CheckState.Entered) return true;

            const n = parent.children.length;
            for (let i=0;i<n;i++)
            {
                const child = parent.children[i];
                if (checkModuleDep(child))
                {
                    const parents = child.getParents();
                    parents.reverse();
                    parents.push(child);
                    child.error(child.importLines![i], 1005, 'Circular dependency '+parents.map(m=>colors.yellow(m.rpath)).join(' → '));
                }
            }
            parent.checkState = CheckState.Checked;
            return false;
        }   

        if (this.checkCircularDependency)
        {
            checkModuleDep(this.entryModule!);
        }

        // const sourceMapContent = await fsp.readFile(this.output+'.map', 'utf-8');
        // const content = await fsp.readFile(this.output, 'utf-8');
        // const validate = await import('sourcemap-validator');
        // const modules:Record<string, string> = {};
        // for (const module of this.modules.values())
        // {
        //     const rpath = path.relative(this.outdir, module.id.apath).replace(/\\/g, '/');
        //     modules[rpath] = await fsp.readFile(module.id.apath, 'utf-8');
        // }
        // validate(content, sourceMapContent, modules);

        return true;
    }

    getModule(parent:BundlerModule|null, isEntry:boolean, mpath:string, apath:string):BundlerModule
    {
        let module = this.modules.get(apath);
        if (module) return module;
        
        module = new BundlerModule(this, parent, isEntry, mpath, apath);
        this.modules.set(apath, module);
        return module;
    }
}

export class BundlerModule
{
    public readonly id:BundlerModuleId;
    public readonly rpath:string;
    public readonly children:BundlerModule[] = [];
    public importLines:(ErrorPosition|null)[]|null = null;
    public isAppended = false;
    public checkState = CheckState.None;

    constructor(
        public readonly bundler:Bundler, 
        public readonly parent:BundlerModule|null,
        public readonly isEntry:boolean,
        public readonly mpath:string,
        apath:string)
    {
        this.id = bundler.main.getModuleId(bundler, apath, isEntry);
        this.rpath = path.relative(bundler.basedir, apath);
    }

    error(pos:ErrorPosition|null, code:number, message:string):void
    {
        if (pos === null)
        {
            this.bundler.main.reportMessage(code, message);
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

    getParents():BundlerModule[]
    {
        const out:BundlerModule[] = [this];

        let node = this.parent;
        while (node !== null)
        {
            out.push(node);
            node = node.parent;
        }
        return out;
    }

    private async _refine():Promise<RefinedModule|null>
    {
        const refined = new RefinedModule(this.id, Date.now());

        let doNotSave = false;
        let useDirName = false;
        let useFileName = false;
        let useModule = false;
        let useExports = false;
        const bundler = this.bundler;
        const basedir = bundler.basedir;

        const importPaths:string[] = [];
        const importModulePathes:string[] = [];
        const importLines:(ErrorPosition|null)[] = [];
        refined.importPathes = importPaths;
        refined.importModulePathes = importModulePathes;
        refined.importLines = this.importLines = importLines;
        refined.content = `// ${this.rpath}\n`;


        const factory = (ctx:ts.TransformationContext)=>{
            const stacks:ts.Node[] = [];

            const getErrorPosition = ():ErrorPosition|null=>{
                for (let i = stacks.length-1; i >= 0; i--)
                {
                    let node = stacks[i];
                    const ori  =(node as any).original;
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
                        doNotSave = true;
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

                const mpath = joinModulePath(this.mpath, importName);
                if (mpath === 'path')
                {
                    bundler.preimport.add('path');
                    return ctx.factory.createPropertyAccessExpression(
                        ctx.factory.createPropertyAccessExpression(
                            ctx.factory.createIdentifier(this.bundler.globalVarName),
                            ctx.factory.createIdentifier('__m')),
                            ctx.factory.createIdentifier('path'));
                }
                for (const glob of this.bundler.externals)
                {
                    if (glob.test(mpath)) return base;
                }

                let module = ts.nodeModuleNameResolver(importName, this.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
                if (!module.resolvedModule && importName === '.') 
                    module = ts.nodeModuleNameResolver(path.join(basedir, 'index'), this.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
                const info = module.resolvedModule;
                if (!info)
                {
                    if (!importName.startsWith('.'))
                    {
                        if (builtin.has(importName))
                        {
                            bundler.preimport.add(importName);
                            return ctx.factory.createPropertyAccessExpression(
                                ctx.factory.createPropertyAccessExpression(
                                    ctx.factory.createIdentifier(this.bundler.globalVarName),
                                    ctx.factory.createIdentifier('__m')),
                                    ctx.factory.createIdentifier(importName));
                        }
                        if (!this.bundler.bundleExternals) return base;
                    }
                    doNotSave = true;
                    this.error(getErrorPosition(), 2307, `Cannot find module '${importName}' or its corresponding type declarations.`);
                    return base;
                }

                if (info.isExternalLibraryImport)
                {
                    if (!this.bundler.bundleExternals) return base;
                }
                
                let filepath = path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(bundler.basedir, info.resolvedFileName);
                const kind = getScriptKind(filepath);
                if (kind.kind === ts.ScriptKind.External)
                {
                    filepath = filepath.substr(0, filepath.length-kind.ext.length+1)+'js';
                    if (!fs.existsSync(filepath))
                    {
                        doNotSave = true;
                        this.error(getErrorPosition(), 2307, `Cannot find module '${node.text}' or its corresponding type declarations.`);
                        return base;
                    }
                }
    
                const childModule = bundler.getModule(this, false, mpath, filepath);
                importPaths.push(filepath);
                importModulePathes.push(mpath);
                importLines.push(getErrorPosition());
                this.children.push(childModule);

                if (childModule.isEntry)
                {
                    bundler.entryModuleIsAccessed = true;
                    return ctx.factory.createPropertyAccessExpression(
                        ctx.factory.createIdentifier(this.bundler.globalVarName),
                        ctx.factory.createIdentifier(childModule.id.varName));
                }
        
                return ctx.factory.createCallExpression(
                    ctx.factory.createPropertyAccessExpression(
                        ctx.factory.createIdentifier(this.bundler.globalVarName), 
                        ctx.factory.createIdentifier(childModule.id.varName)), 
                    [], []);
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
                        doNotSave = true;
                        this.error(getErrorPosition(), 1005, `Cannot call import with multiple parameters`);
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
                    }
                    }
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
            this.bundler.main.reportMessage(6053, err.message+' '+filepath);
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
                    refined.content += `return ${sourceFile.text};\n`;
                    break;
                default:
                    refined.content += `module.exports=${sourceFile.text};\n`;
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
                doNotSave = true;
                this.bundler.main.reportFromDiagnostics(diagnostics);
            }
            if (!content)
            {
                if (diagnostics === undefined)
                {
                    diagnostics = [...program.getSyntacticDiagnostics(sourceFile)];
                    this.bundler.main.reportFromDiagnostics(diagnostics);
                }
                this.bundler.main.reportMessage(6053, `Failed to parse ${filepath}`);
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
                const prefix = this.isEntry ? `${bundler.constKeyword} ` : '';
                let rpath = path.relative(bundler.output, this.id.apath);
                if (useFileName)
                {
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__filename=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    bundler.preimport.add('path');
                    bundler.useDirNameResolver = true;
                }
                if (useDirName)
                {
                    rpath = path.dirname(rpath);
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__dirname=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    bundler.preimport.add('path');
                    bundler.useDirNameResolver = true;
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
        if (!doNotSave) refined.save(bundler);
        return refined;
    }

    async append():Promise<RefinedModule|null>
    {
        let refined = await RefinedModule.loadCacheIfNotModified(this.id, this.bundler.tsconfigMtime);
        if (refined === null)
        {
            refined = await this._refine();
            if (refined === null) return null;
        }

        const bundler = this.bundler;
        const n = refined.importPathes.length;
        if (n !== this.children.length)
        {
            this.children.length = n;
            for (let i=0;i<n;i++)
            {
                this.children[i] = bundler.getModule(this, false, refined.importModulePathes[i], refined.importPathes[i]);
            }
            this.importLines = refined.importLines;
        }
        for (let i=0;i<n;i++)
        {
            const module = this.children[i];
            if (module.isAppended) continue;
            module.isAppended = true;
            bundler.taskQueue.run(async()=>{
                const refined = await module.append();
                if (refined === null) return;
                await bundler.write(module, refined);
                memoryCache.release(refined.id.number, refined);
            });
        }
        return refined;
    }
}

export interface BundlerModuleId
{
    number:number;
    varName:string;
    apath:string;
}

export class BundlerMainContext
{
    public errorCount = 0;
    private readonly cache:Record<string, Record<string,BundlerModuleId>>;
    private readonly cacheUnusingId:number[] = [];
    private cahceIdCounter = -1;
    private cacheJsonModified = false;
    private readonly outputs = new Set<string>();

    constructor()
    {
        process.on('exit', ()=>this.saveCacheJson());
        
        try
        {
            this.cache = JSON.parse(fs.readFileSync(cacheMapPath, 'utf-8'));
            let count = 0;
            const using = new Set<number>();
            for (const entryApath in this.cache)
            {
                const cache = this.cache[entryApath];
                for (const apath in cache)
                {
                    count++;
                    const id = cache[apath];
                    id.apath = apath;
                    using.add(id.number);
                }
            }
            for (let i=0; count !== 0; i++)
            {
                if (using.has(i))
                {
                    count--;
                    this.cahceIdCounter = i;
                    continue;
                }
                this.cacheUnusingId.push(i);
            }
            this.cahceIdCounter ++;
        }
        catch (err)
        {
            this.cache = {};
            this.cahceIdCounter = 0;
        }
    }

    saveCacheJson():void
    {
        if (!this.cacheJsonModified) return;
        this.cacheJsonModified = false;

        const output:Record<string, Record<string,BundlerModuleId>> = {};
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

        console.log(colors.black(colors.bgWhite(linestr))+' '+lineText);
        console.log(colors.bgWhite(' '.repeat(linestr.length))+' '.repeat(column+1)+colors.red('~'.repeat(width)));
        console.log();
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
            this.reportMessage(6053, err.message);
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
        delete cache[id.apath];
        this.cacheUnusingId.push(id.number);
        bundler.deleteModuleVarName(id.varName);
        this.cacheJsonModified = true;
        namelock.lock(id.number);
        function unlock(){ namelock.unlock(id.number); }
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

    getModuleId(bundler:Bundler, apath:string, isEntry:boolean):BundlerModuleId
    {
        let map = this.cache[bundler.entryApath];
        if (!map) this.cache[bundler.entryApath] = map = {};

        let id = map[apath];
        if (id === undefined)
        {
            let number:number;
            if (this.cacheUnusingId.length === 0)
            {
                number = this.cahceIdCounter++;
            }
            else
            {
                number = this.cacheUnusingId.pop()!;
            }
            

            id = {
                number: number,
                apath,
                varName: ''
            };
            if (isEntry)
            {
                id.varName = '__entry';
                bundler.restoreModuleVarName(id);
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
                id.varName = bundler.allocModuleVarName(id, varName)
            }
            map[apath] = id;
            this.cacheJsonModified = true;
        }
        return id;
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
                this.reportMessage(6053, `outputs are dupplicated. ${output}`);
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
                    const oldid = bundler.restoreModuleVarName(moduleId);
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
                    const files = [...bundler.modules.keys()];
                    if (bundler.tsconfig !== null) files.push(bundler.tsconfig);
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
                        const files = [...bundler.modules.keys()];
                        if (bundler.tsconfig !== null) files.push(bundler.tsconfig);
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
