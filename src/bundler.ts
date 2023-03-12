import ts = require("typescript");
import path = require("path");
import fs = require("fs");
import { identifierValidating } from "./checkvar";
import { BundlerMainContext, IdMap } from "./context";
import { memcache } from "./memmgr";
import {
    BundlerModule,
    BundlerModuleId,
    CheckState,
    ChildModule,
    RefinedModule,
} from "./module";
import { SourceFileCache } from "./sourcemap/sourcefilecache";
import { SourceMap, SourceMapDirect } from "./sourcemap/sourcemap";
import { tshelper } from "./tshelper";
import { ExportRule, ExternalMode, IfTsbError, TsConfig } from "./types";
import { cachedStat } from "./util/cachedstat";
import { ConcurrencyQueue } from "./util/concurrent";
import { ErrorPosition } from "./util/errpos";
import { fsp } from "./util/fsp";
import { NameMap } from "./util/namemap";
import { WriterStream } from "./util/streamwriter";
import {
    changeExt,
    concurrent,
    getScriptKind,
    millisecondFrom,
    parsePostfix,
    splitContent,
    time,
} from "./util/util";
import globToRegExp = require("glob-to-regexp");
import colors = require("colors");

const libmap = new Map<string, Bundler>();

export class BundleResult {
    public readonly deplist: string[] = [];
}

const reservedModuleNames = ["_", "entry", "require"];

export class Bundler {
    private readonly names = new NameMap<BundlerModuleId | null>();

    private bundling = false;

    public readonly output: string;
    public readonly outdir: string;
    public readonly globalVarName: string;
    public readonly clearConsole: boolean;
    public readonly watchWaiting: number | undefined;
    public readonly checkCircularDependency: boolean;
    public readonly suppressDynamicImportErrors: boolean;
    public readonly faster: boolean;
    public readonly bundleExternals: boolean;
    public readonly browser: boolean;
    public readonly browserAPathRoot: string | null;
    public readonly externals: RegExp[];
    public readonly cacheMemory: number | undefined;
    public readonly exportRule: ExportRule;
    public readonly exportVarKeyword: string | null = null;
    public readonly exportVarName: string | null = null;
    public readonly needWrap: boolean;
    public readonly exportLib: boolean;
    public readonly declaration: boolean;
    public readonly verbose: boolean;
    public readonly useStrict: boolean;

    public readonly taskQueue: ConcurrencyQueue;
    public readonly tsconfigMtime: number;
    public readonly moduleResolutionCache: ts.ModuleResolutionCache;
    public readonly sys: ts.System;
    public readonly compilerHost: ts.CompilerHost;
    public readonly constKeyword: string;
    public readonly preimportTargets: Set<string>;
    public readonly noSourceMapWorker: boolean;
    public readonly jsPreloadModules = new Set<BundlerModuleId>();
    public readonly dtsPreloadModules = new Set<BundlerModuleId>();
    public readonly idmap: IdMap;
    public readonly sourceFileCache: SourceFileCache;
    public readonly entryApath: string | null = null;
    public readonly inlineSourceMap: boolean;
    private readonly moduleByName = new Map<string, BundlerModule>();

    public program: ts.Program | undefined;

    constructor(
        public readonly main: BundlerMainContext,
        public readonly basedir: string,
        resolvedOutput: string,
        options: TsConfig,
        entry: string | null,
        public readonly files: string[],
        public readonly tsconfig: string | null,
        public readonly tsoptions: ts.CompilerOptions,
        public readonly tsconfigContent: TsConfig
    ) {
        for (const reservedName of reservedModuleNames) {
            this.names.set(reservedName, null);
        }
        this.idmap = main.getCacheMap(resolvedOutput);
        if (tsoptions.noEmitOnError === true) {
            main.reportMessage(
                IfTsbError.Unsupported,
                "noEmitOnError is ignored by if-tsb",
                true
            );
        }
        tsoptions.noEmitOnError = false;

        if (this.tsoptions.target === undefined) {
            this.tsoptions.target = ts.ScriptTarget.ES3;
        }
        if (this.tsoptions.target >= ts.ScriptTarget.ES2015) {
            this.constKeyword = "const";
        } else {
            this.constKeyword = "var";
        }
        delete this.tsoptions.outFile;
        delete this.tsoptions.outDir;
        delete this.tsoptions.out;
        this.tsoptions.allowJs = true;
        this.tsoptions.resolveJsonModule = true;
        this.tsoptions.outDir = "/.if-tsb";

        if (this.tsoptions.inlineSourceMap) {
            this.inlineSourceMap = true;
            this.tsoptions.inlineSourceMap = false;
            this.tsoptions.sourceMap = true;
        } else {
            this.inlineSourceMap = false;
        }

        this.sys = tshelper.createSystem(this.basedir);

        this.compilerHost = ts.createCompilerHost(this.tsoptions);
        this.compilerHost.getCurrentDirectory = () =>
            this.sys.getCurrentDirectory();
        this.compilerHost.readFile = (fileName) => this.sys.readFile(fileName);
        this.compilerHost.directoryExists = (dirName) =>
            this.sys.directoryExists(dirName);
        this.compilerHost.fileExists = (dirName) =>
            this.sys.fileExists(dirName);
        this.compilerHost.getDirectories = (dirName) =>
            this.sys.getDirectories(dirName);

        if (tsconfig !== null) {
            this.tsconfigMtime = +fs.statSync(tsconfig).mtime;
        } else {
            this.tsconfigMtime = 0;
        }
        this.output = resolvedOutput;
        this.outdir = path.dirname(this.output);
        const boptions = options.bundlerOptions || {};

        this.verbose = !!boptions.verbose;
        this.globalVarName = (
            boptions.globalModuleVarName || "__tsb"
        ).toString();
        this.clearConsole = !!boptions.clearConsole;
        this.checkCircularDependency = !!boptions.checkCircularDependency;
        this.suppressDynamicImportErrors =
            !!boptions.suppressDynamicImportErrors;
        this.faster = !!boptions.faster;
        this.watchWaiting = boptions.watchWaiting;
        this.bundleExternals = !!boptions.bundleExternals;
        const browser = boptions.browser;
        if (browser) {
            this.browser = true;
            if (typeof browser === "string") {
                this.browserAPathRoot = this.resolvePath(browser);
            } else {
                this.browserAPathRoot = this.resolvePath(".");
            }
        } else {
            this.browser = false;
            this.browserAPathRoot = null;
        }
        this.externals =
            boptions.externals instanceof Array
                ? boptions.externals.map((glob) => globToRegExp(glob))
                : [];
        this.preimportTargets =
            boptions.preimport instanceof Array
                ? new Set(boptions.preimport)
                : new Set();
        this.noSourceMapWorker = !!boptions.noSourceMapWorker;
        if (this.browserAPathRoot !== null) {
            this.bundleExternals = true;
        }
        if (!this.bundleExternals) {
            this.preimportTargets.add("tslib");
            this.preimportTargets.add("path");
        }
        this.exportLib = !!boptions.exportLib;
        this.declaration = !!tsoptions.declaration;

        this.cacheMemory = parsePostfix(boptions.cacheMemory);
        this.sourceFileCache = SourceFileCache.getInstance(tsoptions.target!);
        if (boptions.module == null) {
            this.exportRule = ExportRule.None;
        } else {
            const exportRule = (boptions.module + "").toLowerCase();
            switch (exportRule) {
                case "none":
                    this.exportRule = ExportRule.None;
                    break;
                case "commonjs":
                    this.exportRule = ExportRule.CommonJS;
                    break;
                case "es2015":
                    this.exportRule = ExportRule.ES2015;
                    break;
                case "es2020":
                    this.exportRule = ExportRule.ES2015;
                    break;
                case "esnext":
                    this.exportRule = ExportRule.ES2015;
                    break;
                case "this":
                case "window":
                case "self":
                    this.exportRule = ExportRule.Direct;
                    this.exportVarName = exportRule;
                    break;
                default:
                    const [rule, param] = splitContent(boptions.module, 2, " ");
                    switch (rule.toLowerCase()) {
                        case "var":
                            this.exportRule = ExportRule.Var;
                            this.exportVarKeyword = "var";
                            this.exportVarName = identifierValidating(param);
                            break;
                        case "let":
                            this.exportRule = ExportRule.Var;
                            this.exportVarKeyword = "let";
                            this.exportVarName = identifierValidating(param);
                            break;
                        case "const":
                            this.exportRule = ExportRule.Var;
                            this.exportVarKeyword = "const";
                            this.exportVarName = identifierValidating(param);
                            break;
                        default:
                            this.exportRule = ExportRule.Direct;
                            this.exportVarName = exportRule;
                            console.error(
                                colors.red(
                                    `if-tsb: Unsupported module type: ${boptions.module}, it treats as a direct export`
                                )
                            );
                            break;
                    }
                    break;
            }
        }

        if (this.exportLib) {
            this.needWrap = false;
            if (this.exportRule === ExportRule.Var) {
                if (boptions.globalModuleVarName) {
                    main.reportMessage(
                        IfTsbError.Unsupported,
                        "ignored globalModuleVarName with exportLib to variable"
                    );
                }
                this.globalVarName = this.exportVarName!;
            }
        } else {
            this.needWrap =
                this.exportRule === ExportRule.Direct ||
                this.exportRule === ExportRule.Var;
        }

        this.moduleResolutionCache = tshelper.createModuleResolutionCache(
            this.basedir
        );
        if (entry !== null) {
            const apath = this.resolvePath(entry);
            if (this.exportLib) {
                this.files.push(apath);
            } else {
                this.entryApath = apath;
            }
        }
        this.taskQueue = new ConcurrencyQueue(
            path.basename(this.entryApath || this.basedir) + " Task",
            Number(boptions.concurrency) || undefined
        );
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
        if (this.browserAPathRoot !== null) {
            if (boptions.bundleExternals !== undefined) {
                this.main.reportMessage(
                    IfTsbError.WrongUsage,
                    "browser=true ignores the bundleExternals option",
                    true
                );
            }
        }
    }

    getModuleId(apath: string, mode: ExternalMode): BundlerModuleId {
        let id = this.idmap.get(apath);
        if (id === undefined) {
            const number =
                mode === ExternalMode.NoExternal
                    ? this.main.allocateCacheId()
                    : mode;
            let varName = path.basename(apath);
            const dotidx = varName.lastIndexOf(".");
            if (dotidx !== -1) varName = varName.substr(0, dotidx);
            if (varName === "index") {
                varName = path.basename(path.dirname(apath));
            }
            id = this.allocModuleVarName(number, varName, apath);
            this.idmap.set(apath, id);
            this.main.cacheJsonModified = true;
        } else {
            if (id.number < 0 && id.number !== mode) {
                this.main.reportMessage(
                    IfTsbError.InternalError,
                    `module type mismatch (${id.number} -> ${mode})`
                );
            }
        }
        return id;
    }

    deleteModuleId(apath: string): boolean {
        const id = this.idmap.get(apath);
        if (id == null) return false;
        this.idmap.delete(apath);
        this.main.freeCacheId(id.number);
        this.deleteModuleVarName(id.varName);
        return true;
    }

    resolvePath(filepath: string): string {
        return this.sys.resolvePath(filepath);
    }

    addModuleVarName(moduleId: BundlerModuleId): BundlerModuleId | null {
        const old = this.names.get(moduleId.varName);
        this.names.set(moduleId.varName, moduleId);
        return old || null;
    }

    allocModuleVarName(
        number: number,
        name: string,
        apath: string
    ): BundlerModuleId {
        name = this.names.getFreeName(name);
        const moduleId = new BundlerModuleId(number, name, apath);
        this.names.set(name, moduleId);
        return moduleId;
    }

    deleteModuleVarName(name: string): boolean {
        return this.names.delete(name);
    }

    async bundle(printOutputTime?: boolean): Promise<BundleResult> {
        if (this.bundling) throw Error("bundler is busy");
        this.bundling = true;
        this.clear();

        if (this.verbose)
            console.log(`[${time()}] start ${this.entryApath || this.basedir}`);
        const started = process.hrtime();

        const res = new BundleResult();
        try {
            await bundlingProcess(this, res);
        } catch (err) {
            console.error(err);
        }
        if (printOutputTime) {
            console.log(
                `[${time()}] output ${this.output} (${millisecondFrom(
                    started
                )}ms)`
            );
        }

        this.bundling = false;
        return res;
    }

    getModule(apath: string, mpath?: string | null): BundlerModule {
        let module = this.moduleByName.get(apath);
        if (module == null) {
            if (mpath == null) {
                const filename = path.basename(apath);
                const kind = getScriptKind(filename);
                mpath = "./" + kind.moduleName;
            }

            module = new BundlerModule(this, mpath, apath);
            this.moduleByName.set(apath, module);
        }
        return module;
    }

    clear() {
        this.moduleByName.clear();
    }

    allModules(): IterableIterator<BundlerModule> {
        return this.moduleByName.values();
    }

    static clearLibModules(): void {
        for (const m of libmap.values()) {
            m.clear();
        }
        libmap.clear();
    }
}

async function bundlingProcess(
    bundler: Bundler,
    result: BundleResult
): Promise<void> {
    class DepList {
        private deplistPromise: Promise<void> = Promise.resolve();

        add(filename: string): void {
            result.deplist.push(filename);
        }
        addIfExists(filename: string): void {
            this.deplistPromise = this.deplistPromise
                .then(() => cachedStat.exists(filename))
                .then((exists) => {
                    if (exists) result.deplist.push(filename);
                });
        }
    }

    class AsyncWorker<T> {
        private running = false;
        private endPromise: Promise<void> = Promise.resolve();
        private datas: T[] = [];
        private drainResolve: () => void;
        private drainPromise: Promise<void> = Promise.resolve();

        constructor(private readonly task: (data: T) => Promise<void>) {}

        async post(data: T): Promise<void> {
            const DRAIN_THRESHOLD = 10;

            if (this.datas.length === DRAIN_THRESHOLD) {
                await this.drainPromise;
            }
            this.datas.push(data);
            if (this.datas.length === DRAIN_THRESHOLD) {
                this.drainPromise = new Promise((resolve) => {
                    this.drainResolve = resolve;
                });
            }

            if (this.running) return;
            this.running = true;
            this.endPromise = (async () => {
                for (;;) {
                    const data = this.datas.shift();
                    if (this.datas.length === DRAIN_THRESHOLD - 1) {
                        this.drainResolve();
                    }
                    if (data === undefined) break;
                    await this.task(data);
                }
                this.running = false;
            })();
        }

        end(): Promise<void> {
            return this.endPromise;
        }
    }

    function makeChildren(refined: RefinedModule): ChildModule[] {
        const children: ChildModule[] = [];
        for (const info of refined.imports) {
            const mode = info.getExternalMode();
            if (mode !== ExternalMode.NoExternal) {
                bundler.getModuleId(info.mpath, mode);
            } else {
                const mpath = info.mpath;
                const childModule = bundler.getModule(
                    info.apathOrExternalMode,
                    mpath
                );
                if (info.declaration) childModule.needDeclaration = true;
                children.push({
                    module: childModule,
                    importLine: info.codepos,
                });
            }
        }
        return children;
    }

    async function append(module: BundlerModule): Promise<void> {
        if (module.isAppended) return;
        module.isAppended = true;
        if (module.isEntry) {
            entryModuleIsAccessed = true;
            return;
        }

        deplist.add(module.id.apath);
        const kind = getScriptKind(module.id.apath);
        if (kind.kind === ts.ScriptKind.JS && bundler.declaration) {
            deplist.addIfExists(kind.modulePath + ".d.ts");
        }

        await refineWorker.post([module, module.refine()]);
    }

    function addNextChildren(module: BundlerModule, refined: RefinedModule) {
        if (module.children === null) {
            module.children = makeChildren(refined);
        }

        for (const child of module.children) {
            const childModule = child.module;
            if (childModule.isAppended) continue;
            nextTargets.push(childModule);
        }
    }

    function checkDeps(): void {
        const parents: BundlerModule[] = [];
        function checkModuleDep(
            m: BundlerModule,
            importLine: ErrorPosition | null
        ): void {
            if (m.checkState === CheckState.Checked) return;
            if (m.checkState === CheckState.Entered) {
                const parent = parents[parents.length - 1];
                const loopPoint = parents.lastIndexOf(m);
                const looping = parents.slice(loopPoint);
                looping.push(m);
                parent.error(
                    importLine,
                    1005,
                    "Circular dependency " +
                        looping.map((m) => colors.yellow(m.rpath)).join(" → ")
                );
                return;
            }
            m.checkState = CheckState.Entered;
            parents.push(m);

            if (m.children !== null) {
                for (const child of m.children) {
                    checkModuleDep(child.module, child.importLine);
                }
            }
            m.checkState = CheckState.Checked;
            parents.pop();
        }

        if (bundler.checkCircularDependency) {
            if (bundler.verbose) console.log("check deps");
            for (const module of bundler.allModules()) {
                checkModuleDep(module, null);
            }
        }
    }

    async function writeAndRelease(
        module: BundlerModule,
        refined: RefinedModule
    ) {
        if (refined.content === null) {
            throw Error(`${refined.id.apath}: no content`);
        }

        await concurrent(
            jsWriter.write(refined.content),
            module.needDeclaration &&
                refined.declaration !== null &&
                dtsWriter !== null &&
                dtsWriter.write(refined.declaration)
        );

        const offset = sourceMapLineOffset + refined.sourceMapOutputLineOffset;
        sourceMapLineOffset += refined.outputLineCount;
        if (refined.sourceMapText) {
            try {
                mapgen!.append(refined.id.apath, refined.sourceMapText, offset);
            } catch (err) {
                module.error(
                    null,
                    IfTsbError.InternalError,
                    `Invalid source map, ${
                        err.message
                    } (${refined.sourceMapText.substr(0, 16)})`
                );
            }
        }

        if (refined.globalDeclaration !== null) {
            globalDeclarationModules.push(refined.globalDeclaration);
        }
        memcache.release(refined);
    }

    const deplist = new DepList();
    let nextTargets: BundlerModule[] = [];

    let sourceMapLineOffset = 0;
    let entryModuleIsAccessed = false;
    const globalDeclarationModules: Buffer[] = [];

    const writeWorker = new AsyncWorker<[BundlerModule, RefinedModule | null]>(
        async ([module, refined]) => {
            if (refined === null) {
                module.error(
                    null,
                    IfTsbError.ModuleNotFound,
                    `Cannot find module '${module.mpath}'. refine failed.`
                );
                await jsWriter.write(
                    `${module.id.varName}(){ throw Error("Cannot find module '${module.mpath}'"); }\n`
                );
            } else {
                await writeAndRelease(module, refined);
            }
        }
    );

    const refineWorker = new AsyncWorker<
        [BundlerModule, Promise<RefinedModule | null>]
    >(async ([module, refinedProm]) => {
        const refined = await refinedProm;
        if (refined !== null) {
            addNextChildren(module, refined);
        }
        writeWorker.post([module, refined]);
    });

    if (bundler.tsconfig !== null) deplist.add(bundler.tsconfig);

    // entry module
    let entryModule: BundlerModule | null = null;
    let entryRefined: RefinedModule | null = null;
    if (bundler.entryApath !== null) {
        entryModule = bundler.getModule(bundler.entryApath, null);
        entryModule.isEntry = true;
        entryModule.isAppended = true;
        if (bundler.declaration) entryModule.needDeclaration = true;
        if (bundler.verbose) console.log(`entry - ${entryModule.mpath}`);
        if (!(await cachedStat.exists(bundler.entryApath))) {
            bundler.main.reportMessage(
                IfTsbError.ModuleNotFound,
                `Cannot find entry module '${entryModule.rpath}'`
            );
            return;
        }
        deplist.add(bundler.entryApath);
        entryRefined = await entryModule.refine();
        if (entryRefined === null) {
            return;
        }
    }

    await fsp.mkdirRecursive(bundler.outdir);

    // begining
    const jsWriter: WriterStream = new WriterStream(bundler.output);
    const dtsWriter: WriterStream | null = bundler.declaration
        ? new WriterStream(changeExt(bundler.output, "d.ts"))
        : null;
    await concurrent(
        async () => {
            const firstLineComment =
                entryRefined && entryRefined.firstLineComment;
            if (firstLineComment !== null) {
                await jsWriter.write(firstLineComment + "\n");
                sourceMapLineOffset++;
            }
            if (bundler.useStrict) {
                await jsWriter.write('"use strict";\n');
                sourceMapLineOffset++;
            }
            if (bundler.exportLib) {
                if (bundler.exportRule === ExportRule.ES2015) {
                    await jsWriter.write(
                        `export const ${bundler.globalVarName} = {\n`
                    );
                    sourceMapLineOffset++;
                } else if (bundler.exportRule === ExportRule.Direct) {
                    await jsWriter.write(
                        `${bundler.exportVarName}.${bundler.globalVarName} = {\n`
                    );
                    sourceMapLineOffset++;
                } else if (bundler.exportRule === ExportRule.Var) {
                    await jsWriter.write(
                        `${bundler.exportVarKeyword} ${bundler.globalVarName} = {\n`
                    );
                    sourceMapLineOffset++;
                } else {
                    await jsWriter.write(
                        `${bundler.constKeyword} ${bundler.globalVarName} = {\n`
                    );
                    sourceMapLineOffset++;
                }
            } else {
                if (bundler.needWrap) {
                    let assign = "";
                    if (bundler.exportRule === ExportRule.Var) {
                        assign = `${bundler.exportVarKeyword} ${bundler.exportVarName}=`;
                    }
                    if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                        await jsWriter.write(`${assign}(()=>{\n`);
                    } else {
                        await jsWriter.write(`${assign}(function(){\n`);
                    }
                    sourceMapLineOffset++;
                }
                await jsWriter.write(
                    `${bundler.constKeyword} ${bundler.globalVarName} = {\n`
                );
                sourceMapLineOffset++;
            }
        },
        async () => {
            if (dtsWriter === null) return;
            if (bundler.exportLib) {
                if (bundler.exportRule === ExportRule.ES2015) {
                    await dtsWriter.write(
                        `export namespace ${bundler.globalVarName} {\n`
                    );
                } else if (bundler.exportRule === ExportRule.Direct) {
                    await dtsWriter.write(
                        `declare namespace ${bundler.globalVarName} {\n`
                    );
                } else if (bundler.exportRule === ExportRule.Var) {
                    await dtsWriter.write(
                        `declare global {\nnamespace ${bundler.globalVarName} {\n`
                    );
                } else {
                    await dtsWriter.write(
                        `declare namespace ${bundler.globalVarName} {\n`
                    );
                }
            } else {
                if (bundler.needWrap) {
                    if (bundler.exportRule === ExportRule.Var) {
                        await dtsWriter.write(
                            `declare global {\nnamespace ${bundler.exportVarName} {\n`
                        );
                    } else {
                        // no declaration
                    }
                }
                await dtsWriter.write(
                    `declare namespace ${bundler.globalVarName} {\n`
                );
            }
        }
    );

    const mapgen = bundler.noSourceMapWorker
        ? new SourceMapDirect(bundler.output)
        : SourceMap.newInstance(bundler.output);

    // entries
    if (entryModule !== null) {
        addNextChildren(entryModule, entryRefined!);
    }

    for (const apath of bundler.files) {
        const libmodule = bundler.getModule(apath, null);
        if (bundler.declaration) libmodule.needDeclaration = true;
        nextTargets.push(libmodule);
    }

    // module load loop
    for (;;) {
        const modules = nextTargets;
        nextTargets = [];
        if (modules.length === 0) break;
        for (const module of modules) {
            await append(module);
        }
        await refineWorker.end();
    }

    await bundler.taskQueue.onceEnd();
    await writeWorker.end();

    // ending
    await concurrent(async () => {
        for (const module of bundler.jsPreloadModules) {
            await jsWriter.write(
                `${module.varName}:require('${module.apath}'),\n`
            );
            sourceMapLineOffset++;
        }

        if (bundler.idmap.has("__resolve")) {
            if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                await jsWriter.write(`__resolve(rpath){\n`);
            } else {
                await jsWriter.write(`__resolve:function(rpath){\n`);
            }
            if (bundler.browserAPathRoot !== null) {
                await jsWriter.write(`return this.__dirname+'/'+rpath;\n},\n`);
                await jsWriter.write(`__dirname:location.href,\n`);
            } else {
                const path = bundler.idmap.get("path")!;
                await jsWriter.write(
                    `return this.${path.varName}.join(this.__dirname, rpath);\n},\n`
                );
                if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                    await jsWriter.write(`__dirname,\n`);
                } else {
                    await jsWriter.write(`__dirname:__dirname,\n`);
                }
            }
            sourceMapLineOffset += 4;
        }

        if (entryModuleIsAccessed) {
            await jsWriter.write(`entry:${bundler.exportVarName}\n};\n`);
            sourceMapLineOffset += 2;
        } else {
            if (bundler.tsoptions.target! < ts.ScriptTarget.ES5) {
                await jsWriter.write(`_:null\n};\n`);
            } else {
                await jsWriter.write(`};\n`);
            }
            sourceMapLineOffset++;
        }
    });

    // end with the entry module for es6 module
    if (entryModule !== null) {
        writeAndRelease(entryModule, entryRefined!);
    }

    checkDeps();

    const writingJs = concurrent(
        async () => {
            await jsWriter.write("\n");
            if (entryModuleIsAccessed) {
                await jsWriter.write(
                    `${bundler.globalVarName}.entry=module.exports;\n`
                );
            }
            if (bundler.needWrap) {
                if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                    // arrow end
                    await jsWriter.write(`})();\n`);
                } else {
                    if (
                        bundler.exportRule === ExportRule.Direct &&
                        bundler.exportVarName === "this"
                    ) {
                        await jsWriter.write(`}).call(this);\n`);
                    } else {
                        await jsWriter.write(`})();\n`);
                    }
                }
            }
            if (bundler.exportLib) {
                switch (bundler.exportRule) {
                    case ExportRule.CommonJS:
                        await jsWriter.write(
                            `module.exports = ${bundler.globalVarName};\n`
                        );
                        break;
                }
            }
        },
        async () => {
            if (dtsWriter === null) return;
            await dtsWriter.write("}\n");
            for (const module of bundler.dtsPreloadModules) {
                await dtsWriter.write(
                    `import ${bundler.globalVarName}_${module.varName} = require('${module.apath}');\n`
                );
                sourceMapLineOffset++;
            }
            for (const content of globalDeclarationModules) {
                await dtsWriter.write(content);
            }
            globalDeclarationModules.length = 0;
            if (entryModule !== null) {
                await dtsWriter.write(
                    `export = ${bundler.globalVarName}.${
                        entryModule!.id.varName
                    };\n`
                );
            }
        }
    );

    if (bundler.tsoptions.sourceMap) {
        if (bundler.inlineSourceMap) {
            const [_, dataUrl] = await Promise.all([
                writingJs,
                mapgen.toDataURL(),
            ]);
            await jsWriter.write(`//# sourceMappingURL=${dataUrl}`);
        } else {
            await Promise.all([
                writingJs.then(() =>
                    jsWriter.write(
                        `//# sourceMappingURL=${path.basename(
                            bundler.output
                        )}.map`
                    )
                ),
                mapgen.save(),
            ]);
        }
    } else {
        await writingJs;
    }
    await jsWriter.end();
    if (dtsWriter !== null) {
        await dtsWriter.end();
    }
}
