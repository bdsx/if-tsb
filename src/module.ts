import type { Bundler } from "./bundler";
import { CACHE_SIGNATURE, getCacheFilePath } from "./cachedir";
import { ErrorPosition } from "./errpos";
import { fsp } from "./fsp";
import { LineStripper } from "./linestripper";
import { memcache } from "./memmgr";
import { registerModuleReloader, reloadableRequire } from "./modulereloader";
import { cachedStat } from "./cachedstat";
import { namelock } from "./namelock";
import { SourceFileData } from "./sourcefilecache";
import { WriterStream as FileWriter } from './streamwriter';
import { ExportRule, ExternalMode, IfTsbError } from "./types";
import { count, getScriptKind, makeImportModulePath, ParsedImportPath, printDiagnostrics, SkipableTaskQueue, stripExt } from "./util";
import path = require('path');
import ts = require("typescript");
export const CACHE_MEMORY_DEFAULT = 1024*1024*1024;
memcache.maximum = CACHE_MEMORY_DEFAULT;
export const memoryCache = new memcache.Map<number, RefinedModule>();

const printer = ts.createPrinter();
const builtin = new Set<string>([
    'assert',
    'buffer',
    'child_process',
    'cluster',
    'crypto',
    'dns',
    'domain',
    'events',
    'fs',
    'http',
    'https',
    'net',
    'os',
    'path',
    'punycode',
    'querystring',
    'readline',
    'repl',
    'stream',
    'string_decoder',
    'dgram',
    'url',
    'util',
    'v8',
    'vm',
    'zlib',
]);
let moduleReloaderRegistered = false;

function isExporting(node:ts.Node):boolean {
    if (node.parent.kind === ts.SyntaxKind.ExportSpecifier) return true;
    if (node.modifiers != null) {
        for (const mod of node.modifiers) {
            if (mod.kind === ts.SyntaxKind.ExportKeyword) return true;
        }
    }
    return false;
}
function isRootIdentifier(node:ts.EntityName):boolean {
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
function hasModifier(node:ts.Node, kind:ts.SyntaxKind):boolean {
    if (node.modifiers == null) return false;
    for (const mod of node.modifiers) {
        if (mod.kind === kind) return true;
    }
    return false;
}
function nameEquals(node:ts.MemberName, name:string):boolean {
    if (node.kind !== ts.SyntaxKind.Identifier) return false;
    return (node as ts.Identifier).text === name;
}

export class ImportInfo {
    constructor(
        public readonly apathOrExternalMode:string,
        public readonly mpath:string,
        public readonly codepos: ErrorPosition|null,
        public readonly declaration:boolean)
    {
    }

    getExternalMode():ExternalMode {
        if (/^[0-9]$/.test(this.apathOrExternalMode)) return -+this.apathOrExternalMode;
        return ExternalMode.NoExternal;
    }

    static stringify(imports:ImportInfo[]):string {
        type SerializedInfo = [string, string, boolean, number?, number?, number?, string?];
        const out:SerializedInfo[] = [];
        for (const info of imports){
            const line:SerializedInfo = [info.apathOrExternalMode, info.mpath, info.declaration];
            if (info.codepos !== null){
                const pos = info.codepos;
                line[3] = pos.line;
                line[4] = pos.column;
                line[5] = pos.width;
                line[6] = pos.lineText;
            }
            out.push(line);
        }
        return JSON.stringify(out);
    }
    static parse(str:string):ImportInfo[] {
        const imports = JSON.parse(str);
        const out:ImportInfo[] = [];
        for (const [apath, mpath, declaration, line, column, width, lineText] of imports) {
            const codepos = line == null ? null : new ErrorPosition(line, column, width, lineText);
            out.push(new ImportInfo(apath, mpath, codepos, declaration));
        }
        return out;
    }

}

export class RefinedModule {
    firstLineComment:string|null = null;
    sourceMapOutputLineOffset:number = 0;
    outputLineCount:number;
    imports:ImportInfo[] = [];
    sourceMapText:string|null = null;
    content:string = '';
    declaration:string|null = null;
    globalDeclaration:string|null = null;
    size:number;
    errored = false;
    sourceMtime:number;
    tsconfigMtime:number;

    private mtime:number|null = null;

    constructor(public readonly id:BundlerModuleId) {
    }

    private readonly saving = new SkipableTaskQueue;

    checkRelativePath(rpath:string):boolean {
        const lineend = this.content.indexOf('\n');
        if (lineend === -1) return false;
        const matched = this.content.substr(0, lineend).match(/^\/\/ (.+)$/);
        if (matched === null) return false;
        return matched[1] === rpath;
    }

    clear():void {
        this.firstLineComment = null;
        this.imports.length = 0;
        this.sourceMapText = null;
        this.content = '';
        this.size = 0;
    }

    save(bundler:Bundler):void {
        if (this.errored) return;
        bundler.taskQueue.ref();
        this.saving.run(async()=>{
            try {
                await namelock.lock(this.id.number);
                const writer = new FileWriter(getCacheFilePath(this.id.number));
                await writer.write(this.sourceMtime+'\0');
                await writer.write(this.tsconfigMtime+'\0');
                await writer.write(ImportInfo.stringify(this.imports)+'\0');
                await writer.write(this.firstLineComment ? this.firstLineComment+'\0' : '\0');
                await writer.write(this.sourceMapOutputLineOffset+'\0');
                await writer.write(this.outputLineCount+'\0');
                await writer.write(this.sourceMapText !== null ? this.sourceMapText.replace(/[\r\n]/g, '')+'\0' : '\0');
                await writer.write(this.content+'\0');
                await writer.write(this.declaration !== null ? this.declaration+'\0' : '\0');
                await writer.write(this.globalDeclaration !== null ? this.globalDeclaration+'\0' : '\0');
                await writer.write(CACHE_SIGNATURE);
                await writer.end();
                bundler.taskQueue.unref();
            } finally {
                namelock.unlock(this.id.number);
            }
            this.mtime = Date.now();
        });
    }

    async load():Promise<boolean> {
        const cachepath = getCacheFilePath(this.id.number);
        let content:string;
        try {
            await namelock.lock(this.id.number);
            content = await fsp.readFile(cachepath);
        } finally {
            namelock.unlock(this.id.number);
        }
        if (!content.endsWith(CACHE_SIGNATURE)) return false;
        const [
            sourceMtime,
            tsconfigMtime,
            imports, 
            firstLineComment, 
            sourceMapOutputLineOffset,
            outputLineCount,
            sourceMapText,
            source,
            declaration,
            globalDeclaration,
        ] = content.split('\0');
        this.sourceMtime = +sourceMtime;
        this.tsconfigMtime = +tsconfigMtime;
        this.imports = imports === '' ? [] : ImportInfo.parse(imports);
        this.firstLineComment = firstLineComment || null;
        this.sourceMapOutputLineOffset = +sourceMapOutputLineOffset;
        this.outputLineCount = +outputLineCount;
        this.sourceMapText = sourceMapText || null;
        this.content = source;
        this.declaration = declaration || null;
        this.globalDeclaration = globalDeclaration || null;
        this.size = source.length + declaration.length + globalDeclaration.length + 2048;
        return true;
    }

    static async getRefined(id:BundlerModuleId, tsconfigMtime:number):Promise<{refined:RefinedModule|null, sourceMtime:number}> {
        let sourceMtime = -1;
        _error:try {
            const cached = memoryCache.take(id.number);
            if (cached != null) {
                sourceMtime = await cachedStat.mtime(id.apath);
                if (cached.sourceMtime !== sourceMtime) {
                    memcache.unuse(cached);
                    break _error;
                }
                if (cached.tsconfigMtime !== tsconfigMtime) {
                    memcache.unuse(cached);
                    break _error;
                }
                return {refined:cached, sourceMtime};
            } else {
                try {
                    await namelock.lock(id.number);
                    const cachepath = getCacheFilePath(id.number);
                    let cacheMtime = -1;
                    await Promise.all([
                        cachedStat.mtime(cachepath).then(mtime=>{
                            cacheMtime = mtime;
                        }, ()=>{}),
                        cachedStat.mtime(id.apath).then(mtime=>{
                            sourceMtime = mtime;
                        }, ()=>{}),
                    ]);
                    
                    if (cacheMtime === -1) break _error;
                    if (cacheMtime < tsconfigMtime) break _error;
                    if (cacheMtime < sourceMtime) break _error;
                } finally {
                    namelock.unlock(id.number);
                }
                const refined = new RefinedModule(id);
                const loaded = await refined.load();
                memoryCache.register(id.number, refined);
                if (!loaded) break _error;
                if (refined.sourceMtime !== sourceMtime) break _error;
                if (refined.tsconfigMtime !== tsconfigMtime) break _error;
                return {refined, sourceMtime};
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
        return {refined:null, sourceMtime};
    }
    
}

export enum CheckState {
    None,Entered,Checked,
}

export class BundlerModule {
    public readonly id:BundlerModuleId;
    public readonly rpath:string;
    public readonly children:BundlerModule[] = [];
    public readonly importLines:(ErrorPosition|null)[] = [];
    public isAppended = false;
    public isEntry = false;
    public checkState = CheckState.None;
    public needDeclaration = false;

    constructor(
        public readonly bundler:Bundler, 
        public readonly mpath:string,
        apath:string) {
        this.id = bundler.getModuleId(apath, ExternalMode.NoExternal);
        this.rpath = path.relative(bundler.basedir, apath);
    }

    error(pos:ErrorPosition|null, code:number, message:string):void {
        if (pos === null)
        {
            this.bundler.main.report(this.rpath, 0, 0, code, message, '', 0);
        }
        else
        {
            this.bundler.main.report(this.rpath, pos.line, pos.column, code, message, pos.lineText, pos.width);
        }
    }

    makeErrorPosition(node:ts.Node):ErrorPosition|null {
        const source = node.getSourceFile();
        if (source == null) {
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

    errorWithNode(node:ts.Node, code:number, message:string):void {
        return this.error(this.makeErrorPosition(node), code, message);
    }

    makeImportModulePath(mpath:string):ParsedImportPath {
        return makeImportModulePath(this.mpath, this.id.apath, mpath);
    }

    private async _refine(sourceMtime:number):Promise<RefinedModule|null> {
        if (sourceMtime === -1) {
            this.error(null, IfTsbError.ModuleNotFound, `Cannot find module ${this.mpath}`);
            return null;
        }

        this.children.length = 0;
        this.importLines.length = 0;

        const refined = new RefinedModule(this.id);
        refined.content = `// ${this.rpath}\n`;
        refined.sourceMtime = sourceMtime;
        refined.tsconfigMtime = this.bundler.tsconfigMtime;

        let useDirName = false;
        let useFileName = false;
        let useModule = false;
        let useModuleExports = false;
        let useExports = false;
        let exportEquals = false;
        let moduleDeclaration = '';
        let globalDeclaration = '';
        const that = this;
        const bundler = this.bundler;

        const moduleAPath = this.id.apath;
        const moduleinfo = getScriptKind(moduleAPath);
        
        const refs:SourceFileData[] = [];

        let typeChecker:ts.TypeChecker;

        function getSourceFile(filepath:string):ts.SourceFile {
            const fileName = filepath.replace(/\\/g, '/');
            let data = bundler.sourceFileCache.take(fileName);
            refs.push(data);
            if (data.isModifiedSync()) {
                memcache.unuse(data);
                data = bundler.sourceFileCache.take(fileName);
            }
            return data.sourceFile;
        }

        let sourceFile:ts.SourceFile;
        try {
            sourceFile = getSourceFile(moduleAPath);
        } catch (err) {
            that.error(null, IfTsbError.ModuleNotFound, err.message+' '+moduleAPath);
            return null;
        }
        const helper = new RefineHelper(this.bundler, this, refined, sourceFile);
        
        const jsFactory = (ctx:ts.TransformationContext)=>{
            const transformer = new JsTransformer(ctx, helper, false);

            const visit = (_node:ts.Node):ts.Node|ts.Node[]|undefined=>{
                switch (_node.kind) {
                case ts.SyntaxKind.FunctionExpression: {
                    const node = _node as ts.FunctionExpression;
                    if (node.decorators != null) {
                        for (const deco of node.decorators) {
                            console.log(deco.getText(sourceFile));
                        }
                    }
                    break;
                }
                case ts.SyntaxKind.Identifier: {
                    const node = _node as ts.Identifier;
                    const parent = helper.getParentNode();
                    let right:ts.MemberName|null = null;
                    if (parent != null && parent.kind === ts.SyntaxKind.PropertyAccessExpression) {
                        right = (parent as ts.PropertyAccessExpression).name;
                        if (right === node) break;
                    }
                    switch (node.text)
                    {
                    case '__dirname': useDirName = true; break;
                    case '__filename': useFileName = true; break;
                    case 'module':
                        useModule = true;
                        if (right !== null && nameEquals(right, 'exports')) {
                            useModuleExports = true;
                        }
                        break;
                    case 'exports': useExports = true; break;
                    } 
                    break;
                }
                case ts.SyntaxKind.ImportEqualsDeclaration: {
                    const node = _node as ts.ImportEqualsDeclaration;
                    
                    const ref = node.moduleReference;
                    if (ref.kind === ts.SyntaxKind.ExternalModuleReference) {
                        const importPath = helper.parseImportPath(ref.expression);
                        if (importPath === null) return node;
                        const res = transformer.importFromStringLiteral(importPath);
                        if (res === NOIMPORT) return undefined;
                        return ctx.factory.createVariableDeclaration(node.name, undefined, undefined, 
                            res !== null ? res.node : importPath.call(ctx.factory));
                    }
                    break;
                }
                case ts.SyntaxKind.CallExpression: {
                    let node = _node as ts.CallExpression;
                    switch (node.expression.kind) {
                    case ts.SyntaxKind.ImportKeyword: {
                        if (node.arguments.length !== 1) {
                            refined!.errored = true;
                            this.error(helper.getErrorPosition(), IfTsbError.Unsupported, `Cannot call import with multiple parameters`);
                            return node;
                        }
                        const importPath = helper.parseImportPath(node.arguments[0]);
                        if (importPath === null) return node;
                        const res = transformer.importFromStringLiteral(importPath);
                        if (res === NOIMPORT) return ctx.factory.createObjectLiteralExpression();
                        return res !== null ? res.node :importPath.call(ctx.factory);
                    }
                    case ts.SyntaxKind.Identifier: {
                        const identifier = node.expression as ts.Identifier;
                        if (identifier.escapedText === 'require') {
                            const importPath = helper.parseImportPath(node.arguments[0]);
                            if (importPath === null) return node;
                            const res = transformer.importFromStringLiteral(importPath);
                            if (res === NOIMPORT) return ctx.factory.createObjectLiteralExpression();
                            return res !== null ? res.node : importPath.call(ctx.factory);
                        } else {
                            const signature = typeChecker.getResolvedSignature(node);
                            if (typeof signature === 'undefined') break;
                            const { declaration } = signature;
                            if (declaration == null) break;
                            const fileName = declaration.getSourceFile().fileName;
                            if (!fileName.endsWith('/if-tsb/reflect.d.ts')) break;
                            if (declaration.kind === ts.SyntaxKind.JSDocSignature) break;
                            if (declaration.name == null) break;
                            if (declaration.name.getText() !== 'reflect') break;
                            if ((node as any).original != null) {
                                node = (node as any).original;
                            }
                            
                            if (node.typeArguments == null) break;
                            const params = node.typeArguments.map(v=>typeChecker.getTypeFromTypeNode(v));
                            const path = params.shift();
                            const funcname = params.shift();
                            if (path == null || !path.isStringLiteral()) break;
                            if (funcname == null || !funcname.isStringLiteral()) break;
                            const mpath = that.makeImportModulePath(path.value);
                            const importPath = transformer.getImportPath(mpath);
                            if (importPath === null) break;

                            if (!moduleReloaderRegistered) {
                                moduleReloaderRegistered = true;
                                registerModuleReloader(that.bundler.tsconfigContent.compilerOptions);
                            }
                            const reflecter = reloadableRequire(require, importPath);
                            return reflecter[funcname.value](ctx, typeChecker, ...params);
                        }
                    }}
                    break;
                }}
                helper.stacks.push(_node);
                try {
                    return ts.visitEachChild(_node, visit, ctx);
                } finally {
                    helper.stacks.pop();
                }
            };
            
            return (srcfile:ts.SourceFile)=>{
                if (srcfile.fileName !== sourceFile.fileName) return srcfile;
                return ts.visitEachChild(srcfile, visit, ctx);
            };
        };

        const declFactory = (ctx:ts.TransformationContext)=>{
            const transformer = new DeclTransformer(ctx, helper, true);

            const visitWith = (_node:ts.Node, visitor:ts.Visitor):ts.Node[]|ts.Node|undefined=>{
                switch (_node.kind) {
                case ts.SyntaxKind.ModuleDeclaration: {
                    let node = _node as ts.ModuleDeclaration;
                    if (!hasModifier(node, ts.SyntaxKind.DeclareKeyword)) break;
                    if ((node.flags & ts.NodeFlags.Namespace) !== 0) break;
                    if ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) {
                        helper.stacks.push(_node);
                        let visited:ts.Node;
                        try {
                            visited = ts.visitEachChild(node, makeVisitAbsoluting(null, null), ctx);
                        } finally {
                            helper.stacks.pop();
                        }
                        globalDeclaration += 'declare ';
                        globalDeclaration += printer.printNode(ts.EmitHint.Unspecified, visited, sourceFile);
                        globalDeclaration += '\n';
                    } else {
                        const importPath = helper.parseImportPath(node.name);
                        if (importPath === null) break;
                        const res = transformer.importFromStringLiteral(importPath);
                        if (res === NOIMPORT) break;
                        if (res.module === null) break;
                        
                        const moduleAPath = helper.getAbsolutePath(importPath);
                        let moduleSourceFile:ts.SourceFile|null = null;
                        if (moduleAPath !== null) {
                            moduleSourceFile = getSourceFile(moduleAPath);
                        }
                        helper.stacks.push(_node);
                        try {
                            const importAPath = moduleAPath !== null ? stripExt(moduleAPath).replace(/\\/g, '/') : null;
                            node = ts.visitEachChild(node, makeVisitAbsoluting(importAPath, importPath), ctx);
                        } finally {
                            helper.stacks.pop();
                        }

                        const nsnode = ctx.factory.createModuleDeclaration(undefined, 
                            [ctx.factory.createModifier(ts.SyntaxKind.ExportKeyword)], 
                            ctx.factory.createIdentifier(res!.moduleId!.varName),
                            node.body, ts.NodeFlags.Namespace);
                        moduleDeclaration += printer.printNode(ts.EmitHint.Unspecified, nsnode, sourceFile);
                        moduleDeclaration += '\n';
                    }
                    return undefined;
                }
                case ts.SyntaxKind.DeclareKeyword:
                    return undefined;
                case ts.SyntaxKind.ExportDeclaration: {
                    const node = _node as ts.ExportDeclaration;
                    const module = node.moduleSpecifier;
                    if (module != null) {
                        this.error(helper.getErrorPosition(), IfTsbError.Unsupported, `if-tsb cannot export identifiers from the module`);
                        return node;
                    }
                    break;
                }
                case ts.SyntaxKind.ExportAssignment: {
                    const exportName = bundler.globalVarName+'_exported';
                    const out:ts.Node[] = [];
                    const node = _node as ts.ExportAssignment;
                    let identifier:ts.Identifier|string;
                    const exports:ts.ExportSpecifier[] = [];
                    if (node.expression.kind === ts.SyntaxKind.Identifier) {
                        identifier = node.expression as ts.Identifier;
                        exports.push(ctx.factory.createExportSpecifier(false, identifier, exportName));
                    } else {
                        identifier = exportName;
                        out.push(ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, identifier, node.expression as ts.ModuleReference));
                        exports.push(ctx.factory.createExportSpecifier(false, undefined, identifier));
                    }

                    if (node.isExportEquals) {
                        // export = item
                        exportEquals = true;
                    } else {
                        // export defualt item
                        exports.push(ctx.factory.createExportSpecifier(false, identifier, 'default'));
                    }
                    out.push(ctx.factory.createExportDeclaration(
                        undefined,
                        undefined,
                        false,
                        ctx.factory.createNamedExports(exports)
                    ));
                    return out;
                }
                case ts.SyntaxKind.ImportEqualsDeclaration: {
                    const node = _node as ts.ImportEqualsDeclaration;
                    
                    const ref = node.moduleReference;
                    if (ref.kind === ts.SyntaxKind.ExternalModuleReference) {
                        const importPath = helper.parseImportPath(ref.expression);
                        if (importPath === null) return node;
                        const res = transformer.importFromStringLiteral(importPath);
                        if (res === NOIMPORT) return undefined;
                        return ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, node.name, res.node);
                    }
                    break;
                }
                case ts.SyntaxKind.ImportType: { // let v:import('module').Type;
                    const node = _node as ts.ImportTypeNode;
                    const importPath = helper.parseImportPath(node.argument);
                    if (importPath === null) return node;
                    const res = transformer.importFromStringLiteral(importPath);
                    if (res === NOIMPORT) return node;
                    if (res.moduleId === null) return node;
                    return transformer.joinEntityNames(res.node, node.qualifier);
                }
                case ts.SyntaxKind.ImportDeclaration: { // import 'module'; import { a } from 'module'; import a from 'module';
                    const node = _node as ts.ImportDeclaration;
                    const importPath = helper.parseImportPath(node.moduleSpecifier);
                    if (importPath === null) return node;
                    const res = transformer.importFromStringLiteral(importPath);
                    const clause = node.importClause;
                    if (clause == null) {
                        // import 'module';
                        return undefined;
                    }
                    if (res === NOIMPORT) return undefined;
                    if (clause.namedBindings != null) {
                        const out:ts.Node[] = [];
                        switch (clause.namedBindings.kind) {
                        case ts.SyntaxKind.NamespaceImport: 
                            // import * as a from 'module';
                            if (clause.namedBindings == null) {
                                this.error(helper.getErrorPosition(), IfTsbError.Unsupported, `Unexpected import syntax`);
                                return node;
                            }
                            return ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, clause.namedBindings.name, res.node);
                        case ts.SyntaxKind.NamedImports:
                            // import { a } from 'module';
                            for (const element of clause.namedBindings.elements) {
                                out.push(ctx.factory.createImportEqualsDeclaration(
                                    undefined,
                                    undefined,
                                    false,
                                    element.name,
                                    ctx.factory.createQualifiedName(res.node, element.propertyName || element.name)));
                            }
                            break;
                        }
                        return out;
                    } else if (clause.name != null) {
                        // import a from 'module';
                        return ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, clause.name, 
                            ctx.factory.createQualifiedName(res.node, bundler.globalVarName+'_exported'));
                    } else {
                        this.error(helper.getErrorPosition(), IfTsbError.Unsupported, `Unexpected import syntax`);
                        return node;
                    }
                }
                case ts.SyntaxKind.CallExpression: {
                    const node = _node as ts.CallExpression;
                    switch (node.expression.kind) {
                    case ts.SyntaxKind.ImportKeyword: { // const res = import('module');
                        if (node.arguments.length !== 1) {
                            refined!.errored = true;
                            this.error(helper.getErrorPosition(), IfTsbError.Unsupported, `Cannot call import with multiple parameters`);
                            return _node;
                        }
                        const importPath = helper.parseImportPath(node.arguments[0]);
                        if (importPath === null) return node;
                        const res = transformer.importFromStringLiteral(importPath);;
                        if (res === NOIMPORT) return ctx.factory.createObjectLiteralExpression();
                        return res.node;
                    }}
                    break;
                }
                }
                helper.stacks.push(_node);
                try {
                    return ts.visitEachChild(_node, visitor, ctx);
                } finally {
                    helper.stacks.pop();
                }
            }

            const makeVisitAbsoluting = (importAPath:string|null, importPath:ParsedImportPath|null)=>{
                const visitAbsoluting = (_node:ts.Node):ts.Node[]|ts.Node|undefined=>{
                    switch (_node.kind) {
                    case ts.SyntaxKind.Identifier: {
                        const symbol = typeChecker.getSymbolAtLocation(_node);
                        if (symbol == null) break;
                        if (symbol.declarations == null) break;
                        if (!isRootIdentifier(_node as ts.Identifier)) break;
                        for (const _decl of symbol.declarations) {
                            switch (_decl.kind) {
                            case ts.SyntaxKind.NamespaceImport: {
                                const decl = _decl as ts.NamespaceImport;
                                const importDecl = decl.parent.parent;
                                const importPath = helper.parseImportPath(importDecl.moduleSpecifier);
                                if (importPath === null) continue;
                                const res = transformer.importFromStringLiteral(importPath);
                                if (res === NOIMPORT) continue;
                                return res.node;
                            }
                            case ts.SyntaxKind.ImportSpecifier: {
                                const decl = _decl as ts.ImportSpecifier;
                                const importDecl = decl.parent.parent.parent;
                                const importPath = helper.parseImportPath(importDecl.moduleSpecifier);
                                if (importPath === null) continue;
                                const res = transformer.importFromStringLiteral(importPath);
                                if (res === NOIMPORT) continue;
                                if (decl.propertyName == null) continue;
                                return ctx.factory.createQualifiedName(res.node, decl.propertyName);
                            }
                            case ts.SyntaxKind.Parameter:
                            case ts.SyntaxKind.TypeParameter:
                                return _node;
                            default:{
                                if (_node.parent === _decl) break;
                                const fullPath = typeChecker.getFullyQualifiedName(symbol);
                                if (fullPath.startsWith('global.')) return _node;
                                if (!fullPath.startsWith('"')) {
                                    if (_decl.kind === ts.SyntaxKind.TypeAliasDeclaration) {
                                        const alias = _decl as ts.TypeAliasDeclaration;
                                        if (alias.typeParameters == null) {
                                            return visitAbsoluting(alias.type);
                                        }
                                    }
                                    if ((symbol as any).parent === undefined) return _node; // global expected
                                    this.error(helper.getErrorPosition(), IfTsbError.Unsupported, `Need to export`);
                                    return _node;
                                }
                                const endIndex = fullPath.indexOf('"', 1);
                                if (endIndex === -1) {
                                    this.error(helper.getErrorPosition(), IfTsbError.Unsupported, `Unexpected name ${fullPath}`);
                                    return _node;
                                }
                                const filePath = fullPath.substring(1, endIndex);
                                if (moduleAPath !== null && filePath === importAPath) {
                                    return _node;
                                }
                                if (importPath !== null && filePath === importPath.importName) {
                                    return _node;
                                }
                                const symbolPath = fullPath.substr(endIndex+1).split('.');
                                if (symbolPath[0] !== '') {
                                    this.error(helper.getErrorPosition(), IfTsbError.Unsupported, `Unexpected name ${fullPath}`);
                                    return _node;
                                }
                                symbolPath[0] = this.id.varName;
                                return transformer.createQualifiedChain(transformer.globalVar, symbolPath);
                            }
                            }
                        }
                        return _node;
                    }
                    }
                    return visitWith(_node, visitAbsoluting);
                };
                return visitAbsoluting;
            };

            const visit = (_node:ts.Node):ts.Node[]|ts.Node|undefined=>{
                return visitWith(_node, visit);
            };

            return (srcfile:ts.SourceFile)=>{
                if (srcfile.fileName !== sourceFile.fileName && srcfile.fileName !== dtsFilePath) return srcfile;

                return ts.visitEachChild(srcfile, visit, ctx);
            };
        };

        const transformer = { 
            after: [jsFactory],
            afterDeclarations: [declFactory],
        };

        let sourceMapText:string|null = null;
        let declaration:string|null = null as any;
        let dtsFilePath:string|null = null;
        let stricted = false;
        const allowedSources = new Set<string>();
        allowedSources.add(moduleAPath);

        if (moduleinfo.kind === ts.ScriptKind.JSON)
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
                if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                    refined.content += `${refined.id.varName}(){\n`;
                } else {
                    refined.content += `${refined.id.varName}:function(){\n`;
                }
                refined.content += `if(${bundler.globalVarName}.${refined.id.varName}.exports!=null) return ${bundler.globalVarName}.${refined.id.varName}.exports;\n`;
                refined.content += `\nreturn ${bundler.globalVarName}.${refined.id.varName}.exports=${sourceFile.text};\n},\n`;
            }
            if (this.needDeclaration) {
                refined.declaration = `// ${this.rpath}\n`;
                if (this.isEntry) {
                } else {
                    if (exportEquals) {
                        refined.declaration += `const ${refined.id.varName}_module:`;
                    } else {
                        refined.declaration += `export const ${refined.id.varName}:`;
                    }
                }
                refined.declaration += sourceFile.text;
                refined.declaration += ';\n';
                if (this.isEntry) {
                } else {
                    refined.declaration += `}\n`;
                    if (exportEquals) {
                        refined.declaration += `export const ${refined.id.varName} = ${refined.id.varName}_module;\n`;
                    }
                }
            }
        } else {
            let content = '';
            const filePathForTesting = moduleAPath.replace(/\\/g, '/');
            const superHost = bundler.compilerHost;
            const compilerHost:ts.CompilerHost = Object.setPrototypeOf({
                getSourceFile(fileName:string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void, shouldCreateNewSourceFile?: boolean) {
                    if (fileName === filePathForTesting) return sourceFile;
                    if (bundler.faster) {
                        return undefined;
                    }
                    return getSourceFile(fileName);
                },
                writeFile(name:string, text:string) {
                    if (text === '') text = ' ';
                    const info = getScriptKind(name);
                    if (info.kind === ts.ScriptKind.JS) {
                        content = text;
                    } else if (info.kind === ts.ScriptKind.External) {
                        if (that.needDeclaration) {
                            declaration = text;
                        }
                    } else if (info.ext === '.MAP') {
                        sourceMapText = text;
                    }
                },
                fileExists(fileName: string): boolean {
                    if (fileName.endsWith('.d.ts')) return superHost.fileExists(fileName);
                    return allowedSources.has(bundler.resolvePath(fileName));
                }
            }, superHost);
    
            let diagnostics:ts.Diagnostic[]|undefined = bundler.faster ? undefined : [];
            const tsoptions:ts.CompilerOptions = {
                declaration: this.needDeclaration,
                declarationDir: undefined
            };
            Object.setPrototypeOf(tsoptions, this.bundler.tsoptions);

            if (!bundler.faster) {
                for (const st of sourceFile.statements) {
                    if (st.kind === ts.SyntaxKind.ModuleDeclaration) {
                        if (!hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
                        if ((st.flags & ts.NodeFlags.Namespace) !== 0) continue;
                        if ((st.flags & ts.NodeFlags.GlobalAugmentation) !== 0) continue;
                        const moduleDecl = st as ts.ModuleDeclaration;
                        const importPath = helper.parseImportPath(moduleDecl.name);
                        if (importPath === null) continue;
                        const apath = helper.getAbsolutePath(importPath);
                        if (apath === null) continue;
                        allowedSources.add(apath);
                    }
                }
            }
            bundler.program = ts.createProgram([...allowedSources], tsoptions, compilerHost, bundler.program, diagnostics);
            typeChecker = bundler.program.getTypeChecker();
            if (bundler.verbose) console.log(`emit ${moduleAPath} ${new Date(sourceMtime).toLocaleTimeString()}`);
            const res = bundler.program.emit(sourceFile, undefined, undefined, false, transformer);
            if (!bundler.faster && res.diagnostics.length !== 0) {
                refined!.errored = true;
                printDiagnostrics(res.diagnostics);   
            }
            if (diagnostics != null) {
                diagnostics.push(...bundler.program.getSyntacticDiagnostics(sourceFile));
                if (diagnostics.length !== 0) {
                    refined!.errored = true;
                    printDiagnostrics(diagnostics);
                }
            }
            if (content === '') {
                if (diagnostics == null) {
                    printDiagnostrics(bundler.program.getSyntacticDiagnostics(sourceFile));
                }
                
                bundler.main.reportMessage(IfTsbError.Unsupported, `Failed to parse ${moduleAPath}`);
                return null;
            }

            if (this.needDeclaration && moduleinfo.kind === ts.ScriptKind.JS) {
                const dtsPath = moduleAPath.substr(0, moduleAPath.length - moduleinfo.ext.length)+'.d.ts';
                try {
                    const dtsSourceFile = getSourceFile(dtsPath);
                    dtsFilePath = dtsSourceFile.fileName;
                    const res = ts.transform(dtsSourceFile, transformer.afterDeclarations, bundler.tsoptions);
                    declaration = printer.printFile(res.transformed[0]);
                } catch (err) {
                    if (err.code !== 'ENOENT') throw err;
                }
            }

            // content
            const stripper = new LineStripper(content);
            refined.firstLineComment = stripper.strip(line=>line.startsWith('#'));
            stricted = (stripper.strip(line=>line==='"use strict";') !== null) || (stripper.strip(line=>line==="'use strict';") !== null);
            stripper.strip(line=>line==='Object.defineProperty(exports, "__esModule", { value: true });');
            stripper.strip(line=>line==='exports.__esModule = true;');
        
            let lastLineIdx = content.lastIndexOf('\n')+1;
            let contentEnd = content.length;
            const lastLine = content.substr(lastLineIdx);
            if (lastLine.startsWith('//# sourceMappingURL=')) {
                lastLineIdx -= 2;
                if (content.charAt(lastLineIdx) !== '\r') lastLineIdx++;
                contentEnd = lastLineIdx;
            }
            if (this.isEntry) {
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
            } else {
                const useStrict = !bundler.useStrict && stricted;
    
                if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                    refined.content += `${refined.id.varName}(){\n`;
                } else {
                    refined.content += `${refined.id.varName}:function(){\n`;
                }
                if (useStrict) refined.content += '"use strict";\n';
                
                refined.content += `if(${bundler.globalVarName}.${refined.id.varName}.exports!=null) return ${bundler.globalVarName}.${refined.id.varName}.exports;\n`;
                refined.content += `${bundler.constKeyword} exports=${bundler.globalVarName}.${refined.id.varName}.exports={};\n`;
                if (useModule) {
                    if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015) {
                        refined.content += `const module={exports};\n`;
                    } else {
                        refined.content += `var module={exports:exports};\n`;
                    }
                }
            }
    
            if (useFileName || useDirName) {
                const prefix = this.isEntry ? '' : `${bundler.constKeyword} `;
                let rpath = path.relative(path.dirname(bundler.output), this.id.apath);
                if (useFileName)
                {
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__filename=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    helper.addExternalList('path', ExternalMode.Preimport, null, false);
                    helper.addExternalList('__resolve', ExternalMode.Manual, null, false);
                    helper.addExternalList('__dirname', ExternalMode.Manual, null, false);
                }
                if (useDirName)
                {
                    rpath = path.dirname(rpath);
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__dirname=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    helper.addExternalList('path', ExternalMode.Preimport, null, false);
                    helper.addExternalList('__resolve', ExternalMode.Manual, null, false);
                    helper.addExternalList('__dirname', ExternalMode.Manual, null, false);
                }
            }
            refined.content += stripper.strippedComments;
    
            refined.sourceMapOutputLineOffset = count(refined.content, '\n') - stripper.stripedLine;
            refined.content += content.substring(stripper.index, contentEnd);
            refined.content += '\n';
            if (this.isEntry) {
                switch (bundler.exportRule) {
                case ExportRule.Var:
                    if (useExports)
                    {
                        if (useModuleExports)
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
                if (useModuleExports) refined.content += `return ${bundler.globalVarName}.${refined.id.varName}.exports=module.exports;\n`;
                else refined.content += `return exports;\n`;
                refined.content += `},\n`;
            }

            // declaration
            if (declaration !== null) {
                const stripper = new LineStripper(declaration);
                stripper.strip(line=>line.startsWith('#'));

                refined.declaration = `// ${this.rpath}\n`;
                if (exportEquals) {
                    refined.declaration += `namespace ${refined.id.varName}_module {\n`;
                } else {
                    refined.declaration += `export namespace ${refined.id.varName} {\n`;
                }
                refined.content += stripper.strippedComments;
                refined.declaration += declaration.substring(stripper.index);
                refined.declaration += '\n}\n';
                if (exportEquals) {
                    refined.declaration += `export import ${refined.id.varName} = ${refined.id.varName}_module\n`;
                }
            } else if (this.needDeclaration) {
                const errormsg = `'${this.mpath}.d.ts' is not emitted`;
                this.error(null, IfTsbError.ModuleNotFound, errormsg);
                refined.errored = true;
                refined.declaration = `// ${this.rpath}\n`;
                refined.declaration += `export namespace ${refined.id.varName} {\n`;
                refined.declaration += `// ${errormsg}\n`;
                refined.declaration += `}\n`;
            }
            if (moduleDeclaration !== '') {
                refined.declaration += moduleDeclaration;
                refined.declaration += '\n';
            }
            if (globalDeclaration !== '') {
                refined.globalDeclaration = globalDeclaration;
            }

            // sourcemap
            refined.sourceMapText = sourceMapText;
        }

        for (const ref of refs) {
            ref.release();
        }
        refined.outputLineCount = count(refined.content, '\n');
        refined.size = refined.content.length + 2048;
        refined.save(bundler);
        return refined;
    }

    private async _checkExternalChanges(refined:RefinedModule):Promise<boolean> {
        for (const imp of refined.imports) {
            if (imp.getExternalMode() !== ExternalMode.NoExternal) continue;
            for (const glob of this.bundler.externals) {
                if (glob.test(imp.mpath)) return true;
            }
        }
        return false;
    }

    async refine():Promise<RefinedModule|null> {
        let {refined, sourceMtime} = await RefinedModule.getRefined(this.id, this.bundler.tsconfigMtime);
        if (refined === null || 
            refined.errored || 
            (this.needDeclaration && refined.declaration === null) || !refined.checkRelativePath(this.rpath) ||
            (await this._checkExternalChanges(refined))) {
            if (refined !== null) memcache.unuse(refined);
            refined = await this._refine(sourceMtime);
            if (refined === null) return null;
            memoryCache.register(refined.id.number, refined);
        }
        for (const imp of refined.imports) {
            const mode = imp.getExternalMode();
            if (mode !== ExternalMode.Preimport) {
                continue;
            }
            const id = this.bundler.getModuleId(imp.mpath, mode);
            if (imp.declaration) {
                this.bundler.dtsPreloadModules.add(id);
            } else {
                this.bundler.jsPreloadModules.add(id);
            }
        }
        return refined;
    }
}

export interface BundlerModuleId {
    number:number;
    varName:string;
    apath:string;
}

class RefineHelper {
    public readonly stacks:ts.Node[] = [];

    constructor(
        public readonly bundler:Bundler,
        public readonly module:BundlerModule,
        public readonly refined:RefinedModule,
        public readonly sourceFile:ts.SourceFile,
    ) {
    }

    getParentNode():ts.Node|undefined {
        return this.stacks[this.stacks.length-1];
    }
    getErrorPosition():ErrorPosition|null{
        for (let i = this.stacks.length-1; i >= 0; i--) {
            let node = this.stacks[i];
            const ori = (node as any).original;
            if (ori) node = ori;
            if (node.pos === -1) continue;
            return this.module.makeErrorPosition(node);
        }
        return null;
    }
    addExternalList(name:string, mode:ExternalMode, codepos:ErrorPosition|null, declaration:boolean):BundlerModuleId {
        const childModule = this.bundler.getModuleId(name, mode);
        this.refined.imports.push(new ImportInfo((-mode)+'', name, codepos, declaration));
        return childModule;
    }
    addToImportList(mpath:string, apath:string, codepos:ErrorPosition|null, declaration:boolean):BundlerModule{
        const childModule = this.bundler.getModule(apath, mpath);
        this.refined.imports.push(new ImportInfo(childModule.id.apath, mpath, codepos, declaration));
        return childModule;
    }
    parseImportPath(stringLiteralNode:ts.Node):ParsedImportPath|null {
        if (stringLiteralNode.kind === ts.SyntaxKind.LiteralType) {
            stringLiteralNode = (stringLiteralNode as ts.LiteralTypeNode).literal;
        }
        if (stringLiteralNode.kind !== ts.SyntaxKind.StringLiteral) {
            if (!this.bundler.suppressDynamicImportErrors) {
                this.refined.errored = true;
                this.module.error(this.getErrorPosition(), IfTsbError.Unsupported, `if-tsb does not support dynamic import for local module, (${ts.SyntaxKind[stringLiteralNode.kind]} is not string literal)`);
            }
            return null;
        }
        const node = stringLiteralNode as ts.StringLiteral;
        return this.module.makeImportModulePath(node.text);
    }
    getAbsolutePath(importPath:ParsedImportPath):string|null {
        let module = ts.nodeModuleNameResolver(importPath.importName, this.module.id.apath, this.bundler.tsoptions, this.bundler.sys, this.bundler.moduleResolutionCache);
        if (!module.resolvedModule && importPath.importName === '.') 
            module = ts.nodeModuleNameResolver('./index', this.module.id.apath, this.bundler.tsoptions, this.bundler.sys, this.bundler.moduleResolutionCache);
        const info = module.resolvedModule;
        if (info == null) {
            this.refined.errored = true;
            this.module.error(this.getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importPath.importName}' or its corresponding type declarations.`);
            return null;
        }

        return path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(this.bundler.basedir, info.resolvedFileName);
    }

}

const PREIMPORT = '#pre';
type PREIMPORT = '#pre';
const NOIMPORT = '#noimp';
type NOIMPORT = '#noimp';

interface ImportResult<T> {
    node:T;
    module:BundlerModule|null;
    moduleId:BundlerModuleId|null;
}

abstract class Transformer<T> {
    public readonly refined:RefinedModule;
    public readonly bundler:Bundler;
    public readonly module:BundlerModule;
    public readonly factory:ts.NodeFactory;
    public readonly globalVar:T;

    constructor(
        public readonly ctx:ts.TransformationContext,
        public readonly importer:RefineHelper,
        public readonly delcaration:boolean,
        ) {
        this.bundler = importer.bundler;
        this.module = importer.module;
        this.refined = importer.refined;
        this.factory = ctx.factory;
        this.globalVar = this.makeIdentifier(this.bundler.globalVarName);
    }

    abstract makeIdentifier(name:string):T;
    abstract makePropertyAccess(left:T, right:string):T;
    abstract importLocal(childModule:BundlerModule):T;

    preimport(mpath:string):ImportResult<T>{
        const module = this.importer.addExternalList(mpath, ExternalMode.Preimport, this.importer.getErrorPosition(), this.delcaration);
        let node:T;
        if (this.delcaration) node = this.makeIdentifier(`${this.bundler.globalVarName}_${module.varName}`);
        else node = this.makePropertyAccess(this.globalVar, module.varName);
        return {
            node,
            module: null,
            moduleId: module,
        };
    }

    getImportPath(importPath:ParsedImportPath):string|null {
        const oldsys = this.bundler.sys;
        const sys:ts.System = Object.setPrototypeOf({
            fileExists(path: string): boolean {
                if (getScriptKind(path).kind === ts.ScriptKind.External) return false;
                return oldsys.fileExists(path);
            }
        }, oldsys);

        let module = ts.nodeModuleNameResolver(importPath.importName, this.module.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
        if (!module.resolvedModule && importPath.importName === '.') 
            module = ts.nodeModuleNameResolver('./index', this.module.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
        const info = module.resolvedModule;
        if (info == null) {
            if (!importPath.importName.startsWith('.')) {
                return importPath.mpath;
            }
            this.refined.errored = true;
            this.module.error(this.importer.getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importPath.importName}' or its corresponding type declarations.`);
            return null;
        }

        let childmoduleApath = path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(this.bundler.basedir, info.resolvedFileName);
        const kind = getScriptKind(childmoduleApath);
        if (kind.kind === ts.ScriptKind.External) {
            childmoduleApath = childmoduleApath.substr(0, childmoduleApath.length-kind.ext.length+1)+'js';
            if (!cachedStat.existsSync(childmoduleApath)) {
                this.refined.errored = true;
                this.module.error(this.importer.getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importPath.importName}' or its corresponding type declarations.`);
                return null;
            }
        }
        return childmoduleApath;
    }

    resolveImport(importPath:ParsedImportPath):string|PREIMPORT|null {
        for (const glob of this.bundler.externals) {
            if (glob.test(importPath.mpath)) return null;
        }
        if (this.bundler.preimportTargets.has(importPath.mpath)) {
            return PREIMPORT;
        }

        const oldsys = this.bundler.sys;
        const sys:ts.System = Object.setPrototypeOf({
            fileExists(path: string): boolean {
                if (getScriptKind(path).kind === ts.ScriptKind.External) return false;
                return oldsys.fileExists(path);
            }
        }, oldsys);
        let module = ts.nodeModuleNameResolver(importPath.importName, this.module.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
        if (!module.resolvedModule && importPath.importName === '.') 
            module = ts.nodeModuleNameResolver('./index', this.module.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
        const info = module.resolvedModule;
        if (info == null) {
            if (!importPath.importName.startsWith('.')) {
                if (builtin.has(importPath.mpath)) {
                    return PREIMPORT;
                }
                if (!this.bundler.bundleExternals) return null;
            }
            this.refined.errored = true;
            this.module.error(this.importer.getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importPath.importName}' or its corresponding type declarations.`);
            return null;
        }

        if (info.isExternalLibraryImport) {
            if (!this.bundler.bundleExternals) {
                if (this.delcaration) return PREIMPORT;
                return null;
            }
        }
        
        let childmoduleApath = path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(this.bundler.basedir, info.resolvedFileName);
        const kind = getScriptKind(childmoduleApath);
        if (kind.kind === ts.ScriptKind.External) {
            childmoduleApath = childmoduleApath.substr(0, childmoduleApath.length-kind.ext.length+1)+'js';
            if (!cachedStat.existsSync(childmoduleApath)) {
                this.refined.errored = true;
                this.module.error(this.importer.getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importPath.importName}' or its corresponding type declarations.`);
                return null;
            }
        }
        return childmoduleApath;
    }
    
    importFromStringLiteral(importPath:ParsedImportPath):ImportResult<T>|NOIMPORT|null{
        if (importPath.mpath === 'if-tsb/reflect') {
            return NOIMPORT;
        }
        const resolved = this.resolveImport(importPath);
        if (resolved === null) return null;
        if (resolved === PREIMPORT) {
            return this.preimport(importPath.mpath);
        } else {
            const childModule = this.importer.addToImportList(importPath.mpath, resolved, this.importer.getErrorPosition(), this.delcaration);
            return {
                node: this.importLocal(childModule),
                module: childModule,
                moduleId: childModule.id,
            };
        }
    }
    
    createQualifiedChain(base:ts.EntityName, names:string[]):ts.EntityName {
        let chain:ts.EntityName = base;
        for (const name of names) {
            chain = this.factory.createQualifiedName(chain, name);
        }
        return chain;
    }
}

class JsTransformer extends Transformer<ts.Expression> {
    makeIdentifier(name:string):ts.Expression {
        return this.factory.createIdentifier(name);
    }
    makePropertyAccess(left:ts.Expression, right:string):ts.Expression{
        return this.factory.createPropertyAccessExpression(
            left,
            right);
    }
    importLocal(childModule:BundlerModule):ts.Expression{
        const moduleVar = this.makePropertyAccess(this.globalVar, childModule.id.varName);
        if (childModule.isEntry) return moduleVar;
        return this.factory.createCallExpression(moduleVar, [], []);
    }
}

class DeclTransformer extends Transformer<ts.EntityName> {
    makeIdentifier(name:string):ts.EntityName {
        return this.factory.createIdentifier(name);
    }
    makePropertyAccess(left:ts.EntityName, right:string):ts.EntityName{
        return this.factory.createQualifiedName(left, right);
    }
    importLocal(childModule:BundlerModule):ts.EntityName{
        return this.makePropertyAccess(this.globalVar, childModule.id.varName);
    }
    importFromStringLiteral(importPath:ParsedImportPath):ImportResult<ts.EntityName>|NOIMPORT {
        const importName = super.importFromStringLiteral(importPath);
        if (importName === null) return this.preimport(importPath.mpath);
        return importName;
    }
    joinEntityNames(...names:(ts.EntityName|undefined)[]):ts.EntityName {
        let res:ts.EntityName|undefined;
        const append = (node:ts.EntityName|undefined):void=>{
            if (node === undefined) return;
            if (res === undefined) {
                res = node;
            } else if (node.kind === ts.SyntaxKind.QualifiedName) {
                append((node as ts.QualifiedName).left);
                res = this.factory.createQualifiedName(res, (node as ts.QualifiedName).right);
            } else {
                res = this.factory.createQualifiedName(res, node);
            }
        }
        for (const node of names) {
            append(node);
        }
        if (res === undefined) throw TypeError('Invalid argument');
        return res;
    }
}
