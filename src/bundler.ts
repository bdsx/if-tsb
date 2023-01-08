import ts = require("typescript");
import path = require("path");
import fs = require("fs");
import { cachedStat } from "./cachedstat";
import { identifierValidating } from "./checkvar";
import { ConcurrencyQueue } from "./concurrent";
import { BundlerMainContext, IdMap } from "./context";
import { CounterLock } from "./counterlock";
import { fsp } from "./fsp";
import { memcache } from "./memmgr";
import { BundlerModule, BundlerModuleId, CheckState, RefinedModule } from "./module";
import { NameMap } from "./namemap";
import { SourceFileCache } from "./sourcefilecache";
import { SourceMap, SourceMapDirect } from "./sourcemap";
import { WriterStream as FileWriter, WriterStream } from './streamwriter';
import { ExportRule, ExternalMode, IfTsbError, TsConfig } from "./types";
import { changeExt, concurrent, getScriptKind, parsePostfix, splitContent } from "./util";
import { ValueLock } from "./valuelock";
import globToRegExp = require('glob-to-regexp');
import colors = require('colors');

const libmap = new Map<string, Bundler>();
type WritingLock = ValueLock<[FileWriter, FileWriter|null]>;

export class Bundler {
    private readonly names = new NameMap<BundlerModuleId>();

    private mapgen:SourceMap|null = null;
    private sourceMapLineOffset = 0;
    public entryModuleIsAccessed = false;

    private lock:WritingLock|null = null;

    public readonly output:string;
    public readonly outdir:string;
    public readonly globalVarName:string;
    public readonly clearConsole:boolean;
    public readonly watchWaiting:number|undefined;
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
    public readonly declaration:boolean;
    public readonly verbose:boolean;
    public readonly useStrict:boolean;

    private readonly moduleByName = new Map<string, BundlerModule>();
    private readonly globalDeclarationModules:string[] = [];
    public readonly deplist:string[] = [];
    public readonly taskQueue:ConcurrencyQueue;
    public readonly tsconfigMtime:number;
    public readonly moduleResolutionCache:ts.ModuleResolutionCache;
    public readonly sys:ts.System;
    public readonly compilerHost:ts.CompilerHost;
    public readonly constKeyword:string;
    public readonly preimportTargets:Set<string>;
    public readonly noSourceMapWorker:boolean;
    public readonly jsPreloadModules = new Set<BundlerModuleId>();
    public readonly dtsPreloadModules = new Set<BundlerModuleId>();
    private readonly idmap:IdMap;
    public readonly sourceFileCache:SourceFileCache;
    private readonly entryApath:string|null = null;
    private readonly inlineSourceMap:boolean;
    private writingCounter = new CounterLock;

    public program:ts.Program|undefined;

    constructor(
        public readonly main:BundlerMainContext,
        public readonly basedir:string, 
        resolvedOutput:string,
        options:TsConfig, 
        entry:string|null,
        private readonly files:string[],
        public readonly tsconfig:string|null,
        public readonly tsoptions:ts.CompilerOptions,
        public readonly tsconfigContent:TsConfig) {
        this.idmap = main.getCacheMap(resolvedOutput);
        if (tsoptions.noEmitOnError === true) {
            main.reportMessage(IfTsbError.Unsupported, 'noEmitOnError is ignored by if-tsb', true);
        }
        tsoptions.noEmitOnError = false;

        if (this.tsoptions.target === undefined) {
            this.tsoptions.target = ts.ScriptTarget.ES3;
        }
        if (this.tsoptions.target >= ts.ScriptTarget.ES2015) {
            this.constKeyword = 'const';
        } else {
            this.constKeyword = 'var';
        }
        delete this.tsoptions.outFile;
        delete this.tsoptions.outDir;
        delete this.tsoptions.out;
        this.tsoptions.allowJs = true;
        this.tsoptions.outDir = '/.if-tsb';

        if (this.tsoptions.inlineSourceMap) {
            this.inlineSourceMap = true;
            this.tsoptions.inlineSourceMap = false;
            this.tsoptions.sourceMap = true;
        } else {
            this.inlineSourceMap = false;
        }

        const that = this;
        this.sys = Object.setPrototypeOf({
            getCurrentDirectory():string {
                return that.basedir;
            },
            directoryExists(filepath:string):boolean {
                try
                {
                    return cachedStat.sync(that.resolvePath(filepath)).isDirectory();
                }
                catch (err)
                {
                    return false;
                }
            },
            fileExists(filepath:string):boolean {
                return cachedStat.existsSync(that.resolvePath(filepath));
            },
        }, ts.sys);

        this.compilerHost = ts.createCompilerHost(this.tsoptions);
        this.compilerHost.getCurrentDirectory = ()=>this.sys.getCurrentDirectory();
        this.compilerHost.readFile = fileName=>this.sys.readFile(fileName);
        this.compilerHost.directoryExists = dirName=>this.sys.directoryExists(dirName);
        this.compilerHost.fileExists = dirName=>this.sys.fileExists(dirName);
        this.compilerHost.getDirectories = dirName=>this.sys.getDirectories(dirName);

        if (tsconfig !== null) {
            this.tsconfigMtime = +fs.statSync(tsconfig).mtime;
        } else {
            this.tsconfigMtime = 0;
        }
        this.output = resolvedOutput;
        this.outdir = path.dirname(this.output);
        const boptions = options.bundlerOptions || {};

        this.verbose = !!boptions.verbose;
        this.globalVarName = (boptions.globalModuleVarName || '__tsb').toString();
        this.clearConsole = !!boptions.clearConsole;
        this.checkCircularDependency = !!boptions.checkCircularDependency;
        this.suppressDynamicImportErrors = !!boptions.suppressDynamicImportErrors;
        this.faster = !!boptions.faster;
        this.watchWaiting = boptions.watchWaiting;
        this.bundleExternals = !!boptions.bundleExternals;
        this.externals = boptions.externals instanceof Array ? boptions.externals.map(glob=>globToRegExp(glob)) : [];
        this.preimportTargets = boptions.preimport instanceof Array ? new Set(boptions.preimport) : new Set;
        this.noSourceMapWorker = !! boptions.noSourceMapWorker;
        this.preimportTargets.add('tslib');
        this.preimportTargets.add('path');
        this.exportLib = !!boptions.exportLib;
        this.declaration = !!tsoptions.declaration;

        this.cacheMemory = parsePostfix(boptions.cacheMemory);
        this.sourceFileCache = SourceFileCache.getInstance(tsoptions.target!);
        if (boptions.module == null) {
            this.exportRule = ExportRule.None;
        } else {
            const exportRule = (boptions.module+'').toLowerCase();
            switch (exportRule) {
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
                switch (rule.toLowerCase()) {
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
            const apath = path.isAbsolute(entry) ? entry : path.join(this.basedir, entry);
            if (this.exportLib) {
                this.files.push(apath);
            } else {
                this.entryApath = apath;
            }
        }
        this.taskQueue = new ConcurrencyQueue(path.basename(this.entryApath || this.basedir) + ' Task', Number(boptions.concurrency) || undefined);
        if (this.verbose) {
            fsp.verbose = true;
            memcache.verbose = true;
            // ConcurrencyQueue.verbose = true;
        }

        this.useStrict = false;
        if (this.tsoptions.target <= ts.ScriptTarget.ES5) {
            if (this.tsoptions.alwaysStrict) this.useStrict = true;
        } else {
            if (!this.tsoptions.noImplicitUseStrict) this.useStrict = true;
        }
    }

    getModuleId(apath:string, mode:ExternalMode):BundlerModuleId {
        let id = this.idmap.get(apath);
        if (id === undefined) {
            const number = mode === ExternalMode.NoExternal ? this.main.allocateCacheId() : mode;
            let varName = path.basename(apath);
            const dotidx = varName.lastIndexOf('.');
            if (dotidx !== -1) varName = varName.substr(0, dotidx);
            if (varName === 'index') {
                varName = path.basename(path.dirname(apath));
            }
            id = this.allocModuleVarName(number, varName, apath);
            this.idmap.set(apath, id);
            this.main.cacheJsonModified = true;
        } else {
            if (id.number < 0 && id.number !== mode) {
                this.main.reportMessage(IfTsbError.InternalError, `module type mismatch (${id.number} -> ${mode})`);
            }
        }
        return id;
    }

    deleteModuleId(apath:string):boolean {
        const id = this.idmap.get(apath);
        if (id == null) return false;
        this.idmap.delete(apath);
        this.main.freeCacheId(id.number);
        this.deleteModuleVarName(id.varName);
        return true;
    }

    resolvePath(filepath:string):string {
        return path.isAbsolute(filepath) ? path.join(filepath) : path.join(this.basedir, filepath);
    }

    addModuleVarName(moduleId:BundlerModuleId):BundlerModuleId|null {
        const old = this.names.get(moduleId.varName);
        this.names.set(moduleId.varName, moduleId);
        return old || null;
    }

    allocModuleVarName(number:number, name:string, apath:string):BundlerModuleId {
        name = this.names.getFreeName(name);
        const moduleId = new BundlerModuleId(number, name, apath);
        this.names.set(name, moduleId);
        return moduleId;
    }

    deleteModuleVarName(name:string):boolean {
        return this.names.delete(name);
    }
    
    async write(lock:WritingLock, module:BundlerModule, refined:RefinedModule):Promise<void> {
        const [jsWriter, dtsWriter] = await lock.lock();
        try {
            await concurrent(
                jsWriter.write(refined.content), 
                dtsWriter !== null && module.needDeclaration && refined.declaration !== null ? dtsWriter.write(refined.declaration) : null
            );
        } finally {
            lock.unlock();
        }
        const offset = this.sourceMapLineOffset + refined.sourceMapOutputLineOffset;
        this.sourceMapLineOffset += refined.outputLineCount;

        if (refined.sourceMapText) {
            try {
                this.mapgen!.append(refined.id.apath, refined.sourceMapText, offset);
            } catch (err) {
                module.error(null, IfTsbError.InternalError, `Invalid source map, ${err.message} (${refined.sourceMapText.substr(0, 16)})`);
            }
        }
    }

    private async _startWrite(lock:WritingLock, firstLineComment:string|null):Promise<[FileWriter, FileWriter|null]> {
        await fsp.mkdirRecursive(this.outdir);
        
        await lock.lockWithoutWriter();
        let jsWriter:FileWriter|undefined;
        let dtsWriter:FileWriter|null = null as any;
        try {
            await concurrent(async()=>{
                jsWriter = new FileWriter(this.output);
                if (firstLineComment !== null) {
                    await jsWriter.write(firstLineComment+'\n');
                    this.sourceMapLineOffset++;
                }
                if (this.useStrict) {
                    await jsWriter.write('"use strict";\n');
                    this.sourceMapLineOffset++;
                }
                if (this.exportLib) {
                    if (this.exportRule === ExportRule.ES2015) {
                        await jsWriter.write(`export const ${this.globalVarName} = {\n`);
                        this.sourceMapLineOffset++;
                    } else if (this.exportRule === ExportRule.Direct) {
                        await jsWriter.write(`${this.exportVarName}.${this.globalVarName} = {\n`);
                        this.sourceMapLineOffset++;
                    } else if (this.exportRule === ExportRule.Var) {
                        await jsWriter.write(`${this.exportVarKeyword} ${this.globalVarName} = {\n`);
                        this.sourceMapLineOffset++;
                    } else {
                        await jsWriter.write(`${this.constKeyword} ${this.globalVarName} = {\n`);
                        this.sourceMapLineOffset++;
                    }
                } else {
                    if (this.needWrap) {
                        let assign = '';
                        if (this.exportRule === ExportRule.Var) {
                            assign = `${this.exportVarKeyword} ${this.exportVarName}=`;
                        }
                        if (this.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                            await jsWriter.write(`${assign}(()=>{\n`);
                        } else {
                            await jsWriter.write(`${assign}(function(){\n`);
                        }
                        this.sourceMapLineOffset++;
                    }
                    await jsWriter.write(`${this.constKeyword} ${this.globalVarName} = {\n`);
                    this.sourceMapLineOffset++;
                }
            }, async()=>{
                if (!this.declaration) return;
                dtsWriter = new FileWriter(changeExt(this.output, 'd.ts'));
                if (this.exportLib) {
                    if (this.exportRule === ExportRule.ES2015) {
                        await dtsWriter.write(`export namespace ${this.globalVarName} {\n`);
                    } else if (this.exportRule === ExportRule.Direct) {
                        await dtsWriter.write(`declare namespace ${this.globalVarName} {\n`);
                    } else if (this.exportRule === ExportRule.Var) {
                        await dtsWriter.write(`declare global {\nnamespace ${this.globalVarName} {\n`);
                    } else {
                        await dtsWriter.write(`declare namespace ${this.globalVarName} {\n`);
                    }
                } else {
                    if (this.needWrap) {
                        if (this.exportRule === ExportRule.Var) {
                            await dtsWriter.write(`declare global {\nnamespace ${this.exportVarName} {\n`);
                        } else {
                            // no declaration
                        }
                    }
                    await dtsWriter.write(`declare namespace ${this.globalVarName} {\n`);
                }
            });
        } finally {
            lock.unlock();
        }
        const res:[WriterStream, WriterStream|null] = [jsWriter!, dtsWriter];
        lock.resolveWriter(res);
        return res;
    }

    async append(lock:WritingLock, module:BundlerModule):Promise<void> {
        if (module.isAppended) return;
        module.isAppended = true;
        if (module.isEntry) {
            this.entryModuleIsAccessed = true;
            return;
        }
        this.deplist.push(module.id.apath);
        const kind = getScriptKind(module.id.apath);
        let prom:Promise<void>|undefined;
        if (kind.kind === ts.ScriptKind.JS && this.declaration) {
            const dtsPath = kind.modulePath+'.d.ts';
            prom = cachedStat.exists(dtsPath).then(exists=>{
                if (exists) this.deplist.push(dtsPath);
            });
        }

        this.writingCounter.increase();
        await this.taskQueue.run(module.id.varName, async()=>{
            const refined = await module.refine();
            (async()=>{
                if (refined === null) {
                    module.error(null, IfTsbError.ModuleNotFound, `Cannot find module '${module.mpath}'`);
                    try {
                        const [jsWriter, dtsWriter] = await lock.lock();
                        await jsWriter.write(`${module.id.varName}(){ throw Error("Cannot find module '${module.mpath}'"); }\n`);
                    } finally {
                        lock.unlock();
                    }
                } else {
                    this._appendChildren(lock, module, refined);
                    await this.write(lock, module, refined);
                    memcache.release(refined);
                }
                this.writingCounter.decrease();
            })();
        });
        await prom;
    }
        
    private _appendChildren(lock:WritingLock, module:BundlerModule, refined:RefinedModule):void {
        if (refined.globalDeclaration !== null) {
            this.globalDeclarationModules.push(refined.globalDeclaration);
        }
        if (module.children.length === 0) {
            module.importLines.length = 0;

            for (const info of refined.imports) {
                const mode = info.getExternalMode();
                if (mode !== ExternalMode.NoExternal) {
                    this.getModuleId(info.mpath, mode);
                } else {
                    const mpath = info.mpath;
                    const childModule = this.getModule(info.apathOrExternalMode, mpath);
                    if (info.declaration) childModule.needDeclaration = true;
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
        const entryModule = this.getModule(apath, null);
        entryModule.isEntry = true;
        entryModule.isAppended = true;

        this.deplist.push(apath);
        return entryModule;
    }

    async bundle():Promise<boolean> {
        if (this.lock !== null) throw Error('bundler is busy');
        this.clear();

        const lock = this.lock = new ValueLock(this.main);
            
        if (this.tsconfig !== null) this.deplist.push(this.tsconfig);

        if (this.verbose) console.log('START '+(this.entryApath || this.basedir));
        let entryModule:BundlerModule|null = null;
        let entryRefined:RefinedModule|null = null;
        if (this.entryApath !== null) {
            entryModule = this._getEntryModule(this.entryApath);
            if (this.declaration) entryModule.needDeclaration = true;
            if (this.verbose) console.log(`entry - ${entryModule.mpath}`);
            entryRefined = await entryModule.refine();
            if (entryRefined === null) {
                this.lock = null;
                return false;
            }
        }
        
        let jsWriter:FileWriter;
        let dtsWriter:FileWriter|null;
        try {
            [jsWriter, dtsWriter] = await this._startWrite(lock, entryRefined !== null ? entryRefined.firstLineComment : null);
        } catch (err) {
            this.lock = null;
            return false;
        }
        this.mapgen = this.noSourceMapWorker ? new SourceMapDirect(this.output) : SourceMap.newInstance(this.output);
        if (entryModule !== null) {
            this._appendChildren(lock, entryModule, entryRefined!);
        }

        for (const apath of this.files) {
            const libmodule = this.getModule(apath, null);
            if (this.declaration) libmodule.needDeclaration = true;
            this.append(lock, libmodule);
        }

        await this.taskQueue.onceEnd();
        await this.writingCounter.waitZero();

        await concurrent(
            async()=>{
                for (const module of this.jsPreloadModules) {
                    await jsWriter.write(`${module.varName}:require('${module.apath}'),\n`);
                    this.sourceMapLineOffset ++;
                }
        
                if (this.idmap.has('__resolve')) {
                    if (this.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                        await jsWriter.write(`__resolve(rpath){\n`);
                    } else {
                        await jsWriter.write(`__resolve:function(rpath){\n`);
                    }
                    const path = this.idmap.get('path')!;
                    await jsWriter.write(`return this.${path.varName}.join(this.__dirname, rpath);\n},\n`);
                    if (this.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                        await jsWriter.write(`__dirname,\n`);
                    } else {
                        await jsWriter.write(`__dirname:__dirname,\n`);
                    }
                    this.sourceMapLineOffset += 4;
                }
        
                if (this.entryModuleIsAccessed || this.tsoptions.target! < ts.ScriptTarget.ES5) {
                    await jsWriter.write(`entry:exports\n};\n`);
                    this.sourceMapLineOffset += 2;
                } else {
                    await jsWriter.write(`};\n`);
                    this.sourceMapLineOffset ++;
                }
            }
        );
        
        if (entryModule !== null) {
            await this.write(lock, entryModule, entryRefined!);
            memcache.release(entryRefined!);
        }

        const saveProm = concurrent(async()=>{
            await jsWriter.write('\n');
            if (this.entryModuleIsAccessed) {
                await jsWriter.write(`${this.globalVarName}.entry=module.exports;\n`);
            }
            if (this.needWrap) {
                if (this.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                    // arrow end
                    await jsWriter.write(`})();\n`);
                } else {
                    if (this.exportRule === ExportRule.Direct && this.exportVarName === 'this') {
                        await jsWriter.write(`}).call(this);\n`);
                    } else {
                        await jsWriter.write(`})();\n`);
                    }
                }
            }
            if (this.exportLib) {
                switch (this.exportRule) {
                case ExportRule.CommonJS:
                    await jsWriter.write(`module.exports = ${this.globalVarName};\n`);
                    break;
                }
            }
        }, async()=>{
            if (dtsWriter === null) return;
            await dtsWriter.write('}\n');
            for (const module of this.dtsPreloadModules) {
                await dtsWriter.write(`import ${this.globalVarName}_${module.varName} = require('${module.apath}');\n`);
                this.sourceMapLineOffset ++;
            }
            for (const content of this.globalDeclarationModules) {
                await dtsWriter.write(content);
            }
            this.globalDeclarationModules.length = 0;
            if (entryModule !== null) {
                await dtsWriter.write(`export = ${this.globalVarName}.${entryModule!.id.varName};\n`);   
            }
        });

        if (this.tsoptions.sourceMap) {
            if (this.inlineSourceMap) {
                const [_, dataUrl] = await Promise.all([
                    saveProm, 
                    this.mapgen.toDataURL()
                ]);
                await jsWriter.write(`//# sourceMappingURL=${dataUrl}`);
            } else {
                await Promise.all([
                    saveProm.then(()=>jsWriter.write(`//# sourceMappingURL=${path.basename(this.output)}.map`)), 
                    this.mapgen.save()
                ]);
            }
        } else {
            await saveProm;
        }
        await jsWriter.end();
        if (dtsWriter !== null) {
            await dtsWriter.end();
        }

        if (this.verbose) console.log('FINISH '+(this.entryApath || this.basedir));
        this.lock = null;
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
        this.mapgen = null;
        this.sourceMapLineOffset = 0;
        this.lock = null;
        this.moduleByName.clear();
        this.globalDeclarationModules.length = 0;
    }

    getModule(apath:string, mpath?:string|null):BundlerModule {
        let module = this.moduleByName.get(apath);
        if (module == null) {
            if (mpath == null) {
                const filename = path.basename(apath);
                const kind = getScriptKind(filename);
                mpath = './'+kind.moduleName;
            }
    
            module = new BundlerModule(this, mpath, apath);
            this.moduleByName.set(apath, module);
        }
        return module;
    }

    static clearLibModules():void {
        for (const m of libmap.values()) {
            m.clear();
        }
        libmap.clear();
    }
}
