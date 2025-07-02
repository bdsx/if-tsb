import ts = require("typescript");
import * as path from "path";
import { Bundler } from "./bundler";
import { propNameMap, PropNameMap } from "./util/propnamecheck";
import {
    BundlerModule,
    BundlerModuleId,
    ImportInfo,
    ParsedImportPath,
    RefinedModule,
} from "./module";
import { tshelper } from "./tshelper";
import { ExportRule, ExternalMode, IfTsbError } from "./types";
import { ErrorPosition } from "./util/errpos";
import { bypassRequireCall, registerModuleReloader } from "./modulereloader";
import { dirnameModulePath, getScriptKind, joinModulePath } from "./util/util";
import { cachedStat } from "./util/cachedstat";
import { ImportHelper } from "./util/importhelper";
import { RAW_PROTOCOL } from "./util/rawprotocol";

let moduleReloaderRegistered = false;

export class TransformerContext {
    readonly printer = ts.createPrinter();

    globalDeclaration = "";
    moduleDeclaration = "";
    typeChecker: ts.TypeChecker;
    exportEquals = false;

    constructor(
        readonly helper: RefineHelper,
        readonly sourceFile: ts.SourceFile,
        readonly mapBase: PropNameMap,
        readonly module: BundlerModule,
        readonly refined: RefinedModule,
        readonly bundler: Bundler,
    ) {}

    jsFactory = (ctx: ts.TransformationContext) => {
        return (srcfile: ts.SourceFile) => {
            const jsFactory = new TransformerJsFactoryContext(
                this,
                ctx,
                srcfile,
            );
            if (srcfile.fileName !== this.sourceFile.fileName) return srcfile;
            return ts.visitEachChild(srcfile, jsFactory.visit, ctx);
        };
    };
    declFactory = (sourceFile: ts.SourceFile) => {
        return (ctx: ts.TransformationContext) => {
            const tool = new MakeTool(ctx, this.helper, sourceFile, true);
            const importer = new DeclNameImporter(tool, tool.globalVar);
            const arrImporter = new DeclStringImporter(tool, [
                this.bundler.globalVarName,
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
                                    this.typeChecker!.getSymbolAtLocation(
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
                                        case ts.SyntaxKind.NamespaceImport: {
                                            const decl =
                                                _decl as ts.NamespaceImport;
                                            const importDecl =
                                                decl.parent.parent;
                                            const importPath =
                                                this.helper.parseImportPath(
                                                    importDecl.moduleSpecifier,
                                                );
                                            if (importPath === null) continue;
                                            const res =
                                                importer.importNode(importPath);
                                            if (res === NOIMPORT) continue;
                                            return res;
                                        }
                                        case ts.SyntaxKind.ImportSpecifier: {
                                            const decl =
                                                _decl as ts.ImportSpecifier;
                                            const importDecl =
                                                decl.parent.parent.parent;
                                            const importPath =
                                                this.helper.parseImportPath(
                                                    importDecl.moduleSpecifier,
                                                );
                                            if (importPath === null) continue;
                                            if (
                                                _node.parent.kind ===
                                                ts.SyntaxKind
                                                    .ExpressionWithTypeArguments
                                            ) {
                                                const res =
                                                    arrImporter.importNode(
                                                        importPath,
                                                    );
                                                if (res === NOIMPORT) continue;
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
                                                if (res === NOIMPORT) continue;
                                                return ctx.factory.createQualifiedName(
                                                    res,
                                                    decl.propertyName?.text ??
                                                        decl.name,
                                                );
                                            }
                                        }
                                        case ts.SyntaxKind.Parameter:
                                        case ts.SyntaxKind.TypeParameter:
                                            return _node;
                                        default: {
                                            const res = tool.analyizeDeclPath(
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
                            this.helper.error(err);
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
                            const res = importer.importFromModuleDecl(node);
                            if (res === null) break;
                            if (res === GLOBAL) {
                                // global module
                                const visited = ts.visitEachChild(
                                    node,
                                    visitAbsoluting(null),
                                    ctx,
                                );
                                this.globalDeclaration += "declare global ";
                                this.globalDeclaration +=
                                    this.printer.printNode(
                                        ts.EmitHint.Unspecified,
                                        visited.body!,
                                        sourceFile,
                                    );
                                this.globalDeclaration += "\n";
                            } else if (res.module === null) {
                                // external module
                                const visited = ts.visitEachChild(
                                    node,
                                    visitAbsoluting(res.importPath),
                                    ctx,
                                );
                                this.globalDeclaration += 'declare module "';
                                this.globalDeclaration += res.importPath.mpath;
                                this.globalDeclaration += '"';
                                this.globalDeclaration +=
                                    this.printer.printNode(
                                        ts.EmitHint.Unspecified,
                                        visited.body!,
                                        sourceFile,
                                    );
                                this.globalDeclaration += "\n";
                            } else {
                                const visited = ts.visitEachChild(
                                    node,
                                    visitAbsoluting(res.importPath),
                                    ctx,
                                );
                                const declContent = this.printer.printNode(
                                    ts.EmitHint.Unspecified,
                                    visited.body!,
                                    sourceFile,
                                );
                                if (
                                    res.module.isEntry &&
                                    this.bundler.exportRule === ExportRule.Var
                                ) {
                                    this.globalDeclaration +=
                                        "declare global {\n";
                                    this.globalDeclaration += `namespace ${this.bundler.exportVarName}`;
                                    this.globalDeclaration += declContent;
                                    this.globalDeclaration += "\n}\n";
                                } else {
                                    this.moduleDeclaration += `export namespace ${res.moduleId.varName}`;
                                    this.moduleDeclaration += declContent;
                                    this.moduleDeclaration += "\n";
                                }
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
                                this.bundler.globalVarName + "_exported";
                            const out: ts.Node[] = [];
                            const node = _node as ts.ExportAssignment;
                            let identifier: ts.Identifier | string;
                            const exports: ts.ExportSpecifier[] = [];
                            if (
                                node.expression.kind ===
                                ts.SyntaxKind.Identifier
                            ) {
                                identifier = node.expression as ts.Identifier;
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
                                this.exportEquals = true;
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
                                    ctx.factory.createNamedExports(exports),
                                ),
                            );
                            return out;
                        }
                        case ts.SyntaxKind.ImportEqualsDeclaration: {
                            const node = _node as ts.ImportEqualsDeclaration;

                            const ref = node.moduleReference;
                            if (
                                ref.kind ===
                                ts.SyntaxKind.ExternalModuleReference
                            ) {
                                const importPath = this.helper.parseImportPath(
                                    ref.expression,
                                );
                                if (importPath === null) return node;
                                const res = importer.importNode(importPath);
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
                            const importPath = this.helper.parseImportPath(
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
                            const importPath = this.helper.parseImportPath(
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
                                        if (clause.namedBindings == null) {
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
                                                        element.propertyName
                                                            ?.text ??
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
                                        this.bundler.globalVarName +
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
                                        this.helper.parseImportPath(
                                            node.arguments[0],
                                        );
                                    if (importPath === null) return node;
                                    const res = importer.importNode(importPath);
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
                            this.refined.errored = true;
                            this.module.error(
                                this.helper.getErrorPosition(),
                                err.code,
                                err.message,
                            );
                        }
                        return _node;
                    }
                    throw err;
                }
                return this.helper.visitChildren(_node, visitor, ctx);
            };

            const visit = (_node: ts.Node): ts.Node[] | ts.Node | undefined => {
                return visitWith(_node, visit);
            };

            return (srcfile: ts.SourceFile) => {
                if (srcfile.fileName !== sourceFile.fileName) return srcfile;
                return ts.visitEachChild(srcfile, visit, ctx);
            };
        };
    };
}

class TransformerJsFactoryContext {
    readonly tool: MakeTool;
    readonly importer: JsImporter;
    readonly helper: RefineHelper;
    constructor(
        readonly parent: TransformerContext,
        readonly ctx: ts.TransformationContext,
        srcfile: ts.SourceFile,
    ) {
        this.tool = new MakeTool(ctx, parent.helper, parent.sourceFile, false);
        this.importer = new JsImporter(this.tool, this.tool.globalVar);
        this.helper = parent.helper;
    }

    importCast(stringLike: ts.Node) {
        const literal = this.helper.getStringLiteral(stringLike);
        const importPath = this.helper.parseImportPath(literal);
        if (importPath === null) return null;
        const res = this.importer.importNode(importPath);
        if (res === NOIMPORT) return this.ctx.factory.createNull();
        return res;
    }

    visit = (_node: ts.Node): ts.Node | ts.Node[] | undefined => {
        try {
            const mapped = propNameMap(
                this.ctx.factory,
                _node,
                this.parent.mapBase,
            );
            if (mapped !== undefined) {
                return this.helper.visitChildren(mapped, this.visit, this.ctx);
            }
            switch (_node.kind) {
                // case ts.SyntaxKind.ExportDeclaration:
                //     break;
                case ts.SyntaxKind.ImportDeclaration:
                    // import 'module'; import { a } from 'module'; import a from 'module';
                    const node = _node as ts.ImportDeclaration;
                    const importPath = this.helper.parseImportPath(
                        node.moduleSpecifier,
                    );
                    if (importPath === null) return node;
                    const res = this.importer.importNode(importPath);
                    const importCall = this.importCast(node.moduleSpecifier);
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
                                return this.ctx.factory.createVariableDeclaration(
                                    clause.namedBindings.name,
                                    undefined,
                                    undefined,
                                    importCall,
                                );
                            case ts.SyntaxKind.NamedImports:
                                // import { a } from 'module';
                                const list: ts.BindingElement[] = [];
                                for (const element of clause.namedBindings
                                    .elements) {
                                    list.push(
                                        this.ctx.factory.createBindingElement(
                                            undefined,
                                            element.propertyName,
                                            element.name,
                                        ),
                                    );
                                }
                                return this.ctx.factory.createVariableDeclaration(
                                    this.ctx.factory.createObjectBindingPattern(
                                        list,
                                    ),
                                    undefined,
                                    undefined,
                                    importCall,
                                );
                        }
                    } else if (clause.name != null) {
                        // import a from 'module';
                        return this.ctx.factory.createElementAccessExpression(
                            importCall,
                            this.ctx.factory.createStringLiteral("default"),
                        );
                    } else {
                        throw new IfTsbErrorMessage(
                            IfTsbError.Unsupported,
                            `Unexpected import syntax`,
                        );
                    }
                case ts.SyntaxKind.ImportEqualsDeclaration: {
                    // import = require('module');
                    const node = _node as ts.ImportEqualsDeclaration;

                    const ref = node.moduleReference;
                    if (ref.kind === ts.SyntaxKind.ExternalModuleReference) {
                        const importPath = this.helper.parseImportPath(
                            ref.expression,
                        );
                        if (importPath === null) return node;
                        const res = this.importer.importNode(importPath);
                        if (res === NOIMPORT) return undefined;
                        return this.ctx.factory.createVariableDeclaration(
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
                            const importPath = this.helper.parseImportPath(
                                node.arguments[0],
                            );
                            if (importPath === null) return node;
                            const res = this.importer.importNode(importPath);
                            if (res === NOIMPORT)
                                return this.ctx.factory.createNull();
                            return res;
                        }
                        case ts.SyntaxKind.Identifier: {
                            const identifier = node.expression as ts.Identifier;
                            if (identifier.text === "require") {
                                return (
                                    this.importCast(node.arguments[0]) ?? node
                                );
                            } else {
                                const signature =
                                    this.parent.typeChecker!.getResolvedSignature(
                                        node,
                                    );
                                if (typeof signature === "undefined") break;
                                const { declaration } = signature;
                                if (declaration == null) break;
                                const fileName =
                                    declaration.getSourceFile().fileName;
                                if (!fileName.endsWith("/if-tsb/reflect.d.ts"))
                                    break;
                                if (
                                    declaration.kind ===
                                    ts.SyntaxKind.JSDocSignature
                                )
                                    break;
                                if (declaration.name == null) break;
                                if ((node as any).original != null) {
                                    node = (node as any).original;
                                }
                                const funcName = declaration.name.getText();
                                const tparams = TemplateParams.create(
                                    this.tool,
                                    this.helper,
                                    funcName,
                                    this.parent.typeChecker!,
                                    node,
                                );
                                switch (funcName) {
                                    case "reflect": {
                                        if (tparams == null) break;
                                        const importPath =
                                            tparams.readImportPath();
                                        const funcname = tparams.readString();

                                        if (!moduleReloaderRegistered) {
                                            moduleReloaderRegistered = true;
                                            registerModuleReloader(
                                                this.parent.bundler
                                                    .tsconfigOriginal
                                                    .compilerOptions,
                                            );
                                        }
                                        const reflecter = bypassRequireCall(
                                            require,
                                            importPath,
                                        );
                                        const result = reflecter[funcname](
                                            this.ctx,
                                            this.parent.typeChecker!,
                                            ...tparams.types,
                                        );

                                        return this.createNodeFromValue(result);
                                    }
                                    case "importRaw": {
                                        let mpath: string;
                                        if (tparams == null) {
                                            const first = node.arguments[0];
                                            if (first === undefined) {
                                                break;
                                            }
                                            mpath =
                                                this.helper.parseImportPath(
                                                    first,
                                                ).mpath;
                                        } else {
                                            const param = tparams.readString();
                                            mpath =
                                                this.helper.makeImportModulePath(
                                                    param,
                                                ).mpath;
                                        }
                                        const res =
                                            this.importer.importRaw(mpath);
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
                    this.parent.refined.errored = true;
                    this.parent.module.error(
                        this.helper.getErrorPosition(),
                        err.code,
                        err.message,
                    );
                }
                return _node;
            } else {
                throw err;
            }
        }
        return this.helper.visitChildren(_node, this.visit, this.ctx);
    };

    createNodeFromValue(value: unknown): ts.Expression {
        switch (typeof value) {
            case "bigint":
                return this.ctx.factory.createBigIntLiteral(
                    value < 0
                        ? {
                              negative: true,
                              base10Value: (-value).toString(),
                          }
                        : {
                              negative: false,
                              base10Value: value.toString(),
                          },
                );
            case "string":
                return this.ctx.factory.createStringLiteral(value);
            case "boolean":
                return value
                    ? this.ctx.factory.createTrue()
                    : this.ctx.factory.createFalse();
            case "number":
                return this.ctx.factory.createNumericLiteral(value);
            case "object":
                if (value === null) {
                    return this.ctx.factory.createNull();
                }
                if (typeof (value as any).kind === "number") {
                    if (ts.isExpression(value as any)) {
                        return value as any;
                    }
                }
                return this.ctx.factory.createObjectLiteralExpression(
                    Object.entries(value).map(([key, val]) =>
                        this.ctx.factory.createPropertyAssignment(
                            key,
                            this.createNodeFromValue(val),
                        ),
                    ),
                );
        }
        throw new IfTsbErrorMessage(
            IfTsbError.Unsupported,
            `Unsupported reflection type ${typeof value}`,
        );
    }
}

export class RefineHelper {
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
        const childModule = this.bundler.getModuleId(name);
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

export class MakeTool {
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

        const info = this.bundler.resolveModuleName(
            importPath.importName,
            this.module.id.apath,
            sys,
        );
        if (info === null) {
            if (!importPath.importName.startsWith(".")) {
                return importPath.mpath;
            }
            this.helper.throwImportError(importPath.importName);
        }

        let childmoduleApath = info.apath;
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
        const helper = new ImportHelper(sys, this.bundler);
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

class ReturnDirect {
    constructor(public readonly node: ts.Node) {}
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

export class IfTsbErrorMessage {
    constructor(
        public readonly code: IfTsbError,
        public readonly message: string | null,
    ) {}
}
