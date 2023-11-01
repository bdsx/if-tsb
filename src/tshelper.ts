import * as colors from "colors";
import * as ts from "typescript";
import { cachedStat } from "./util/cachedstat";
import { getFirstParent } from "./util/util";
import path = require("path");
const isExportingModuleMap = new WeakMap<ts.SourceFile, boolean>();

const builtin = new Set<string>([
    "assert",
    "buffer",
    "child_process",
    "cluster",
    "crypto",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "https",
    "net",
    "os",
    "path",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "dgram",
    "url",
    "util",
    "v8",
    "vm",
    "zlib",
    "tls",
]);

export namespace tshelper {
    export interface TsConfigJson {
        exclude?: string[];
        include?: string[];
        compilerOptions?: ts.CompilerOptions;
    }
    export interface PhaseListener {
        onStart?(): void;
        onFinish?(): void;
    }

    export const defaultFormatHost: ts.FormatDiagnosticsHost = {
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        getCanonicalFileName: (fileName) => fileName,
        getNewLine: () => ts.sys.newLine,
    };

    export enum ErrorCode {
        ModuleNotFound = 2307,
    }

    export const defaultCompilerOptions = ts.getDefaultCompilerOptions();

    export function isBuiltInModule(mpath: string): boolean {
        return builtin.has(getFirstParent(mpath));
    }
    export function isExporting(node: ts.Node): boolean {
        if (ts.isVariableDeclaration(node)) {
            return isExporting(node.parent.parent);
        }
        if (node.parent.kind === ts.SyntaxKind.ExportSpecifier) return true;
        if (node.modifiers != null) {
            for (const mod of node.modifiers) {
                if (mod.kind === ts.SyntaxKind.ExportKeyword) return true;
            }
        }
        return false;
    }
    export function isRootIdentifier(node: ts.EntityName): boolean {
        const parent = node.parent;
        switch (parent.kind) {
            case ts.SyntaxKind.PropertyAccessExpression:
                if ((parent as ts.QualifiedName).left !== node) return false;
                return isRootIdentifier(parent as ts.QualifiedName);
            case ts.SyntaxKind.QualifiedName:
                if ((parent as ts.QualifiedName).left !== node) return false;
                return isRootIdentifier(parent as ts.QualifiedName);
            default:
                return true;
        }
    }
    export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
        if (node.modifiers == null) return false;
        for (const mod of node.modifiers) {
            if (mod.kind === kind) return true;
        }
        return false;
    }
    export function nameEquals(node: ts.MemberName, name: string): boolean {
        if (node.kind !== ts.SyntaxKind.Identifier) return false;
        return (node as ts.Identifier).text === name;
    }
    export function isExportingModule(sourceFile: ts.SourceFile): boolean {
        // sourceFile.externalModuleIndicator
        // typeChecker.getSymbolAtLocation(sourceFile) !== undefined;
        const res = isExportingModuleMap.get(sourceFile);
        if (res != null) return res;
        for (const st of sourceFile.statements) {
            if (isExporting(st)) {
                isExportingModuleMap.set(sourceFile, true);
                return true;
            }
        }
        isExportingModuleMap.set(sourceFile, false);
        return false;
    }
    export function isModuleDeclaration(
        node: ts.Node
    ): node is ts.ModuleDeclaration {
        if (!ts.isModuleDeclaration(node)) return false;
        return (node.flags & ts.NodeFlags.Namespace) === 0;
    }
    export function isNamespace(node: ts.Node): node is ts.ModuleDeclaration {
        if (!ts.isModuleDeclaration(node)) return false;
        return (node.flags & ts.NodeFlags.Namespace) !== 0;
    }
    export function getNodeName(node: ts.Node): string | null {
        if (ts.isClassDeclaration(node)) {
            if (node.name == null) {
                // export default
                return "default";
            } else {
                return node.name.text;
            }
        } else if (
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            tshelper.isNamespace(node) ||
            ts.isEnumDeclaration(node)
        ) {
            return node.name.text;
        } else if (ts.isVariableDeclaration(node)) {
            if (ts.isIdentifier(node.name)) {
                return node.name.text;
            }
            throw Error(
                `Unexpected name kind ${ts.SyntaxKind[node.name.kind]}`
            );
        } else {
            return null;
        }
    }
    export function getNodeKindName(node: ts.Node): string {
        if (node.kind === ts.SyntaxKind.FirstStatement) {
            return "VariableStatement";
        } else if (node.kind === ts.SyntaxKind.LastStatement) {
            return "DebuggerStatement";
        } else if (node.kind === ts.SyntaxKind.FirstAssignment) {
            return "EqualsToken";
        } else if (node.kind === ts.SyntaxKind.LastAssignment) {
            return "CaretEqualsToken";
        }
        {
            return ts.SyntaxKind[node.kind];
        }
    }
    export function dump(node: ts.Node, sourceFile?: ts.SourceFile): void {
        function dumpNode(
            node: ts.Node,
            indent: string,
            line: string,
            branch: string
        ): void {
            const name = getNodeKindName(node);
            console.log(`${indent}${branch}[ ${name} (${node.kind}) ]`);
            indent += line;
            const children = node.getChildren(sourceFile);
            const last = children.pop();
            if (last !== undefined) {
                for (const child of children) {
                    dumpNode(child, indent, "│", "├");
                }
                dumpNode(last, indent, " ", "└");
            }
        }

        dumpNode(node, "", "", "");
    }
    /**
     * mimic TS errors
     */
    export function report(
        source: string,
        line: number,
        column: number,
        code: number,
        message: string,
        lineText: string,
        width: number
    ): void {
        const linestr = line + "";
        console.log(
            `${colors.cyan(source)}:${colors.yellow(linestr)}:${colors.yellow(
                column + ""
            )} - ${colors.red("error")} ${colors.gray(
                "TS" + code + ":"
            )} ${message}`
        );
        console.log();

        if (line !== 0) {
            console.log(colors.black(colors.bgWhite(linestr)) + " " + lineText);
            console.log(
                colors.bgWhite(" ".repeat(linestr.length)) +
                    " ".repeat(column + 1) +
                    colors.red("~".repeat(width))
            );
            console.log();
        }
    }

    /**
     * mimic TS errors
     */
    export function reportMessage(
        code: number,
        message: string,
        noError?: boolean
    ): void {
        console.log(
            `${
                noError ? colors.gray("message") : colors.red("error")
            } ${colors.gray(`TS${code}:`)} ${message}`
        );
    }

    /**
     * mimic TS errors
     */
    export function reportError(err: any): void {
        if (typeof err !== "object" || err === null || err.message == null) {
            console.error(`Exception: (value=${err})`);
        } else if (err.code === "ENOENT") {
            reportMessage(ErrorCode.ModuleNotFound, err.message);
        } else {
            console.error(err);
        }
    }

    export function createSystem(basedir: string): ts.System {
        return Object.setPrototypeOf(
            {
                getCurrentDirectory(): string {
                    return basedir;
                },
                directoryExists(filepath: string): boolean {
                    try {
                        return cachedStat
                            .sync(this.resolvePath(filepath))
                            .isDirectory();
                    } catch (err) {
                        return false;
                    }
                },
                fileExists(filepath: string): boolean {
                    return cachedStat.existsSync(this.resolvePath(filepath));
                },
                resolvePath(filepath: string) {
                    return path.isAbsolute(filepath)
                        ? path.join(filepath)
                        : path.join(basedir, filepath);
                },
            },
            ts.sys
        );
    }

    export function printDiagnostrics(
        diagnostics: readonly ts.Diagnostic[]
    ): void {
        if (diagnostics.length === 0) return;
        console.error(
            ts.formatDiagnosticsWithColorAndContext(
                diagnostics,
                defaultFormatHost
            )
        );
    }

    export function tsbuild(tsconfig: TsConfigJson, basedir: string): void {
        const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, basedir);
        const program = ts.createProgram(parsed.fileNames, parsed.options);
        const emitResult = program.emit();
        const allDiagnostics = ts
            .getPreEmitDiagnostics(program)
            .concat(emitResult.diagnostics);
        if (allDiagnostics.length !== 0) {
            console.error(
                ts.formatDiagnosticsWithColorAndContext(
                    allDiagnostics,
                    tshelper.defaultFormatHost
                )
            );
        }
    }

    export function tswatch(
        tsconfig: TsConfigJson,
        basedir: string,
        opts: PhaseListener = {}
    ): void {
        const parsed = ts.parseJsonConfigFileContent(
            tsconfig,
            ts.sys,
            path.resolve(basedir)
        );
        printDiagnostrics(parsed.errors);
        const host = ts.createWatchCompilerHost(
            parsed.fileNames,
            parsed.options,
            ts.sys,
            ts.createSemanticDiagnosticsBuilderProgram,
            (diagnostic) => printDiagnostrics([diagnostic]),
            (diagnostic) => {
                switch (diagnostic.code) {
                    case 6031: // start
                    case 6032: // change
                        if (opts.onStart != null) opts.onStart();
                        break;
                }
                printDiagnostrics([diagnostic]);
                if (diagnostic.code === 6194) {
                    // finish
                    if (opts.onFinish != null) opts.onFinish();
                }
            },
            parsed.projectReferences,
            parsed.watchOptions
        );
        ts.createWatchProgram(host);
    }

    export class ParsedTsConfig implements TsConfigJson {
        entry?: string;
        output?: string;
        public errorCount: number = 0;
        public basedir: string = "";
        public tsconfigPath: string | null = null;
        public compilerOptions: ts.CompilerOptions;
        public original: any;

        constructor() {}

        createModuleResolutionCache(): ts.ModuleResolutionCache {
            return createModuleResolutionCache(this.basedir);
        }
    }
    export function parseTsConfig(
        configPath: string | null,
        outputOrConfig?: string | TsConfigJson | null
    ): ParsedTsConfig {
        const options = new ParsedTsConfig();

        _optionReady: try {
            if (typeof outputOrConfig === "string") {
                options.output = outputOrConfig;
            } else if (
                outputOrConfig != null &&
                typeof outputOrConfig === "object"
            ) {
                for (const key in outputOrConfig) {
                    (options as any)[key] = (outputOrConfig as any)[key];
                }
                if (options.compilerOptions) {
                    options.basedir =
                        configPath !== null
                            ? path.resolve(configPath)
                            : process.cwd();
                    const parsed = ts.parseJsonConfigFileContent(
                        outputOrConfig,
                        ts.sys,
                        options.basedir
                    );
                    tshelper.printDiagnostrics(parsed.errors);
                    options.errorCount += parsed.errors.length;
                    options.compilerOptions = parsed.options;
                    break _optionReady;
                }
            }

            if (configPath === null) {
                options.basedir = process.cwd();
            } else {
                if (cachedStat.sync(configPath).isDirectory()) {
                    options.basedir = path.resolve(configPath);
                    configPath = null;
                } else {
                    options.basedir = path.dirname(configPath);
                }
            }

            if (configPath === null) {
                const npath = path.join(options.basedir, "tsconfig.json");
                if (cachedStat.existsSync(npath)) {
                    configPath = npath;
                } else {
                    configPath = path.join(options.basedir, "index.ts");
                    if (!cachedStat.existsSync(configPath)) {
                        return options;
                    }
                }
            } else {
                options.basedir = path.dirname(configPath);
            }

            if (configPath.endsWith(".json")) {
                const configFile = ts.readConfigFile(
                    configPath,
                    ts.sys.readFile
                );
                if (configFile.error != null) {
                    tshelper.printDiagnostrics([configFile.error]);
                    options.errorCount++;
                }

                const parsed = ts.parseJsonConfigFileContent(
                    configFile.config,
                    ts.sys,
                    options.basedir
                );
                if (parsed.errors.length !== 0) {
                    tshelper.printDiagnostrics(parsed.errors);
                    options.errorCount += parsed.errors.length;
                }
                const newOptions = configFile.config as TsConfigJson;
                for (const key in newOptions) {
                    (options as any)[key] = (newOptions as any)[key];
                }
                options.tsconfigPath = configPath;
                options.compilerOptions = parsed.options;
                options.original = configFile.config;
            } else {
                options.entry = configPath;
            }
        } catch (err) {
            reportError(err);
            return options;
        }

        const compilerOptions = options.compilerOptions;
        for (const key in defaultCompilerOptions) {
            if (compilerOptions[key] !== undefined) continue;
            compilerOptions[key] = defaultCompilerOptions[key];
        }
        return options;
    }
    export function createModuleResolutionCache(
        basedir: string
    ): ts.ModuleResolutionCache {
        return ts.createModuleResolutionCache(
            basedir,
            ts.sys.useCaseSensitiveFileNames
                ? (v) => v.toLocaleLowerCase()
                : (v) => v
        );
    }
}
