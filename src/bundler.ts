import ts = require("typescript");
import path = require("path");
import fs = require("fs");
import glob = require('glob');
import { identifierValidating } from "./checkvar";
import { BundlerMainContext } from "./context";
import { BundlerModule, BundlerModuleId, CheckState, memoryCache, RefinedModule } from "./module";
import { SourceMap } from "./sourcemap";
import { WriterStream as FileWriter } from './streamwriter';
import { ExportRule, ExternalMode, IfTsbError, TsConfig } from "./types";
import { ConcurrencyQueue, getScriptKind, parsePostfix, resolved, splitContent } from "./util";
import globToRegExp = require('glob-to-regexp');
import colors = require('colors');
import { fsp } from "./fsp";

class WritingLock {
    
    private readonly writingProm:Promise<FileWriter>|null = null;
    private csResolve:(()=>void)[] = [];
    private csEntered = false;
    
    public resolveWriter:(writer:FileWriter)=>void;

    constructor(public readonly main:BundlerMainContext) {
        this.writingProm = new Promise(resolve=>{
            this.resolveWriter = resolve;
        });
    }

    lockWithoutWriter():Promise<void>
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
    
    async lock():Promise<FileWriter>
    {
        const writer = await this.writingProm!;
        await this.lockWithoutWriter();
        return writer;
    }

    unlock():void
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

}

const libmap = new Map<string, Bundler>();

export class Bundler
{
    private readonly names = new Map<string, BundlerModuleId>();

    private mapgen:SourceMap|null = null;
    private lineOffset = 0;
    public entryModuleIsAccessed = false;

    private lock:WritingLock|null = null;

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
    public readonly exportLib:boolean;

    private readonly moduleByName = new Map<string, BundlerModule>();
    public readonly deplist:string[] = [];
    public readonly taskQueue:ConcurrencyQueue;
    private readonly sourceFileCache = new Map<string, ts.SourceFile>();
    public readonly tsconfigMtime:number;
    public readonly moduleResolutionCache:ts.ModuleResolutionCache;
    public readonly sys:ts.System;
    public readonly compilerHost:ts.CompilerHost;
    public readonly constKeyword:string;
    public readonly preimportTargets:Set<string>;
    private readonly cache:Record<string, BundlerModuleId>;
    private readonly entryApath:string|null = null;

    constructor(
        public readonly main:BundlerMainContext,
        public readonly basedir:string, 
        resolvedOutput:string,
        options:TsConfig, 
        entry:string|null,
        private readonly files:string[],
        public readonly tsconfig:string|null,
        public readonly tsoptions:ts.CompilerOptions)
    {
        this.cache = main.getCacheMap(resolvedOutput);

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

        this.globalVarName = (boptions.globalModuleVarName || '__tsb').toString();
        this.clearConsole = !!boptions.clearConsole;
        this.checkCircularDependency = !!boptions.checkCircularDependency;
        this.suppressDynamicImportErrors = !!boptions.suppressDynamicImportErrors;
        this.faster = !!boptions.faster;
        this.watchWaiting = boptions.watchWaiting;
        this.bundleExternals = !!boptions.bundleExternals;
        this.externals = boptions.externals instanceof Array ? boptions.externals.map(glob=>globToRegExp(glob)) : [];
        this.preimportTargets = boptions.preimport instanceof Array ? new Set(boptions.preimport) : new Set;
        this.preimportTargets.add('tslib');
        this.exportLib = !!boptions.exportLib;

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
        
        if (this.exportLib) {
            this.needWrap = false;
            if (this.exportRule === ExportRule.Var) {
                if (boptions.globalModuleVarName) {
                    main.reportMessage(IfTsbError.Unsupported, 'ignored globalModuleVarName with exportLib to variable');
                }
                this.globalVarName = this.exportVarName!;
            }
        } else {
            this.needWrap = (this.exportRule === ExportRule.Direct) || (this.exportRule === ExportRule.Var);
        }

        this.moduleResolutionCache = ts.createModuleResolutionCache(this.basedir, ts.sys.useCaseSensitiveFileNames ? v=>v.toLocaleLowerCase() : v=>v);
        if (entry !== null) {
            const apath = path.join(this.basedir, entry);
            if (this.exportLib) {
                this.files.push(apath);
            } else {
                this.entryApath = apath;
            }
        }
        this.taskQueue = new ConcurrencyQueue(path.basename(this.entryApath || this.basedir) + ' Task', Number(boptions.concurrency) || undefined);
        this.taskQueue.verbose = this.verbose = !!boptions.verbose;
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
    
    async write(lock:WritingLock, module:BundlerModule, refined:RefinedModule):Promise<void>
    {
        const writer = await lock.lock();
        if (this.verbose) console.log(refined.id.apath+': writing');
        try
        {
            await writer.write(refined.content);
        }
        finally
        {
            if (this.verbose) console.log(refined.id.apath+': writing end');
            lock.unlock();
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

    private async _startWrite(lock:WritingLock, firstLineComment:string|null):Promise<FileWriter> {
        
        await fsp.mkdirRecursive(this.outdir);
        
        await lock.lockWithoutWriter();
        try
        {
            const writer = new FileWriter(this.output);
            if (firstLineComment !== null)
            {
                await writer.write(firstLineComment+'\n');
                this.lineOffset++;
            }
            if (this.tsoptions.alwaysStrict)
            {
                await writer.write('"use strict";\n');
                this.lineOffset++;
            }
            if (this.exportLib) {
                if (this.exportRule === ExportRule.ES2015) {
                    await writer.write(`export const ${this.globalVarName} = {\n`);
                    this.lineOffset++;
                } else if (this.exportRule === ExportRule.Direct) {
                    await writer.write(`${this.exportVarName}.${this.globalVarName} = {\n`);
                    this.lineOffset++;
                } else if (this.exportRule === ExportRule.Var) {
                    await writer.write(`${this.exportVarKeyword} ${this.globalVarName} = {\n`);
                    this.lineOffset++;
                } else {
                    await writer.write(`${this.constKeyword} ${this.globalVarName} = {\n`);
                    this.lineOffset++;
                }
            } else {
                if (this.needWrap) {
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
            }
            return writer;
        }
        finally
        {
            lock.unlock();
        }
    }

    append(lock:WritingLock, module:BundlerModule):void {
        if (module.isAppended) return;
        module.isAppended = true;
        if (module.isEntry) {
            this.entryModuleIsAccessed = true;
            return;
        }
        this.taskQueue.run(async()=>{
            if (this.verbose) console.log(module.id.apath+': refine');
            const refined = await module.refine();
            if (refined === null) {
                module.error(null, IfTsbError.ModuleNotFound, `Cannot find module '${module.mpath}'`);
                try {
                    const writer = await lock.lock();
                    await writer.write(`${module.id.varName}(){ throw Error("Cannot find module '${module.mpath}'"); }\n`);
                } finally {
                    lock.unlock();
                }
                return;
            }
            this.deplist.push(module.id.apath);
            this._appendChildren(lock, module, refined);

            await this.write(lock, module, refined);
            if (!refined.errored) {
                memoryCache.put(refined.id.number, refined);
            }
        });
    }
        
    private _appendChildren(lock:WritingLock, module:BundlerModule, refined:RefinedModule):void
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
                    const childModule = this.getModule(info.apath, info.mpath);
                    module.children.push(childModule);
                    module.importLines.push(info.codepos);
                }
            }
        }
        
        for (const child of module.children) {
            this.append(lock, child);
        }
    }

    private _getEntryModule(apath:string):BundlerModule {
        const entryModule = this.getModule(apath, null, '__entry');
        entryModule.isEntry = true;
        entryModule.isAppended = true;

        this.deplist.push(apath);
        return entryModule;
    }

    async bundle():Promise<boolean> {
        if (this.lock !== null) throw Error('bundler is busy');
        this.clear();

        const lock = this.lock = new WritingLock(this.main);
        this.mapgen = SourceMap.newInstance(this.output);
            
        if (this.tsconfig !== null) this.deplist.push(this.tsconfig);

        if (this.verbose) console.log((this.entryApath || this.basedir)+': starting');
        let entryModule:BundlerModule|null = null;
        let entryRefined:RefinedModule|null = null;
        if (this.entryApath !== null) {
            entryModule = this._getEntryModule(this.entryApath);
            entryRefined = await entryModule.refine();
            if (entryRefined === null) {
                this.lock = null;
                return false;
            }
        }
        
        let writer:FileWriter;
        try
        {
            writer = await this._startWrite(lock, entryRefined !== null ? entryRefined.firstLineComment : null);
            lock.resolveWriter(writer);
        }
        catch (err)
        {
            this.lock = null;
            return false;
        }

        if (entryModule !== null) {
            this._appendChildren(lock, entryModule, entryRefined!);
        }

        for (const apath of this.files) {
            this.append(lock, this.getModule(apath, null));
        }

        await this.taskQueue.onceEnd();

        for (const apath in this.cache)
        {
            const module = this.cache[apath];
            if (module.number !== ExternalMode.Preimport) continue;
            await writer.write(`${module.varName}:require('${apath}'),\n`);
            this.lineOffset ++;
        }
        if ('__resolve' in this.cache)
        {
            if (this.tsoptions.target! >= ts.ScriptTarget.ES2015)
            {
                await writer.write(`__resolve(rpath){\n`);
            }
            else
            {
                await writer.write(`__resolve:function(rpath){\n`);
            }
            const path = this.cache.path;
            await writer.write(`return this.${path.varName}.join(this.__dirname, rpath);\n},\n`);
            if (this.tsoptions.target! >= ts.ScriptTarget.ES2015)
            {
                await writer.write(`__dirname,\n`);
            }
            else
            {
                await writer.write(`__dirname:__dirname,\n`);
            }
            this.lineOffset += 4;
        }

        if (this.entryModuleIsAccessed || this.tsoptions.target! < ts.ScriptTarget.ES5)
        {
            await writer.write(`entry:exports\n};\n`);
            this.lineOffset += 2;
        }
        else
        {
            await writer.write(`};\n`);
            this.lineOffset ++;
        }

        if (entryModule !== null) {
            await this.write(lock, entryModule, entryRefined!);
            memoryCache.put(entryRefined!.id.number, entryRefined!);
        }

        await Promise.all([(async()=>{
            await writer.write('\n');
            if (this.entryModuleIsAccessed)
            {
                await writer.write(`${this.globalVarName}.entry=module.exports;\n`);
            }
            if (this.needWrap)
            {
                if (this.tsoptions.target! >= ts.ScriptTarget.ES2015)
                {
                    // arrow end
                    await writer.write(`})();\n`);
                }
                else
                {
                    if (this.exportRule === ExportRule.Direct && this.exportVarName === 'this')
                    {
                        await writer.write(`}).call(this);\n`);
                    }
                    else
                    {
                        await writer.write(`})();\n`);
                    }
                }
            }
            if (this.exportLib) {
                switch (this.exportRule) {
                case ExportRule.CommonJS:
                    writer.write(`module.exports = ${this.globalVarName};\n`);
                    break;
                }
            }
            await writer.write(`//# sourceMappingURL=${path.basename(this.output)}.map`);
            await writer.end();
        })(), this.mapgen.save()]);

        if (this.verbose) console.log((this.entryApath || this.basedir)+': finished');
        return true;
    }

    checkDeps():void {
        const parents:BundlerModule[] = [];
        function checkModuleDep(m:BundlerModule, i:number):void {
            if (m.checkState === CheckState.Checked) return;
            if (m.checkState === CheckState.Entered) {
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
            for (let i=0;i<n;i++) {
                checkModuleDep(m.children[i], i);
            }
            m.checkState = CheckState.Checked;
            parents.pop();
        }   

        if (this.checkCircularDependency) {
            if (this.verbose) console.log('check deps');
            for (const module of this.moduleByName.values()) {
                checkModuleDep(module, -1);
            }
        }
    }

    clear():void {
        this.deplist.length = 0;
        this.main.clearCache(this, this.moduleByName);
        this.mapgen = null;
        this.lineOffset = 0;
        this.lock = null;
        this.moduleByName.clear();
        this.sourceFileCache.clear();
    }

    getExternal(name:string, mode:ExternalMode):BundlerModuleId {
        if (name.startsWith('.'))
        {
            this.main.reportMessage(IfTsbError.InternalError, `${name}: external module starts with dot`);
        }
        return this.getModuleId(name, mode, null);
    }

    getModule(apath:string, mpath?:string|null, forceModuleName?:string):BundlerModule {
        let module = this.moduleByName.get(apath);
        if (module) return module;

        if (mpath == null) {
            const filename = path.basename(apath);
            mpath = './'+filename.substr(0, filename.length - getScriptKind(filename).ext.length);
        }

        module = new BundlerModule(this, mpath, apath, forceModuleName || null);
        this.moduleByName.set(apath, module);
        return module;
    }

    static clearLibModules():void {
        for (const m of libmap.values()) {
            m.clear();
        }
        libmap.clear();
    }
}
