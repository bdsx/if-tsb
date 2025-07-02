import * as path from "path";
import * as ts from "typescript";
import type { Bundler } from "./bundler";
import { CacheMap } from "./memmgr";
import { registerModuleReloader, bypassRequireCall } from "./modulereloader";
import { StringFileData } from "./sourcemap/sourcefilecache";
import { tshelper } from "./tshelper";
import { ExportRule, ExternalMode, IfTsbError } from "./types";
import { CACHE_SIGNATURE, getCacheFilePath } from "./util/cachedir";
import { cachedStat } from "./util/cachedstat";
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
import { unescape } from "querystring";
import {
    IfTsbErrorMessage,
    MakeTool,
    RefineHelper,
    TransformerContext,
} from "./transformer";

export const memoryCache = new CacheMap<number, RefinedModule>();


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
            const cached = memoryCache.get(id.number);
            if (cached !== undefined) {
                const prom = new MtimeChecker();
                prom.add(id.apath);
                prom.addDecl(bundler, id.apath);
                const [srcmtime, dtsmtime] = await prom.wait();
                sourceMtime = srcmtime;
                dtsMtime = dtsmtime;
                if (cached.sourceMtime !== sourceMtime) {
                    memoryCache.delete(id.number);
                    break _error;
                }
                if (dtsMtime !== -1 && cached.dtsMtime !== dtsMtime) {
                    memoryCache.delete(id.number);
                    break _error;
                }
                if (cached.tsconfigMtime !== bundler.tsconfigMtime) {
                    memoryCache.delete(id.number);
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
                memoryCache.set(id.number, refined);
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
        const info = module.bundler.resolveModuleName(
            this.importName,
            module.id.apath,
        );
        if (info === null) {
            this.importAPath = null;
            this.helper.throwImportError(this.importName);
        }
        return (this.importAPath = info.apath);
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
        this.id = bundler.getModuleId(apath);
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
            const file = StringFileData.takeSync(stripRawProtocol(moduleAPath));
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
            const that = this;

            const moduleinfo = getScriptKind(moduleAPath);

            function getSourceFile(filepath: string): ts.SourceFile {
                const fileName = filepath.replace(/\\/g, "/");
                const data = bundler.sourceFileCache.take(fileName);
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

            const transctx = new TransformerContext(
                helper,
                sourceFile,
                mapBase,
                that,
                refined,
                bundler,
            );

            const transformer = {
                after: [transctx.jsFactory],
                afterDeclarations: [transctx.declFactory(sourceFile)],
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
                transctx.typeChecker = bundler.program.getTypeChecker();
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
                            [transctx.declFactory(dtsSourceFile)],
                            bundler.tsoptions,
                        );
                        declaration = transctx.printer.printFile(
                            res.transformed[0],
                        );
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
                const needToUnwrapModule =
                    this.isEntry && bundler.exportRule === ExportRule.Var;
                if (declaration !== null) {
                    const stripper = new LineStripper(declaration);
                    stripper.strip((line) => line.startsWith("#"));

                    decltext = `// ${this.rpath}\n`;
                    if (!needToUnwrapModule) {
                        if (transctx.exportEquals) {
                            decltext += `namespace ${refined.id.varName}_module {\n`;
                        } else {
                            decltext += `export namespace ${refined.id.varName} {\n`;
                        }
                    }
                    decltext += stripper.strippedComments;
                    decltext += declaration.substring(stripper.index);
                    decltext += "\n";
                    if (!needToUnwrapModule) {
                        decltext += "}\n";
                    }
                    if (this.isEntry) {
                    } else {
                        if (transctx.exportEquals) {
                            decltext += `export import ${refined.id.varName} = ${refined.id.varName}_module._exported\n`;
                        }
                    }
                } else if (this.needDeclaration) {
                    const errormsg = `'${this.mpath}.d.ts' is not emitted`;
                    this.error(null, IfTsbError.ModuleNotFound, errormsg);
                    refined.errored = true;
                    decltext = `// ${this.rpath}\n`;
                    if (!needToUnwrapModule) {
                        decltext += `export namespace ${refined.id.varName} {\n`;
                    }
                    decltext += `// ${errormsg}\n`;
                    if (!needToUnwrapModule) {
                        decltext += `}\n`;
                    }
                }
                if (transctx.moduleDeclaration !== "") {
                    decltext += transctx.moduleDeclaration;
                    decltext += "\n";
                }
                if (decltext !== "") {
                    refined.declaration = Buffer.from(decltext);
                }
                if (transctx.globalDeclaration !== "") {
                    refined.globalDeclaration = Buffer.from(
                        transctx.globalDeclaration,
                    );
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
            if (refined !== null) {
                memoryCache.delete(this.id.number);
            }
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
            memoryCache.set(refined.id.number, refined);
        }
        for (const imp of refined.imports) {
            const mode = imp.externalMode;
            if (mode !== ExternalMode.Preimport) {
                continue;
            }
            const id = this.bundler.getModuleId(imp.apath);
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
