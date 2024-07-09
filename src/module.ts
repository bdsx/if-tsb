import * as path from "path";
import * as ts from "typescript";
import type { Bundler } from "./bundler";
import { memcache } from "./memmgr";
import { registerModuleReloader, reloadableRequire } from "./modulereloader";
import { StringFileData } from "./sourcemap/sourcefilecache";
import { tshelper } from "./tshelper";
import { ExportRule, ExternalMode, IfTsbError } from "./types";
import { CACHE_SIGNATURE, getCacheFilePath } from "./util/cachedir";
import { cachedStat } from "./util/cachedstat";
import { DisposableArray } from "./util/disposable";
import { ErrorPosition } from "./util/errpos";
import { fsp } from "./util/fsp";
import { ImportHelper } from "./util/importhelper";
import { LineStripper } from "./util/linestripper";
import { namelock } from "./util/namelock";
import { PropNameMap, propNameMap } from "./util/propnamecheck";
import { RAW_PROTOCOL, stripRawProtocol } from "./util/rawprotocol";
import { WriterStream } from "./util/streamwriter";
import {
    ScriptKind,
    SkipableTaskQueue,
    count,
    dirnameModulePath,
    getScriptKind,
    joinModulePath,
    setNullProto,
} from "./util/util";
export const CACHE_MEMORY_DEFAULT = 1024 * 1024 * 1024;
memcache.maximum = CACHE_MEMORY_DEFAULT;
export const memoryCache = new memcache.Map<number, RefinedModule>();

let moduleReloaderRegistered = false;

export class ImportInfo {
    constructor(
        public readonly apath: string,
        public readonly externalMode: ExternalMode,
        public readonly mpath: string,
        public readonly codepos: ErrorPosition | null,
        public readonly declaration: boolean,
    ) {}

    static stringify(imports: ImportInfo[]): string {
        type SerializedInfo = [
            string,
            string,
            boolean,
            ExternalMode,
            number?,
            number?,
            number?,
            string?,
        ];
        const out: SerializedInfo[] = [];
        for (const info of imports) {
            const line: SerializedInfo = [
                info.apath,
                info.mpath,
                info.declaration,
                info.externalMode,
            ];
            if (info.codepos !== null) {
                const pos = info.codepos;
                line[4] = pos.line;
                line[5] = pos.column;
                line[6] = pos.width;
                line[7] = pos.lineText;
            }
            out.push(line);
        }
        return JSON.stringify(out);
    }
    static parse(str: string): ImportInfo[] {
        const imports = JSON.parse(str);
        const out: ImportInfo[] = [];
        for (const [
            apath,
            mpath,
            declaration,
            externalMode,
            line,
            column,
            width,
            lineText,
        ] of imports) {
            const codepos =
                line == null
                    ? null
                    : new ErrorPosition(apath, line, column, width, lineText);
            out.push(
                new ImportInfo(
                    apath,
                    externalMode,
                    mpath,
                    codepos,
                    declaration,
                ),
            );
        }
        return out;
    }
}

/**
 * multple mtime check concurrently
 */
class MtimeChecker {
    private readonly list: Promise<number>[] = [];
    add(apath: string): void {
        this.list.push(cachedStat.mtime(apath));
    }
    addOpts(apath: string): void {
        this.list.push(cachedStat.mtime(apath).catch(() => -1));
    }
    addDecl(bundler: Bundler, apath: string): void {
        if (!bundler.declaration) {
            this.list.push(Promise.resolve(-1));
            return;
        }
        const kind = getScriptKind(apath);
        if (kind.kind !== ts.ScriptKind.JS) {
            this.list.push(Promise.resolve(-1));
            return;
        }
        this.list.push(
            cachedStat.mtime(kind.modulePath + ".d.ts").catch((err) => -1),
        );
    }

    wait(): Promise<number[]> {
        return Promise.all(this.list);
    }
}

function bufferSplit(buf: Buffer, code: number): Buffer[] {
    let prev = 0;
    const out: Buffer[] = [];

    for (;;) {
        const next = buf.indexOf(code, prev);
        if (next === -1) {
            out.push(buf.subarray(prev));
            return out;
        }
        out.push(buf.subarray(prev, next));
        prev = next + 1;
    }
}

export class RefinedModule {
    firstLineComment: string | null = null;
    sourceMapOutputLineOffset: number = 0;
    outputLineCount: number;
    imports: ImportInfo[] = [];
    sourceMapText: string | null = null;
    content: Buffer | null = null;
    declaration: Buffer | null = null;
    globalDeclaration: Buffer | null = null;
    size: number;
    errored = false;
    sourceMtime: number;
    dtsMtime: number;
    tsconfigMtime: number;

    constructor(public readonly id: BundlerModuleId) {}

    private readonly saving = new SkipableTaskQueue();

    contentEndsWith(buf: Uint8Array): boolean {
        if (this.content === null) return false;
        return this.content
            .subarray(this.content.length - buf.length)
            .equals(buf);
    }

    checkRelativePath(rpath: string): boolean {
        if (this.content === null) return false;
        const lineend = this.content.indexOf(10);
        if (lineend === -1) return false;
        const matched = this.content
            .subarray(0, lineend)
            .toString()
            .match(/^\/\/ (.+)$/);
        if (matched === null) return false;
        return matched[1] === rpath;
    }

    clear(): void {
        this.firstLineComment = null;
        this.imports.length = 0;
        this.sourceMapText = null;
        this.content = null;
        this.size = 0;
    }

    save(bundler: Bundler): void {
        if (this.errored) return;
        bundler.taskQueue.ref();
        this.saving.run(async () => {
            try {
                await namelock.lock(this.id.number);
                const writer = new WriterStream(
                    getCacheFilePath(this.id.number),
                );
                await writer.write(this.sourceMtime + "\0");
                await writer.write(this.dtsMtime + "\0");
                await writer.write(this.tsconfigMtime + "\0");
                await writer.write(ImportInfo.stringify(this.imports) + "\0");
                await writer.write(
                    this.firstLineComment ? this.firstLineComment + "\0" : "\0",
                );
                await writer.write(this.sourceMapOutputLineOffset + "\0");
                await writer.write(this.outputLineCount + "\0");
                await writer.write(
                    this.sourceMapText !== null
                        ? this.sourceMapText.replace(/[\r\n]/g, "") + "\0"
                        : "\0",
                );
                await writer.write(this.content + "\0");
                await writer.write(
                    this.declaration !== null ? this.declaration + "\0" : "\0",
                );
                await writer.write(
                    this.globalDeclaration !== null
                        ? this.globalDeclaration + "\0"
                        : "\0",
                );
                await writer.write(CACHE_SIGNATURE);
                await writer.end();
                bundler.taskQueue.unref();
            } finally {
                namelock.unlock(this.id.number);
            }
        });
    }

    async load(): Promise<boolean> {
        const cachepath = getCacheFilePath(this.id.number);
        let content: Buffer;
        try {
            await namelock.lock(this.id.number);
            content = await fsp.readFileBuffer(cachepath);
        } finally {
            namelock.unlock(this.id.number);
        }
        if (
            !content
                .subarray(content.length - CACHE_SIGNATURE.length)
                .equals(CACHE_SIGNATURE)
        )
            return false;
        const [
            sourceMtime,
            dtsMtime,
            tsconfigMtime,
            imports,
            firstLineComment,
            sourceMapOutputLineOffset,
            outputLineCount,
            sourceMapText,
            source,
            declaration,
            globalDeclaration,
        ] = bufferSplit(content, 0);
        this.sourceMtime = +sourceMtime.toString();
        this.dtsMtime = +dtsMtime.toString();
        this.tsconfigMtime = +tsconfigMtime.toString();
        this.imports =
            imports.length === 0 ? [] : ImportInfo.parse(imports.toString());
        this.firstLineComment =
            firstLineComment.length === 0 ? null : firstLineComment.toString();
        this.sourceMapOutputLineOffset = +sourceMapOutputLineOffset.toString();
        this.outputLineCount = +outputLineCount.toString();
        this.sourceMapText =
            sourceMapText.length === 0 ? null : sourceMapText.toString();
        this.content = source;
        this.declaration = declaration.length === 0 ? null : declaration;
        this.globalDeclaration =
            globalDeclaration.length === 0 ? null : globalDeclaration;
        this.size =
            source.length +
            declaration.length +
            globalDeclaration.length +
            2048;
        return true;
    }

    static async getRefined(
        bundler: Bundler,
        id: BundlerModuleId,
    ): Promise<{
        refined: RefinedModule | null;
        sourceMtime: number;
        dtsMtime: number;
    }> {
        let sourceMtime = -1;
        let dtsMtime = -1;
        _error: try {
            const cached = memoryCache.take(id.number);
            if (cached != null) {
                const prom = new MtimeChecker();
                prom.add(id.apath);
                prom.addDecl(bundler, id.apath);
                const [srcmtime, dtsmtime] = await prom.wait();
                sourceMtime = srcmtime;
                dtsMtime = dtsmtime;
                if (cached.sourceMtime !== sourceMtime) {
                    memcache.expire(cached);
                    break _error;
                }
                if (dtsMtime !== -1 && cached.dtsMtime !== dtsMtime) {
                    memcache.expire(cached);
                    break _error;
                }
                if (cached.tsconfigMtime !== bundler.tsconfigMtime) {
                    memcache.expire(cached);
                    break _error;
                }
                return { refined: cached, sourceMtime, dtsMtime };
            } else {
                try {
                    await namelock.lock(id.number);
                    const cachepath = getCacheFilePath(id.number);
                    const checker = new MtimeChecker();
                    checker.addOpts(cachepath);
                    checker.addOpts(id.apath);
                    checker.addDecl(bundler, id.apath);
                    const [cacheMtime, srcmtime, dtsmtime] =
                        await checker.wait();
                    sourceMtime = srcmtime;
                    dtsMtime = dtsmtime;
                    if (cacheMtime === -1) break _error;
                    if (cacheMtime < bundler.tsconfigMtime) break _error;
                    if (cacheMtime < srcmtime) break _error;
                    if (
                        bundler.declaration &&
                        dtsmtime !== -1 &&
                        cacheMtime < dtsmtime
                    )
                        break _error;
                } finally {
                    namelock.unlock(id.number);
                }
                const refined = new RefinedModule(id);
                const loaded = await refined.load();
                memoryCache.register(id.number, refined);
                if (!loaded) break _error;
                if (refined.sourceMtime !== sourceMtime) break _error;
                if (refined.dtsMtime !== dtsMtime) break _error;
                if (refined.tsconfigMtime !== bundler.tsconfigMtime)
                    break _error;
                return { refined, sourceMtime, dtsMtime };
            }
        } catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }
        return { refined: null, sourceMtime, dtsMtime };
    }
}

export enum CheckState {
    None,
    Entered,
    Checked,
}

export enum ImportProtocol {
    Normal,
    Raw,
}

export class ParsedImportPath {
    private importAPath: string | null | undefined = undefined;

    constructor(
        public readonly helper: RefineHelper,
        public readonly importName: string,
        public readonly mpath: string,
    ) {}

    literal(factory: ts.NodeFactory): ts.StringLiteral {
        return factory.createStringLiteral(this.mpath);
    }

    call(factory: ts.NodeFactory): ts.Expression {
        return this.helper.callRequire(factory, this.literal(factory));
    }

    import(factory: ts.NodeFactory): ts.ExternalModuleReference {
        const mpathLitral = this.literal(factory);
        return factory.createExternalModuleReference(mpathLitral);
    }

    getAbsolutePath(): string {
        if (this.importAPath !== undefined) {
            if (this.importAPath === null) {
                throw new IfTsbErrorMessage(IfTsbError.ModuleNotFound, null);
            }
            return this.importAPath;
        }
        const module = this.helper.module;
        const bundler = module.bundler;
        let modulePath = ts.nodeModuleNameResolver(
            this.importName,
            module.id.apath,
            bundler.tsoptions,
            bundler.sys,
            bundler.moduleResolutionCache,
        );
        if (!modulePath.resolvedModule && this.importName === ".")
            modulePath = ts.nodeModuleNameResolver(
                "./index",
                module.id.apath,
                bundler.tsoptions,
                bundler.sys,
                bundler.moduleResolutionCache,
            );
        const info = modulePath.resolvedModule;
        if (info == null) {
            this.importAPath = null;
            this.helper.throwImportError(this.importName);
        } else {
            this.importAPath = path.isAbsolute(info.resolvedFileName)
                ? path.join(info.resolvedFileName)
                : path.join(bundler.basedir, info.resolvedFileName);
        }
        return this.importAPath;
    }

    getImportAPath(): string | null {
        const moduleAPath = this.getAbsolutePath();
        return moduleAPath !== null
            ? getScriptKind(moduleAPath).modulePath.replace(/\\/g, "/")
            : null;
    }

    isBuiltInModule(): boolean {
        if (this.importName.startsWith(".")) return false;
        return tshelper.isBuiltInModule(this.mpath);
    }

    isExternalModule(): boolean {
        if (this.importName.startsWith(".")) return false;
        if (this.helper.bundler.isBundlable(this.mpath)) return false;
        return true;
    }
}

export interface ChildModule {
    module: BundlerModule;
    importLine: ErrorPosition | null;
}

export class BundlerModule {
    public readonly id: BundlerModuleId;
    public readonly rpath: string;
    public children: ChildModule[] | null = null;
    public isEntry = false;
    public checkState = CheckState.None;
    public needDeclaration = false;

    constructor(
        public readonly bundler: Bundler,
        public readonly mpath: string,
        apath: string,
    ) {
        this.id = bundler.getModuleId(apath, ExternalMode.NoExternal);
        this.rpath = path.relative(bundler.basedir, stripRawProtocol(apath));
    }

    error(pos: ErrorPosition | null, code: number, message: string): void {
        if (pos === null) {
            this.bundler.main.report(this.rpath, 0, 0, code, message, "", 0);
        } else {
            this.bundler.main.report(
                this.rpath,
                pos.line,
                pos.column,
                code,
                message,
                pos.lineText,
                pos.width,
            );
        }
    }

    errorWithNode(node: ts.Node, code: number, message: string): void {
        return this.error(ErrorPosition.fromNode(node), code, message);
    }

    private _refine(
        sourceMtime: number,
        dtsMtime: number,
    ): RefinedModule | null {
        if (sourceMtime === -1) {
            if (!this.bundler.suppressModuleNotFoundErrors) {
                this.error(
                    null,
                    IfTsbError.ModuleNotFound,
                    `Cannot find module '${this.mpath}'. refine failed.`,
                );
            }
            return null;
        }

        this.children = null;

        const refined = new RefinedModule(this.id);
        let content = `// ${this.rpath}\n`;
        refined.sourceMtime = sourceMtime;
        refined.dtsMtime = dtsMtime;
        refined.tsconfigMtime = this.bundler.tsconfigMtime;

        const moduleAPath = this.id.apath;
        const bundler = this.bundler;

        if (moduleAPath.startsWith(RAW_PROTOCOL)) {
            // raw
            content += `${refined.id.varName}:`;
            using file = StringFileData.take(stripRawProtocol(moduleAPath));
            content += JSON.stringify(file.contents);
            content += ",\n";
        } else {
            // js, ts, json
            let useDirName = false;
            let useFileName = false;
            let useModule = false;
            let useGlobal = false;
            let useModuleExports = false;
            let useExports = false;
            let exportEquals = false;
            let moduleDeclaration = "";
            let globalDeclaration = "";
            const that = this;

            const moduleinfo = getScriptKind(moduleAPath);
            const printer = ts.createPrinter();

            using refs = new DisposableArray();

            let typeChecker: ts.TypeChecker;

            function getSourceFile(filepath: string): ts.SourceFile {
                const fileName = filepath.replace(/\\/g, "/");
                const data = bundler.sourceFileCache.take(fileName);
                refs.append(data);
                return data.sourceFile!;
            }

            let sourceFile: ts.SourceFile;
            try {
                sourceFile = getSourceFile(moduleAPath);
            } catch (err) {
                that.error(
                    null,
                    IfTsbError.ModuleNotFound,
                    err.message + " " + moduleAPath,
                );
                return null;
            }
            const helper = new RefineHelper(
                this.bundler,
                this,
                refined,
                sourceFile,
            );

            const mapBase: PropNameMap = {
                __dirname() {
                    useDirName = true;
                },
                __filename() {
                    useFileName = true;
                },
                module: {
                    __invoke() {
                        useModule = true;
                    },
                    exports() {
                        useModuleExports = true;
                    },
                },
                global() {
                    useGlobal = true;
                },
                exports() {
                    useExports = true;
                },
                import: {
                    meta: {
                        url(factory) {
                            useFileName = true;
                            return factory.createIdentifier("__filename");
                        },
                    },
                },
            };
            setNullProto(mapBase);

            const jsFactory = (ctx: ts.TransformationContext) => {
                const tool = new MakeTool(ctx, helper, sourceFile, false);
                const importer = new JsImporter(tool, tool.globalVar);

                const importCast = (stringLike: ts.Node) => {
                    const literal = helper.getStringLiteral(stringLike);
                    const importPath = helper.parseImportPath(literal);
                    if (importPath === null) return null;
                    const res = importer.importNode(importPath);
                    if (res === NOIMPORT) return ctx.factory.createNull();
                    return res;
                };
                const visit = (
                    _node: ts.Node,
                ): ts.Node | ts.Node[] | undefined => {
                    try {
                        const mapped = propNameMap(ctx.factory, _node, mapBase);
                        if (mapped !== undefined) {
                            return helper.visitChildren(mapped, visit, ctx);
                        }
                        switch (_node.kind) {
                            // case ts.SyntaxKind.ExportDeclaration:
                            //     break;
                            case ts.SyntaxKind.ImportDeclaration:
                                // import 'module'; import { a } from 'module'; import a from 'module';
                                const node = _node as ts.ImportDeclaration;
                                const importPath = helper.parseImportPath(
                                    node.moduleSpecifier,
                                );
                                if (importPath === null) return node;
                                const res = importer.importNode(importPath);
                                const importCall = importCast(
                                    node.moduleSpecifier,
                                );
                                if (importCall === null) return node;
                                const clause = node.importClause;
                                if (clause == null) {
                                    // import 'module';
                                    return importCall;
                                }
                                if (res === NOIMPORT) return undefined;
                                if (clause.namedBindings != null) {
                                    switch (clause.namedBindings.kind) {
                                        case ts.SyntaxKind.NamespaceImport:
                                            // import * as a from 'module';
                                            if (clause.namedBindings == null) {
                                                throw new IfTsbErrorMessage(
                                                    IfTsbError.Unsupported,
                                                    `Unexpected import syntax`,
                                                );
                                            }
                                            return ctx.factory.createVariableDeclaration(
                                                clause.namedBindings.name,
                                                undefined,
                                                undefined,
                                                importCall,
                                            );
                                        case ts.SyntaxKind.NamedImports:
                                            // import { a } from 'module';
                                            const list: ts.BindingElement[] =
                                                [];
                                            for (const element of clause
                                                .namedBindings.elements) {
                                                list.push(
                                                    ctx.factory.createBindingElement(
                                                        undefined,
                                                        element.propertyName,
                                                        element.name,
                                                    ),
                                                );
                                            }
                                            return ctx.factory.createVariableDeclaration(
                                                ctx.factory.createObjectBindingPattern(
                                                    list,
                                                ),
                                                undefined,
                                                undefined,
                                                importCall,
                                            );
                                    }
                                } else if (clause.name != null) {
                                    // import a from 'module';
                                    return ctx.factory.createElementAccessExpression(
                                        importCall,
                                        ctx.factory.createStringLiteral(
                                            "default",
                                        ),
                                    );
                                } else {
                                    throw new IfTsbErrorMessage(
                                        IfTsbError.Unsupported,
                                        `Unexpected import syntax`,
                                    );
                                }
                            case ts.SyntaxKind.ImportEqualsDeclaration: {
                                // import = require('module');
                                const node =
                                    _node as ts.ImportEqualsDeclaration;

                                const ref = node.moduleReference;
                                if (
                                    ref.kind ===
                                    ts.SyntaxKind.ExternalModuleReference
                                ) {
                                    const importPath = helper.parseImportPath(
                                        ref.expression,
                                    );
                                    if (importPath === null) return node;
                                    const res = importer.importNode(importPath);
                                    if (res === NOIMPORT) return undefined;
                                    return ctx.factory.createVariableDeclaration(
                                        node.name,
                                        undefined,
                                        undefined,
                                        res,
                                    );
                                }
                                break;
                            }
                            case ts.SyntaxKind.CallExpression: {
                                let node = _node as ts.CallExpression;
                                switch (node.expression.kind) {
                                    case ts.SyntaxKind.ImportKeyword: {
                                        if (node.arguments.length !== 1) {
                                            throw new IfTsbErrorMessage(
                                                IfTsbError.Unsupported,
                                                `Cannot call import with multiple parameters`,
                                            );
                                        }
                                        const importPath =
                                            helper.parseImportPath(
                                                node.arguments[0],
                                            );
                                        if (importPath === null) return node;
                                        const res =
                                            importer.importNode(importPath);
                                        if (res === NOIMPORT)
                                            return ctx.factory.createNull();
                                        return res;
                                    }
                                    case ts.SyntaxKind.Identifier: {
                                        const identifier =
                                            node.expression as ts.Identifier;
                                        if (identifier.text === "require") {
                                            return (
                                                importCast(node.arguments[0]) ??
                                                node
                                            );
                                        } else {
                                            const signature =
                                                typeChecker.getResolvedSignature(
                                                    node,
                                                );
                                            if (
                                                typeof signature === "undefined"
                                            )
                                                break;
                                            const { declaration } = signature;
                                            if (declaration == null) break;
                                            const fileName =
                                                declaration.getSourceFile()
                                                    .fileName;
                                            if (
                                                !fileName.endsWith(
                                                    "/if-tsb/reflect.d.ts",
                                                )
                                            )
                                                break;
                                            if (
                                                declaration.kind ===
                                                ts.SyntaxKind.JSDocSignature
                                            )
                                                break;
                                            if (declaration.name == null) break;
                                            if (
                                                (node as any).original != null
                                            ) {
                                                node = (node as any).original;
                                            }
                                            const funcName =
                                                declaration.name.getText();
                                            const tparams =
                                                TemplateParams.create(
                                                    tool,
                                                    helper,
                                                    funcName,
                                                    typeChecker,
                                                    node,
                                                );
                                            switch (funcName) {
                                                case "reflect": {
                                                    if (tparams == null) break;
                                                    const path =
                                                        tparams.readString();
                                                    const funcname =
                                                        tparams.readString();
                                                    const importPath =
                                                        tparams.readImportPath();

                                                    if (
                                                        !moduleReloaderRegistered
                                                    ) {
                                                        moduleReloaderRegistered =
                                                            true;
                                                        registerModuleReloader(
                                                            that.bundler
                                                                .tsconfigOriginal
                                                                .compilerOptions,
                                                        );
                                                    }
                                                    const reflecter =
                                                        reloadableRequire(
                                                            require,
                                                            importPath,
                                                        );
                                                    return reflecter[funcname](
                                                        ctx,
                                                        typeChecker,
                                                        ...tparams.types,
                                                    );
                                                }
                                                case "importRaw": {
                                                    let mpath: string;
                                                    if (tparams == null) {
                                                        const first =
                                                            node.arguments[0];
                                                        if (
                                                            first === undefined
                                                        ) {
                                                            break;
                                                        }
                                                        mpath =
                                                            helper.parseImportPath(
                                                                first,
                                                            ).mpath;
                                                    } else {
                                                        const param =
                                                            tparams.readString();
                                                        mpath =
                                                            helper.makeImportModulePath(
                                                                param,
                                                            ).mpath;
                                                    }
                                                    const res =
                                                        importer.importRaw(
                                                            mpath,
                                                        );
                                                    if (res === NOIMPORT) break;
                                                    return res;
                                                }
                                            }
                                        }
                                    }
                                }
                                break;
                            }
                        }
                    } catch (err) {
                        if (err instanceof IfTsbErrorMessage) {
                            if (err.message !== null) {
                                refined.errored = true;
                                that.error(
                                    helper.getErrorPosition(),
                                    err.code,
                                    err.message,
                                );
                            }
                            return _node;
                        } else {
                            throw err;
                        }
                    }
                    return helper.visitChildren(_node, visit, ctx);
                };

                return (srcfile: ts.SourceFile) => {
                    if (srcfile.fileName !== sourceFile.fileName)
                        return srcfile;
                    return ts.visitEachChild(srcfile, visit, ctx);
                };
            };

            const declFactory = (sourceFile: ts.SourceFile) => {
                return (ctx: ts.TransformationContext) => {
                    const tool = new MakeTool(ctx, helper, sourceFile, true);
                    const importer = new DeclNameImporter(tool, tool.globalVar);
                    const arrImporter = new DeclStringImporter(tool, [
                        bundler.globalVarName,
                    ]);

                    const visitAbsoluting = (
                        outerModulePath: ParsedImportPath | null,
                    ) => {
                        const visitAbsoluting = (
                            _node: ts.Node,
                        ): ts.Node[] | ts.Node | undefined => {
                            try {
                                switch (_node.kind) {
                                    case ts.SyntaxKind.Identifier: {
                                        if (_node.parent == null) break;
                                        const symbol =
                                            typeChecker.getSymbolAtLocation(
                                                _node,
                                            );
                                        if (symbol == null) break;
                                        if (symbol.declarations == null) break;
                                        if (
                                            !tshelper.isRootIdentifier(
                                                _node as ts.Identifier,
                                            )
                                        )
                                            break;
                                        if (
                                            symbol.declarations.indexOf(
                                                _node.parent as ts.Declaration,
                                            ) !== -1
                                        )
                                            break;

                                        for (const _decl of symbol.declarations) {
                                            switch (_decl.kind) {
                                                case ts.SyntaxKind
                                                    .NamespaceImport: {
                                                    const decl =
                                                        _decl as ts.NamespaceImport;
                                                    const importDecl =
                                                        decl.parent.parent;
                                                    const importPath =
                                                        helper.parseImportPath(
                                                            importDecl.moduleSpecifier,
                                                        );
                                                    if (importPath === null)
                                                        continue;
                                                    const res =
                                                        importer.importNode(
                                                            importPath,
                                                        );
                                                    if (res === NOIMPORT)
                                                        continue;
                                                    return res;
                                                }
                                                case ts.SyntaxKind
                                                    .ImportSpecifier: {
                                                    const decl =
                                                        _decl as ts.ImportSpecifier;
                                                    const importDecl =
                                                        decl.parent.parent
                                                            .parent;
                                                    const importPath =
                                                        helper.parseImportPath(
                                                            importDecl.moduleSpecifier,
                                                        );
                                                    if (importPath === null)
                                                        continue;
                                                    if (
                                                        _node.parent.kind ===
                                                        ts.SyntaxKind
                                                            .ExpressionWithTypeArguments
                                                    ) {
                                                        const res =
                                                            arrImporter.importNode(
                                                                importPath,
                                                            );
                                                        if (res === NOIMPORT)
                                                            continue;
                                                        // transformer.
                                                        return tool.createIdentifierChain(
                                                            [
                                                                ...res,
                                                                decl.propertyName ||
                                                                    decl.name,
                                                            ],
                                                        );
                                                    } else {
                                                        const res =
                                                            importer.importNode(
                                                                importPath,
                                                            );
                                                        if (res === NOIMPORT)
                                                            continue;
                                                        return ctx.factory.createQualifiedName(
                                                            res,
                                                            decl.propertyName ||
                                                                decl.name,
                                                        );
                                                    }
                                                }
                                                case ts.SyntaxKind.Parameter:
                                                case ts.SyntaxKind
                                                    .TypeParameter:
                                                    return _node;
                                                default: {
                                                    const res =
                                                        tool.analyizeDeclPath(
                                                            _node,
                                                            _decl,
                                                            outerModulePath,
                                                        );
                                                    return visitWith(
                                                        res,
                                                        visitAbsoluting,
                                                    );
                                                }
                                            }
                                        }
                                        return _node;
                                    }
                                }
                                return visitWith(_node, visitAbsoluting);
                            } catch (err) {
                                if (err instanceof IfTsbErrorMessage) {
                                    helper.error(err);
                                    return _node;
                                } else {
                                    throw err;
                                }
                            }
                        };
                        return visitAbsoluting;
                    };

                    const visitWith = (
                        _node: ts.Node,
                        visitor: ts.Visitor,
                    ): ts.Node[] | ts.Node | undefined => {
                        try {
                            switch (_node.kind) {
                                case ts.SyntaxKind.ModuleDeclaration: {
                                    let node = _node as ts.ModuleDeclaration;
                                    const res =
                                        importer.importFromModuleDecl(node);
                                    if (res === null) break;
                                    if (res === GLOBAL) {
                                        // global module
                                        const visited = ts.visitEachChild(
                                            node,
                                            visitAbsoluting(null),
                                            ctx,
                                        );
                                        globalDeclaration += "declare global ";
                                        globalDeclaration += printer.printNode(
                                            ts.EmitHint.Unspecified,
                                            visited.body!,
                                            sourceFile,
                                        );
                                        globalDeclaration += "\n";
                                    } else if (res.module === null) {
                                        // external module
                                        const visited = ts.visitEachChild(
                                            node,
                                            visitAbsoluting(res.importPath),
                                            ctx,
                                        );
                                        globalDeclaration += 'declare module "';
                                        globalDeclaration +=
                                            res.importPath.mpath;
                                        globalDeclaration += '"';
                                        globalDeclaration += printer.printNode(
                                            ts.EmitHint.Unspecified,
                                            visited.body!,
                                            sourceFile,
                                        );
                                        globalDeclaration += "\n";
                                    } else {
                                        const visited = ts.visitEachChild(
                                            node,
                                            visitAbsoluting(res.importPath),
                                            ctx,
                                        );
                                        moduleDeclaration +=
                                            "export namespace ";
                                        moduleDeclaration +=
                                            res.moduleId.varName;
                                        moduleDeclaration += printer.printNode(
                                            ts.EmitHint.Unspecified,
                                            visited.body!,
                                            sourceFile,
                                        );
                                        moduleDeclaration += "\n";
                                    }
                                    return undefined;
                                }
                                case ts.SyntaxKind.DeclareKeyword:
                                    return undefined;
                                case ts.SyntaxKind.ExportDeclaration: {
                                    const node = _node as ts.ExportDeclaration;
                                    const module = node.moduleSpecifier;
                                    if (module != null) {
                                        throw new IfTsbErrorMessage(
                                            IfTsbError.Unsupported,
                                            `if-tsb cannot export identifiers from the module`,
                                        );
                                    }
                                    break;
                                }
                                case ts.SyntaxKind.ExportAssignment: {
                                    const exportName =
                                        bundler.globalVarName + "_exported";
                                    const out: ts.Node[] = [];
                                    const node = _node as ts.ExportAssignment;
                                    let identifier: ts.Identifier | string;
                                    const exports: ts.ExportSpecifier[] = [];
                                    if (
                                        node.expression.kind ===
                                        ts.SyntaxKind.Identifier
                                    ) {
                                        identifier =
                                            node.expression as ts.Identifier;
                                        exports.push(
                                            ctx.factory.createExportSpecifier(
                                                false,
                                                identifier,
                                                exportName,
                                            ),
                                        );
                                    } else {
                                        identifier = exportName;
                                        out.push(
                                            ctx.factory.createImportEqualsDeclaration(
                                                undefined,
                                                false,
                                                identifier,
                                                node.expression as ts.ModuleReference,
                                            ),
                                        );
                                        exports.push(
                                            ctx.factory.createExportSpecifier(
                                                false,
                                                undefined,
                                                identifier,
                                            ),
                                        );
                                    }

                                    if (node.isExportEquals) {
                                        // export = item
                                        exportEquals = true;
                                    } else {
                                        // export defualt item
                                        exports.push(
                                            ctx.factory.createExportSpecifier(
                                                false,
                                                identifier,
                                                "default",
                                            ),
                                        );
                                    }
                                    out.push(
                                        ctx.factory.createExportDeclaration(
                                            undefined,
                                            false,
                                            ctx.factory.createNamedExports(
                                                exports,
                                            ),
                                        ),
                                    );
                                    return out;
                                }
                                case ts.SyntaxKind.ImportEqualsDeclaration: {
                                    const node =
                                        _node as ts.ImportEqualsDeclaration;

                                    const ref = node.moduleReference;
                                    if (
                                        ref.kind ===
                                        ts.SyntaxKind.ExternalModuleReference
                                    ) {
                                        const importPath =
                                            helper.parseImportPath(
                                                ref.expression,
                                            );
                                        if (importPath === null) return node;
                                        const res =
                                            importer.importNode(importPath);
                                        if (res === NOIMPORT) return undefined;
                                        return ctx.factory.createImportEqualsDeclaration(
                                            undefined,
                                            false,
                                            node.name,
                                            res,
                                        );
                                    }
                                    break;
                                }
                                case ts.SyntaxKind.ImportType: {
                                    // let v:import('module').Type;
                                    const node = _node as ts.ImportTypeNode;
                                    const importPath = helper.parseImportPath(
                                        node.argument,
                                    );
                                    if (importPath === null) return node;
                                    const res = importer.importNode(importPath);
                                    if (res === NOIMPORT) return node;
                                    const entityName = tool.joinEntityNames(
                                        res,
                                        node.qualifier,
                                    );
                                    if (node.isTypeOf) {
                                        return ctx.factory.createTypeOfExpression(
                                            tool.castToIdentifier(entityName),
                                        );
                                    } else {
                                        return entityName;
                                    }
                                }
                                case ts.SyntaxKind.ImportDeclaration: {
                                    // import 'module'; import { a } from 'module'; import a from 'module';
                                    const node = _node as ts.ImportDeclaration;
                                    const importPath = helper.parseImportPath(
                                        node.moduleSpecifier,
                                    );
                                    if (importPath === null) return node;
                                    const res = importer.importNode(importPath);
                                    const clause = node.importClause;
                                    if (clause == null) {
                                        // import 'module';
                                        return undefined;
                                    }
                                    if (res === NOIMPORT) return undefined;
                                    if (clause.namedBindings != null) {
                                        const out: ts.Node[] = [];
                                        switch (clause.namedBindings.kind) {
                                            case ts.SyntaxKind.NamespaceImport:
                                                // import * as a from 'module';
                                                if (
                                                    clause.namedBindings == null
                                                ) {
                                                    throw new IfTsbErrorMessage(
                                                        IfTsbError.Unsupported,
                                                        `Unexpected import syntax`,
                                                    );
                                                }
                                                return ctx.factory.createImportEqualsDeclaration(
                                                    undefined,
                                                    false,
                                                    clause.namedBindings.name,
                                                    res,
                                                );
                                            case ts.SyntaxKind.NamedImports:
                                                // import { a } from 'module';
                                                for (const element of clause
                                                    .namedBindings.elements) {
                                                    out.push(
                                                        ctx.factory.createImportEqualsDeclaration(
                                                            undefined,
                                                            false,
                                                            element.name,
                                                            ctx.factory.createQualifiedName(
                                                                res,
                                                                element.propertyName ||
                                                                    element.name,
                                                            ),
                                                        ),
                                                    );
                                                }
                                                break;
                                        }
                                        return out;
                                    } else if (clause.name != null) {
                                        // import a from 'module';
                                        return ctx.factory.createImportEqualsDeclaration(
                                            undefined,
                                            false,
                                            clause.name,
                                            ctx.factory.createQualifiedName(
                                                res,
                                                bundler.globalVarName +
                                                    "_exported",
                                            ),
                                        );
                                    } else {
                                        throw new IfTsbErrorMessage(
                                            IfTsbError.Unsupported,
                                            `Unexpected import syntax`,
                                        );
                                    }
                                }
                                case ts.SyntaxKind.CallExpression: {
                                    const node = _node as ts.CallExpression;
                                    switch (node.expression.kind) {
                                        case ts.SyntaxKind.ImportKeyword: {
                                            // const res = import('module');
                                            if (node.arguments.length !== 1) {
                                                throw new IfTsbErrorMessage(
                                                    IfTsbError.Unsupported,
                                                    `Cannot call import with multiple parameters`,
                                                );
                                            }
                                            const importPath =
                                                helper.parseImportPath(
                                                    node.arguments[0],
                                                );
                                            if (importPath === null)
                                                return node;
                                            const res =
                                                importer.importNode(importPath);
                                            if (res === NOIMPORT)
                                                return ctx.factory.createNull();
                                            return res;
                                        }
                                    }
                                    break;
                                }
                            }
                        } catch (err) {
                            if (err instanceof IfTsbErrorMessage) {
                                if (err.message !== null) {
                                    refined.errored = true;
                                    that.error(
                                        helper.getErrorPosition(),
                                        err.code,
                                        err.message,
                                    );
                                }
                                return _node;
                            }
                            throw err;
                        }
                        return helper.visitChildren(_node, visitor, ctx);
                    };

                    const visit = (
                        _node: ts.Node,
                    ): ts.Node[] | ts.Node | undefined => {
                        return visitWith(_node, visit);
                    };

                    return (srcfile: ts.SourceFile) => {
                        if (srcfile.fileName !== sourceFile.fileName)
                            return srcfile;
                        return ts.visitEachChild(srcfile, visit, ctx);
                    };
                };
            };

            const transformer = {
                after: [jsFactory],
                afterDeclarations: [declFactory(sourceFile)],
            };

            let sourceMapText: string | null = null;
            let stricted = false;
            const allowedSources = new Set<string>();
            allowedSources.add(moduleAPath);

            if (moduleinfo.kind === ts.ScriptKind.JSON) {
                if (this.isEntry) {
                    switch (bundler.exportRule) {
                        case ExportRule.None:
                            break;
                        case ExportRule.ES2015:
                            this.error(
                                null,
                                IfTsbError.Unsupported,
                                `if-tsb does not support export JSON as ES2015 module`,
                            );
                            break;
                        case ExportRule.Direct:
                            this.error(
                                null,
                                IfTsbError.Unsupported,
                                `if-tsb does not support export JSON to ${bundler.exportVarName}`,
                            );
                            break;
                        case ExportRule.Var:
                            content += `return ${sourceFile.text.trim()};\n`;
                            break;
                        default:
                            content += `module.exports=${sourceFile.text.trim()};\n`;
                            break;
                    }
                } else {
                    if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                        content += `${refined.id.varName}(){\n`;
                    } else {
                        content += `${refined.id.varName}:function(){\n`;
                    }
                    content += `if(${bundler.globalVarName}.${refined.id.varName}.exports!=null) return ${bundler.globalVarName}.${refined.id.varName}.exports;\n`;
                    content += `\nreturn ${bundler.globalVarName}.${refined.id.varName}.exports=${sourceFile.text};\n},\n`;
                }
                if (this.needDeclaration) {
                    let decltext = `// ${this.rpath}\n`;
                    if (this.isEntry) {
                        decltext += `(`;
                        decltext += sourceFile.text.trim();
                        decltext += ");\n";
                    } else {
                        decltext += `export const ${refined.id.varName}:`;
                        decltext += sourceFile.text.trim();
                        decltext += ";\n";
                    }
                    refined.declaration = Buffer.from(decltext);
                }
            } else {
                let declaration: string | null = null;
                let pureContent = "";
                const filePathForTesting = moduleAPath.replace(/\\/g, "/");
                const superHost = bundler.compilerHost;
                const compilerHost: ts.CompilerHost = Object.setPrototypeOf(
                    {
                        getSourceFile(
                            fileName: string,
                            languageVersion: ts.ScriptTarget,
                            onError?: (message: string) => void,
                            shouldCreateNewSourceFile?: boolean,
                        ) {
                            if (fileName === filePathForTesting)
                                return sourceFile;
                            if (bundler.faster) {
                                return undefined;
                            }
                            return getSourceFile(fileName);
                        },
                        writeFile(name: string, text: string) {
                            if (text === "") text = " ";
                            const info = getScriptKind(name);
                            if (info.kind === ts.ScriptKind.JS) {
                                pureContent = text;
                            } else if (info.kind === ts.ScriptKind.External) {
                                if (that.needDeclaration) {
                                    declaration = text;
                                }
                            } else if (info.ext === ".MAP") {
                                sourceMapText = text;
                            }
                        },
                        fileExists(fileName: string): boolean {
                            if (fileName.endsWith(".d.ts"))
                                return superHost.fileExists(fileName);
                            return allowedSources.has(
                                bundler.resolvePath(fileName),
                            );
                        },
                    },
                    superHost,
                );

                let diagnostics: ts.Diagnostic[] | undefined = bundler.faster
                    ? undefined
                    : [];
                const tsoptions: ts.CompilerOptions = {
                    declaration: this.needDeclaration,
                    declarationDir: undefined,
                };
                Object.setPrototypeOf(tsoptions, this.bundler.tsoptions);

                if (!bundler.faster) {
                    for (const st of sourceFile.statements) {
                        if (st.kind === ts.SyntaxKind.ModuleDeclaration) {
                            if (
                                !tshelper.hasModifier(
                                    st,
                                    ts.SyntaxKind.DeclareKeyword,
                                )
                            )
                                continue;
                            if ((st.flags & ts.NodeFlags.Namespace) !== 0)
                                continue;
                            if (
                                (st.flags & ts.NodeFlags.GlobalAugmentation) !==
                                0
                            )
                                continue;
                            const moduleDecl = st as ts.ModuleDeclaration;
                            const importPath = helper.parseImportPath(
                                moduleDecl.name,
                            );
                            if (importPath === null) continue;
                            if (importPath.isBuiltInModule()) continue;
                            const apath = importPath.getAbsolutePath();
                            if (apath === null) continue;
                            allowedSources.add(apath);
                        }
                    }
                }
                bundler.program = ts.createProgram(
                    [...allowedSources],
                    tsoptions,
                    compilerHost,
                    bundler.program,
                    diagnostics,
                );
                typeChecker = bundler.program.getTypeChecker();
                if (bundler.verbose)
                    console.log(
                        `emit ${moduleAPath} ${new Date(
                            sourceMtime,
                        ).toLocaleTimeString()}`,
                    );
                const res = bundler.program.emit(
                    sourceFile,
                    undefined,
                    undefined,
                    false,
                    transformer,
                );
                if (!bundler.faster && res.diagnostics.length !== 0) {
                    refined!.errored = true;
                    tshelper.printDiagnostrics(res.diagnostics);
                }
                if (diagnostics != null) {
                    diagnostics.push(
                        ...bundler.program.getSyntacticDiagnostics(sourceFile),
                    );
                    if (diagnostics.length !== 0) {
                        refined!.errored = true;
                        tshelper.printDiagnostrics(diagnostics);
                    }
                }
                if (pureContent === "") {
                    if (diagnostics == null) {
                        tshelper.printDiagnostrics(
                            bundler.program.getSyntacticDiagnostics(sourceFile),
                        );
                    }

                    bundler.main.reportMessage(
                        IfTsbError.Unsupported,
                        `Failed to parse ${moduleAPath}`,
                    );
                    return null;
                }

                if (
                    this.needDeclaration &&
                    moduleinfo.kind === ts.ScriptKind.JS
                ) {
                    const dtsPath = moduleinfo.modulePath + ".d.ts";
                    try {
                        const dtsSourceFile = getSourceFile(dtsPath);
                        const res = ts.transform(
                            dtsSourceFile,
                            [declFactory(dtsSourceFile)],
                            bundler.tsoptions,
                        );
                        const printer = ts.createPrinter();
                        declaration = printer.printFile(res.transformed[0]);
                    } catch (err) {
                        if (err.code !== "ENOENT") throw err;
                    }
                }

                // content
                const stripper = new LineStripper(pureContent);
                refined.firstLineComment = stripper.strip((line) =>
                    line.startsWith("#"),
                );
                stricted =
                    stripper.strip((line) => line === '"use strict";') !==
                        null ||
                    stripper.strip((line) => line === "'use strict';") !== null;
                stripper.strip(
                    (line) =>
                        line ===
                        'Object.defineProperty(exports, "__esModule", { value: true });',
                );
                stripper.strip((line) => line === "exports.__esModule = true;");
                let lastLineIdx = pureContent.lastIndexOf("\n") + 1;
                let contentEnd = pureContent.length;
                const lastLine = pureContent.substr(lastLineIdx);
                if (lastLine.startsWith("//# sourceMappingURL=")) {
                    lastLineIdx -= 2;
                    if (pureContent.charAt(lastLineIdx) !== "\r") lastLineIdx++;
                    contentEnd = lastLineIdx;
                }
                if (this.isEntry) {
                    // ES6 export must be the global scope.
                    // it extracts the entry module to the global scope.

                    let exportTarget = "{}";
                    if (useGlobal) {
                        if (bundler.browserAPathRoot !== null) {
                            content += `${bundler.constKeyword} global=window;`;
                        }
                    }
                    switch (bundler.exportRule) {
                        case ExportRule.Direct:
                            exportTarget = bundler.exportVarName!;
                        case ExportRule.Var:
                            if (useExports) {
                                content += `${bundler.constKeyword} exports=${exportTarget};\n`;
                                if (useModule) {
                                    if (
                                        bundler.tsoptions.target! >=
                                        ts.ScriptTarget.ES2015
                                    ) {
                                        content += `const module={exports}\n`;
                                    } else {
                                        content += `var module={exports:exports}\n`;
                                    }
                                }
                            } else {
                                if (useModule) {
                                    content += `${bundler.constKeyword} ${bundler.globalVarName}_m=module;\n`;
                                }
                            }
                            break;
                    }
                } else {
                    const useStrict = !bundler.useStrict && stricted;

                    if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                        content += `${refined.id.varName}(){\n`;
                    } else {
                        content += `${refined.id.varName}:function(){\n`;
                    }
                    if (useStrict) content += '"use strict";\n';

                    content += `if(${bundler.globalVarName}.${refined.id.varName}.exports!=null) return ${bundler.globalVarName}.${refined.id.varName}.exports;\n`;
                    content += `${bundler.constKeyword} exports=${bundler.globalVarName}.${refined.id.varName}.exports={};\n`;
                    if (useModule) {
                        if (
                            bundler.tsoptions.target! >= ts.ScriptTarget.ES2015
                        ) {
                            content += `var module={exports};\n`;
                        } else {
                            content += `var module={exports:exports};\n`;
                        }
                        content += `${bundler.constKeyword} ${bundler.globalVarName}_m=module;\n`;
                    }
                }

                if (useFileName || useDirName) {
                    let rpath: string;

                    let prefix: string;
                    if (bundler.browserAPathRoot === null) {
                        // is node
                        prefix = this.isEntry ? "" : bundler.constKeyword + " ";
                        helper.addExternalList(
                            "path",
                            ExternalMode.Preimport,
                            null,
                            false,
                        );
                        rpath = path.relative(
                            path.dirname(bundler.output),
                            this.id.apath,
                        );
                    } else {
                        // is browser
                        prefix = this.isEntry
                            ? "var "
                            : bundler.constKeyword + " ";
                        rpath = path.relative(
                            bundler.browserAPathRoot,
                            this.id.apath,
                        );
                    }
                    helper.addExternalList(
                        "__resolve",
                        ExternalMode.Manual,
                        null,
                        false,
                    );
                    helper.addExternalList(
                        "__dirname",
                        ExternalMode.Manual,
                        null,
                        false,
                    );

                    if (useFileName) {
                        if (path.sep !== "/") rpath = rpath.replace(/\\/g, "/");
                        content += `${prefix}__filename=${
                            bundler.globalVarName
                        }.__resolve(${JSON.stringify(rpath)});\n`;
                    }
                    if (useDirName) {
                        rpath = path.dirname(rpath);
                        if (path.sep !== "/") rpath = rpath.replace(/\\/g, "/");
                        content += `${prefix}__dirname=${
                            bundler.globalVarName
                        }.__resolve(${JSON.stringify(rpath)});\n`;
                    }
                }
                refined.sourceMapOutputLineOffset =
                    count(content, "\n") - stripper.stripedLine;
                content += stripper.strippedComments;
                content += pureContent.substring(stripper.index, contentEnd);
                content += "\n";
                if (this.isEntry) {
                    switch (bundler.exportRule) {
                        case ExportRule.Var:
                            if (useExports) {
                                if (useModuleExports) {
                                    content += `return ${bundler.globalVarName}_m.exports;\n`;
                                } else {
                                    content += `return exports;\n`;
                                }
                            } else {
                                content += `return {};\n`;
                            }
                            break;
                    }
                } else {
                    if (useModuleExports)
                        content += `return ${bundler.globalVarName}.${refined.id.varName}.exports=${bundler.globalVarName}_m.exports;\n`;
                    else content += `return exports;\n`;
                    content += `},\n`;
                }

                // declaration
                let decltext = "";
                if (declaration !== null) {
                    const stripper = new LineStripper(declaration);
                    stripper.strip((line) => line.startsWith("#"));

                    decltext = `// ${this.rpath}\n`;
                    if (exportEquals) {
                        decltext += `namespace ${refined.id.varName}_module {\n`;
                    } else {
                        decltext += `export namespace ${refined.id.varName} {\n`;
                    }
                    decltext += stripper.strippedComments;
                    decltext += declaration.substring(stripper.index);
                    decltext += "\n}\n";
                    if (exportEquals) {
                        decltext += `export import ${refined.id.varName} = ${refined.id.varName}_module._exported\n`;
                    }
                } else if (this.needDeclaration) {
                    const errormsg = `'${this.mpath}.d.ts' is not emitted`;
                    this.error(null, IfTsbError.ModuleNotFound, errormsg);
                    refined.errored = true;
                    decltext = `// ${this.rpath}\n`;
                    decltext += `export namespace ${refined.id.varName} {\n`;
                    decltext += `// ${errormsg}\n`;
                    decltext += `}\n`;
                }
                if (moduleDeclaration !== "") {
                    decltext += moduleDeclaration;
                    decltext += "\n";
                }
                if (decltext !== "") {
                    refined.declaration = Buffer.from(decltext);
                }
                if (globalDeclaration !== "") {
                    refined.globalDeclaration = Buffer.from(globalDeclaration);
                }
                // sourcemap
                refined.sourceMapText = sourceMapText;
            }
        }

        refined.outputLineCount = count(content, "\n");
        refined.content = Buffer.from(content);
        refined.size = content.length + 2048;
        refined.save(bundler);
        return refined;
    }

    private _checkExternalChanges(refined: RefinedModule): boolean {
        for (const imp of refined.imports) {
            if (imp.externalMode !== ExternalMode.NoExternal) continue;
            for (const glob of this.bundler.externals) {
                if (glob.test(imp.mpath)) return true;
            }
        }
        return false;
    }

    async refine(): Promise<RefinedModule | null> {
        let { refined, sourceMtime, dtsMtime } = await RefinedModule.getRefined(
            this.bundler,
            this.id,
        );
        if (
            refined === null ||
            refined.errored ||
            (this.needDeclaration && refined.declaration === null) ||
            !refined.checkRelativePath(this.rpath) ||
            this._checkExternalChanges(refined)
        ) {
            if (refined !== null) memcache.expire(refined);
            const startTime = Date.now();
            const tooLongTimer = setInterval(() => {
                this.bundler.main.reportMessage(
                    IfTsbError.TooSlow,
                    `${Date.now() - startTime}ms for compiling ${
                        this.id.apath
                    }`,
                    true,
                );
            }, 5000);
            try {
                refined = this._refine(sourceMtime, dtsMtime);
            } finally {
                clearInterval(tooLongTimer);
            }
            if (refined === null) return null;
            memoryCache.register(refined.id.number, refined);
        }
        for (const imp of refined.imports) {
            const mode = imp.externalMode;
            if (mode !== ExternalMode.Preimport) {
                continue;
            }
            const id = this.bundler.getModuleId(imp.apath, mode);
            if (imp.declaration) {
                this.bundler.dtsPreloadModules.add(id);
            } else {
                this.bundler.jsPreloadModules.add(id);
            }
        }
        return refined;
    }
}

export class BundlerModuleId {
    public readonly kind: ScriptKind;
    public isAppended = false;
    constructor(
        public readonly number: number,
        public readonly varName: string,
        public readonly apath: string,
    ) {
        if (apath.startsWith(".")) debugger;
        this.kind = getScriptKind(apath);
    }
}

class RefineHelper {
    public readonly stacks: ts.Node[] = [];

    constructor(
        public readonly bundler: Bundler,
        public readonly module: BundlerModule,
        public readonly refined: RefinedModule,
        public readonly sourceFile: ts.SourceFile,
    ) {}

    error(err: IfTsbErrorMessage) {
        if (err.message !== null) {
            this.refined.errored = true;
            this.module.error(this.getErrorPosition(), err.code, err.message);
        }
    }

    getParentNode(): ts.Node | undefined {
        return this.stacks[this.stacks.length - 1];
    }
    getErrorPosition(): ErrorPosition | null {
        for (let i = this.stacks.length - 1; i >= 0; i--) {
            let node = this.stacks[i];
            const ori = (node as any).original;
            if (ori) node = ori;
            if (node.pos === -1) continue;
            return ErrorPosition.fromNode(node);
        }
        return null;
    }
    addExternalList(
        name: string,
        mode: ExternalMode,
        codepos: ErrorPosition | null,
        declaration: boolean,
    ): BundlerModuleId {
        if (name.startsWith(".")) debugger;
        const childModule = this.bundler.getModuleId(name, mode);
        this.refined.imports.push(
            new ImportInfo(name, mode, name, codepos, declaration),
        );
        return childModule;
    }
    addToImportList(
        mpath: string,
        apath: string,
        codepos: ErrorPosition | null,
        declaration: boolean,
    ): BundlerModule {
        if (apath.startsWith(".")) debugger;
        const childModule = this.bundler.getModule(apath, mpath);
        this.refined.imports.push(
            new ImportInfo(
                childModule.id.apath,
                ExternalMode.NoExternal,
                mpath,
                codepos,
                declaration,
            ),
        );
        return childModule;
    }
    makeImportModulePath(mpath: string): ParsedImportPath {
        const module = this.module;
        const baseMPath = module.mpath;
        const baseAPath = module.id.apath;
        const importPath = mpath;

        let out: string;
        const parsedAPath = path.parse(baseAPath);
        if (!baseMPath.endsWith("/index") && parsedAPath.name === "index") {
            out = joinModulePath(baseMPath, importPath);
        } else {
            const dirmodule = dirnameModulePath(baseMPath);
            out = joinModulePath(dirmodule, importPath);
        }
        return new ParsedImportPath(this, importPath, out);
    }
    getStringLiteral(stringLiteralNode: ts.Node) {
        if (ts.isLiteralTypeNode(stringLiteralNode)) {
            stringLiteralNode = stringLiteralNode.literal;
        }
        if (stringLiteralNode.kind !== ts.SyntaxKind.StringLiteral) {
            if (this.bundler.suppressDynamicImportErrors) {
                throw new IfTsbErrorMessage(IfTsbError.Unsupported, null);
            } else {
                throw new IfTsbErrorMessage(
                    IfTsbError.Unsupported,
                    `if-tsb does not support dynamic import for local module, (${
                        ts.SyntaxKind[stringLiteralNode.kind]
                    } is not string literal)`,
                );
            }
        }
        return stringLiteralNode as ts.StringLiteral;
    }
    parseImportPath(stringLiteralNode: ts.Node): ParsedImportPath {
        return this.makeImportModulePath(
            this.getStringLiteral(stringLiteralNode).text,
        );
    }
    callRequire(
        factory: ts.NodeFactory,
        literal: ts.StringLiteral,
    ): ts.Expression {
        return factory.createCallExpression(
            factory.createIdentifier("require"),
            undefined,
            [literal],
        );
    }
    visitChildren<T extends ts.Node>(
        node: T,
        visitor: ts.Visitor,
        ctx: ts.TransformationContext,
    ): T {
        this.stacks.push(node);
        try {
            return ts.visitEachChild(node, visitor, ctx);
        } finally {
            this.stacks.pop();
        }
    }
    throwImportError(importName: string): never {
        if (this.bundler.suppressModuleNotFoundErrors) {
            throw new IfTsbErrorMessage(IfTsbError.ModuleNotFound, null);
        } else {
            throw new IfTsbErrorMessage(
                IfTsbError.ModuleNotFound,
                `Cannot find module '${importName}' or its corresponding type declarations.`,
            );
        }
    }
}

const PREIMPORT = "#pre";
type PREIMPORT = "#pre";

/**
 * using for if-tsb/reflect
 */
const NOIMPORT = "#noimp";
type NOIMPORT = "#noimp";

const GLOBAL = "#global";
type GLOBAL = "#global";

interface ImportResult<T> {
    node: T;
    module: BundlerModule | null;
    moduleId: BundlerModuleId;
    importPath: ParsedImportPath;
}

class MakeTool {
    public readonly refined: RefinedModule;
    public readonly bundler: Bundler;
    public readonly module: BundlerModule;
    public readonly factory: ts.NodeFactory;
    public readonly globalVar: ts.Identifier;

    constructor(
        public readonly ctx: ts.TransformationContext,
        public readonly helper: RefineHelper,
        public readonly sourceFile: ts.SourceFile,
        public readonly delcaration: boolean,
    ) {
        this.bundler = helper.bundler;
        this.module = helper.module;
        this.refined = helper.refined;
        this.factory = ctx.factory;
        this.globalVar = this.factory.createIdentifier(
            this.bundler.globalVarName,
        );
    }

    /**
     * @return null if not found with errors
     */
    getImportPath(importPath: ParsedImportPath): string {
        const oldsys = this.bundler.sys;
        const sys: ts.System = Object.setPrototypeOf(
            {
                fileExists(path: string): boolean {
                    if (getScriptKind(path).kind === ts.ScriptKind.External)
                        return false;
                    return oldsys.fileExists(path);
                },
            },
            oldsys,
        );

        let module = ts.nodeModuleNameResolver(
            importPath.importName,
            this.module.id.apath,
            this.bundler.tsoptions,
            sys,
            this.bundler.moduleResolutionCache,
        );
        if (!module.resolvedModule == null && importPath.importName === ".")
            module = ts.nodeModuleNameResolver(
                "./index",
                this.module.id.apath,
                this.bundler.tsoptions,
                sys,
                this.bundler.moduleResolutionCache,
            );
        const info = module.resolvedModule;
        if (info === undefined) {
            if (!importPath.importName.startsWith(".")) {
                return importPath.mpath;
            }
            this.helper.throwImportError(importPath.importName);
        }

        let childmoduleApath = path.isAbsolute(info.resolvedFileName)
            ? path.join(info.resolvedFileName)
            : path.join(this.bundler.basedir, info.resolvedFileName);
        const kind = getScriptKind(childmoduleApath);
        if (kind.kind === ts.ScriptKind.External) {
            childmoduleApath = kind.modulePath + ".js";
            if (!cachedStat.existsSync(childmoduleApath)) {
                this.helper.throwImportError(importPath.importName);
            }
        }
        return childmoduleApath;
    }

    resolveImport(
        importPath: ParsedImportPath,
    ): string | PREIMPORT | NOIMPORT | null {
        for (const glob of this.bundler.externals) {
            if (glob.test(importPath.mpath)) return null;
        }
        if (this.bundler.preimportTargets.has(importPath.mpath)) {
            return PREIMPORT;
        }

        const oldsys = this.bundler.sys;
        const sys: ts.System = Object.setPrototypeOf(
            {
                fileExists(path: string): boolean {
                    if (getScriptKind(path).kind === ts.ScriptKind.External) {
                        if (path.endsWith("/if-tsb/reflect.d.ts")) {
                            throw NOIMPORT;
                        }
                        return false;
                    }
                    return oldsys.fileExists(path);
                },
            },
            oldsys,
        );
        const helper = new ImportHelper(
            sys,
            this.bundler.tsoptions,
            this.bundler.moduleResolutionCache,
        );
        try {
            const res = helper.resolve(
                this.module.id.apath,
                importPath.importName,
            );
            if (res.isBuiltIn) {
                return this.bundler.browser ? null : PREIMPORT;
            }
            if (res.isExternal) {
                if (!this.bundler.isBundlable(importPath.mpath)) return null;
                if (res.fileNotFound) {
                    this.helper.throwImportError(importPath.importName);
                }
            }
            return res.fileName;
        } catch (err) {
            if (err !== NOIMPORT) {
                throw err;
            }
            return NOIMPORT;
        }
    }

    createIdentifierChain(
        names: (string | ts.MemberName | ts.Expression)[],
    ): ts.Expression {
        if (names.length === 0) throw Error("empty array");
        const first = names[0];
        let node: ts.Expression =
            typeof first === "string"
                ? this.factory.createIdentifier(first)
                : first;
        for (let i = 1; i < names.length; i++) {
            const name = names[i];
            if (typeof name !== "string" && !ts.isMemberName(name))
                throw Error(`Unexpected kind ${name.kind}`);
            node = this.factory.createPropertyAccessExpression(node, name);
        }
        return node;
    }

    createQualifiedChain(base: ts.EntityName, names: string[]): ts.EntityName {
        let chain: ts.EntityName = base;
        for (const name of names) {
            chain = this.factory.createQualifiedName(chain, name);
        }
        return chain;
    }

    castToIdentifier(qualifier: ts.EntityName): ts.Expression {
        if (ts.isQualifiedName(qualifier)) {
            return this.factory.createPropertyAccessExpression(
                this.castToIdentifier(qualifier.left),
                qualifier.right,
            );
        }
        return qualifier;
    }

    analyizeDeclPath(
        oriNode: ts.Node,
        declNode: ts.Declaration,
        outerModulePath: ParsedImportPath | null,
    ): ts.Node {
        let outerModuleAPath: string | null = null;
        if (outerModulePath !== null) {
            if (!outerModulePath.isExternalModule()) {
                outerModuleAPath = outerModulePath.getAbsolutePath();
                if (outerModuleAPath !== null) {
                    outerModuleAPath = outerModuleAPath.replace(/\\/g, "/");
                }
            }
        }
        const moduleAPath = this.module.id.apath.replace(/\\/g, "/");
        const get = (node: ts.Node): ts.EntityName | ReturnDirect => {
            let name: string | null;
            if (tshelper.isModuleDeclaration(node)) {
                const imported = new DeclNameImporter(
                    this,
                    this.globalVar,
                ).importFromModuleDecl(node);
                if (imported === null) {
                    throw new IfTsbErrorMessage(
                        IfTsbError.Unsupported,
                        `Unresolved module ${node.name.text}`,
                    );
                } else if (imported === GLOBAL) {
                    return new ReturnDirect(oriNode);
                } else if (
                    outerModulePath !== null &&
                    imported.importPath.mpath === outerModulePath.mpath
                ) {
                    // using itself
                    return new ReturnDirect(oriNode);
                } else {
                    return imported.node;
                }
            } else if (ts.isSourceFile(node)) {
                if (node.fileName === outerModuleAPath) {
                    // using itself
                    return new ReturnDirect(oriNode);
                }
                if (node.fileName === moduleAPath) {
                    return this.factory.createQualifiedName(
                        this.globalVar,
                        this.module.id.varName,
                    );
                }
                if (!tshelper.isExportingModule(node)) {
                    // global expected
                    return new ReturnDirect(oriNode);
                } else {
                    throw new IfTsbErrorMessage(
                        IfTsbError.Unsupported,
                        `Unexpected source file ${node.fileName}`,
                    );
                }
            } else if (
                ts.isModuleBlock(node) ||
                ts.isVariableDeclarationList(node) ||
                ts.isVariableStatement(node)
            ) {
                return get(node.parent);
            } else {
                name = tshelper.getNodeName(node);
            }
            if (name !== null) {
                const res = get(node.parent);
                if (res instanceof ReturnDirect) {
                    return res;
                }
                if (!tshelper.isExporting(node)) {
                    if (ts.isTypeAliasDeclaration(node)) {
                        if (
                            node.getSourceFile().fileName ===
                            this.sourceFile.fileName
                        ) {
                            return new ReturnDirect(node.type);
                        }
                        const type = node.type;
                        if (ts.isIdentifier(type))
                            return new ReturnDirect(type);
                    }
                    throw new IfTsbErrorMessage(
                        IfTsbError.Unsupported,
                        `Need to export ${tshelper.getNodeName(node)}`,
                    );
                }
                if (res === null) {
                    return this.factory.createIdentifier(name);
                } else {
                    return this.factory.createQualifiedName(res, name);
                }
            } else {
                throw new IfTsbErrorMessage(
                    IfTsbError.Unsupported,
                    `Unexpected node kind ${ts.SyntaxKind[node.kind]}`,
                );
            }
        };
        const res = get(declNode);
        if (res instanceof ReturnDirect) {
            return res.node;
        } else {
            return res;
        }
    }
    joinEntityNames(...names: (ts.EntityName | undefined)[]): ts.EntityName {
        let res: ts.EntityName | undefined;
        const append = (node: ts.EntityName | undefined): void => {
            if (node === undefined) return;
            if (res === undefined) {
                res = node;
            } else if (node.kind === ts.SyntaxKind.QualifiedName) {
                append((node as ts.QualifiedName).left);
                res = this.factory.createQualifiedName(
                    res,
                    (node as ts.QualifiedName).right,
                );
            } else {
                res = this.factory.createQualifiedName(res, node);
            }
        };
        for (const node of names) {
            append(node);
        }
        if (res === undefined) throw TypeError("Invalid argument");
        return res;
    }
}

abstract class Importer<T> {
    public readonly bundler: Bundler;
    public readonly factory: ts.NodeFactory;
    public readonly helper: RefineHelper;
    public readonly delcaration: boolean;
    public readonly sourceFileDirAPath: string;

    constructor(
        public readonly tool: MakeTool,
        public readonly globalVar: T,
    ) {
        this.bundler = tool.bundler;
        this.factory = tool.factory;
        this.helper = tool.helper;
        this.delcaration = tool.delcaration;
        this.sourceFileDirAPath = path.dirname(tool.sourceFile.fileName);
    }

    abstract makeIdentifier(name: string): T;
    abstract makePropertyAccess(left: T, right: string): T;

    preimport(importPath: ParsedImportPath): ImportResult<T> {
        const module = this.helper.addExternalList(
            importPath.mpath,
            ExternalMode.Preimport,
            this.helper.getErrorPosition(),
            this.delcaration,
        );
        let node: T;
        if (this.delcaration)
            node = this.makeIdentifier(
                `${this.bundler.globalVarName}_${module.varName}`,
            );
        else node = this.makePropertyAccess(this.globalVar, module.varName);
        return {
            node,
            module: null,
            moduleId: module,
            importPath,
        };
    }

    protected importNode_(
        importPath: ParsedImportPath,
    ): ImportResult<T> | NOIMPORT | null {
        const resolved = this.tool.resolveImport(importPath);
        if (resolved === null) return null;
        if (resolved === NOIMPORT) return NOIMPORT;
        if (resolved === PREIMPORT) {
            return this.preimport(importPath);
        }

        const childModule = this.helper.addToImportList(
            importPath.mpath.startsWith(".")
                ? importPath.getAbsolutePath()
                : importPath.mpath,
            resolved,
            this.helper.getErrorPosition(),
            this.delcaration,
        );
        return {
            node: this.importLocal(childModule),
            module: childModule,
            moduleId: childModule.id,
            importPath,
        };
    }

    importFromModuleDecl(
        node: ts.ModuleDeclaration,
    ): ImportResult<T> | GLOBAL | null {
        if (!tshelper.hasModifier(node, ts.SyntaxKind.DeclareKeyword))
            return null;
        if ((node.flags & ts.NodeFlags.Namespace) !== 0) return null;
        if ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) {
            return GLOBAL;
        } else {
            const importPath = this.helper.parseImportPath(node.name);
            const res = this.importNode_(importPath);
            if (res === NOIMPORT) return null;
            if (res === null) return null;
            return res;
        }
    }

    importLocal(childModule: BundlerModule): T {
        return this.makePropertyAccess(this.globalVar, childModule.id.varName);
    }
}

class JsImporter extends Importer<ts.Expression> {
    makeIdentifier(name: string): ts.Expression {
        return this.factory.createIdentifier(name);
    }
    makePropertyAccess(left: ts.Expression, right: string): ts.Expression {
        return this.factory.createPropertyAccessExpression(left, right);
    }
    importLocal(childModule: BundlerModule): ts.Expression {
        const moduleVar = this.makePropertyAccess(
            this.globalVar,
            childModule.id.varName,
        );
        if (childModule.isEntry) return moduleVar;
        if (childModule.id.apath.startsWith(RAW_PROTOCOL)) {
            return moduleVar;
        } else {
            return this.factory.createCallExpression(moduleVar, [], []);
        }
    }
    importNode(importPath: ParsedImportPath): ts.Expression | NOIMPORT {
        const importName = this.importNode_(importPath);
        if (importName === null) return importPath.call(this.factory);
        if (importName === NOIMPORT) return importName;
        return importName.node;
    }
    resolvePath(rpath: string) {
        if (path.isAbsolute(rpath)) return path.resolve(rpath);
        return path.resolve(this.sourceFileDirAPath, rpath);
    }
    importRaw(mpath: string): ts.Expression | NOIMPORT {
        const apath = this.resolvePath(mpath);
        const childModule = this.helper.addToImportList(
            mpath,
            RAW_PROTOCOL + apath,
            this.helper.getErrorPosition(),
            this.delcaration,
        );
        return this.importLocal(childModule);
    }
}

abstract class DeclImporter<T> extends Importer<T> {
    importNode(importPath: ParsedImportPath): T | NOIMPORT {
        const importName = this.importNode_(importPath);
        if (importName === null) return this.preimport(importPath).node;
        if (importName === NOIMPORT) return importName;
        return importName.node;
    }
}

class DeclNameImporter extends DeclImporter<ts.EntityName> {
    makeIdentifier(name: string): ts.EntityName {
        return this.factory.createIdentifier(name);
    }
    makePropertyAccess(left: ts.EntityName, right: string): ts.EntityName {
        return this.factory.createQualifiedName(left, right);
    }
}

class DeclStringImporter extends DeclImporter<string[]> {
    makeIdentifier(name: string): string[] {
        return [name];
    }
    makePropertyAccess(left: string[], right: string): string[] {
        return [...left, right];
    }
}

class TemplateParams {
    private parameterNumber = 0;
    constructor(
        public readonly makeTool: MakeTool,
        public readonly helper: RefineHelper,
        public readonly funcName: string,
        public readonly types: ts.Type[],
    ) {}

    readImportPath() {
        const mpath = this.helper.makeImportModulePath(this.readString());
        return this.makeTool.getImportPath(mpath);
    }

    readString() {
        this.parameterNumber++;
        const param = this.types.shift();
        if (param !== undefined && param.isStringLiteral()) return param.value;
        throw new IfTsbErrorMessage(
            IfTsbError.WrongUsage,
            `${this.funcName} need a string literal at ${this.parameterNumber} parameter`,
        );
    }
    static create(
        makeTool: MakeTool,
        helper: RefineHelper,
        funcName: string,
        typeChecker: ts.TypeChecker,
        node: {
            readonly typeArguments?: ts.NodeArray<ts.TypeNode>;
        },
    ) {
        if (node.typeArguments === undefined) return null;
        return new TemplateParams(
            makeTool,
            helper,
            funcName,
            node.typeArguments.map((v) => typeChecker.getTypeFromTypeNode(v)),
        );
    }
}

class IfTsbErrorMessage {
    constructor(
        public readonly code: IfTsbError,
        public readonly message: string | null,
    ) {}
}

class ReturnDirect {
    constructor(public readonly node: ts.Node) {}
}
