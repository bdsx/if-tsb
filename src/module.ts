import * as path from 'path';
import * as ts from "typescript";
import type { Bundler } from "./bundler";
import { CACHE_SIGNATURE, getCacheFilePath } from "./cachedir";
import { cachedStat } from "./cachedstat";
import { ErrorPosition } from "./errpos";
import { fsp } from "./fsp";
import { LineStripper } from "./linestripper";
import { memcache } from "./memmgr";
import { registerModuleReloader, reloadableRequire } from "./modulereloader";
import { namelock } from "./namelock";
import { SourceFileData } from "./sourcefilecache";
import { WriterStream as FileWriter } from './streamwriter';
import { tshelper } from './tshelper';
import { ExportRule, ExternalMode, IfTsbError } from "./types";
import { count, dirnameModulePath, getScriptKind, joinModulePath, printDiagnostrics, ScriptKind, SkipableTaskQueue } from "./util";
export const CACHE_MEMORY_DEFAULT = 1024*1024*1024;
memcache.maximum = CACHE_MEMORY_DEFAULT;
export const memoryCache = new memcache.Map<number, RefinedModule>();

let moduleReloaderRegistered = false;

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

class MtimeChecker {
    private readonly list:Promise<number>[] = [];
    add(apath:string):void {
        this.list.push(cachedStat.mtime(apath));
    }
    addOpts(apath:string):void {
        this.list.push(cachedStat.mtime(apath).catch(()=>-1));
    }
    addDecl(bundler:Bundler, apath:string):void {
        if (!bundler.declaration) {
            this.list.push(Promise.resolve(-1));
            return;
        }
        const kind = getScriptKind(apath);
        if (kind.kind !== ts.ScriptKind.JS) {
            this.list.push(Promise.resolve(-1));
            return;
        }
        this.list.push(cachedStat.mtime(kind.modulePath+'.d.ts').catch(err=>-1));
    }

    wait():Promise<number[]> {
        return Promise.all(this.list);
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
    dtsMtime:number;
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
                await writer.write(this.dtsMtime+'\0');
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
        ] = content.split('\0');
        this.sourceMtime = +sourceMtime;
        this.dtsMtime = +dtsMtime;
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

    static async getRefined(bundler:Bundler, id:BundlerModuleId):Promise<{refined:RefinedModule|null, sourceMtime:number, dtsMtime:number}> {
        let sourceMtime = -1;
        let dtsMtime = -1;
        _error:try {
            const cached = memoryCache.take(id.number);
            if (cached != null) {
                const prom = new MtimeChecker;
                prom.add(id.apath);
                prom.addDecl(bundler, id.apath);
                const [srcmtime, dtsmtime] = await prom.wait();
                sourceMtime = srcmtime;
                dtsMtime = dtsmtime;
                if (cached.sourceMtime !== sourceMtime) {
                    memcache.unuse(cached);
                    break _error;
                }
                if (dtsMtime !== -1 && cached.dtsMtime !== dtsMtime) {
                    memcache.unuse(cached);
                    break _error;
                }
                if (cached.tsconfigMtime !== bundler.tsconfigMtime) {
                    memcache.unuse(cached);
                    break _error;
                }
                return {refined:cached, sourceMtime, dtsMtime};
            } else {
                try {
                    await namelock.lock(id.number);
                    const cachepath = getCacheFilePath(id.number);
                    const checker = new MtimeChecker;
                    checker.addOpts(cachepath);
                    checker.addOpts(id.apath);
                    checker.addDecl(bundler, id.apath);
                    const [cacheMtime, srcmtime, dtsmtime] = await checker.wait();
                    sourceMtime = srcmtime;
                    dtsMtime = dtsmtime;
                    if (cacheMtime === -1) break _error;
                    if (cacheMtime < bundler.tsconfigMtime) break _error;
                    if (cacheMtime < srcmtime) break _error;
                    if (bundler.declaration && dtsmtime !== -1 && cacheMtime < dtsmtime) break _error;
                } finally {
                    namelock.unlock(id.number);
                }
                const refined = new RefinedModule(id);
                const loaded = await refined.load();
                memoryCache.register(id.number, refined);
                if (!loaded) break _error;
                if (refined.sourceMtime !== sourceMtime) break _error;
                if (refined.dtsMtime !== dtsMtime) break _error;
                if (refined.tsconfigMtime !== bundler.tsconfigMtime) break _error;
                return {refined, sourceMtime, dtsMtime};
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
        return {refined:null, sourceMtime, dtsMtime};
    }
    
}

export enum CheckState {
    None,Entered,Checked,
}

export class ParsedImportPath {
    private importAPath:string|null|undefined = undefined;
    
    constructor(
        public readonly helper:RefineHelper,
        public readonly importName:string,
        public readonly mpath:string) {
    }

    literal(factory:ts.NodeFactory):ts.StringLiteral {
        return factory.createStringLiteral(this.mpath);
    }

    call(factory:ts.NodeFactory):ts.Expression {
        const mpathLitral = this.literal(factory);
        return factory.createCallExpression(factory.createIdentifier('require'), undefined, [mpathLitral]);
    }

    import(factory:ts.NodeFactory):ts.ExternalModuleReference {
        const mpathLitral = this.literal(factory);
        return factory.createExternalModuleReference(mpathLitral);
    }

    getAbsolutePath():string|null {
        if (this.importAPath !== undefined) return this.importAPath;
        const module = this.helper.module;
        const bundler = module.bundler;
        let modulePath = ts.nodeModuleNameResolver(this.importName, module.id.apath, bundler.tsoptions, bundler.sys, bundler.moduleResolutionCache);
        if (!modulePath.resolvedModule && this.importName === '.') 
            modulePath = ts.nodeModuleNameResolver('./index', module.id.apath, bundler.tsoptions, bundler.sys, bundler.moduleResolutionCache);
        const info = modulePath.resolvedModule;
        if (info == null) {
            this.helper.importError(this.importName);
            this.importAPath = null;
        } else {
            this.importAPath = path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(bundler.basedir, info.resolvedFileName);
        }
        return this.importAPath;
    }

    getImportAPath():string|null {
        const moduleAPath = this.getAbsolutePath();
        return moduleAPath !== null ? getScriptKind(moduleAPath).modulePath.replace(/\\/g, '/') : null;
    }

    isBuiltInModule():boolean {
        if (this.importName.startsWith('.')) return false;
        return tshelper.builtin.has(this.mpath);
    }

    isExternalModule():boolean {
        if (this.importName.startsWith('.')) return false;
        if (tshelper.builtin.has(this.mpath)) return true;
        if (this.helper.bundler.bundleExternals) return false;
        return true;        
    }
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

    private async _refine(sourceMtime:number, dtsMtime:number):Promise<RefinedModule|null> {
        if (sourceMtime === -1) {
            this.error(null, IfTsbError.ModuleNotFound, `Cannot find module '${this.mpath}'`);
            return null;
        }

        this.children.length = 0;
        this.importLines.length = 0;

        const refined = new RefinedModule(this.id);
        refined.content = `// ${this.rpath}\n`;
        refined.sourceMtime = sourceMtime;
        refined.dtsMtime = dtsMtime;
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
        const printer = ts.createPrinter();
        
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
            const tool = new MakeTool(ctx, helper, sourceFile, false);
            const importer = new JsImporter(tool, tool.globalVar);

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
                        if (right !== null && tshelper.nameEquals(right, 'exports')) {
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
                        const res = importer.importFromStringLiteral(importPath);
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
                            helper.error(IfTsbError.Unsupported, `Cannot call import with multiple parameters`);
                            return node;
                        }
                        const importPath = helper.parseImportPath(node.arguments[0]);
                        if (importPath === null) return node;
                        const res = importer.importFromStringLiteral(importPath);
                        if (res === NOIMPORT) return ctx.factory.createObjectLiteralExpression();
                        return res !== null ? res.node :importPath.call(ctx.factory);
                    }
                    case ts.SyntaxKind.Identifier: {
                        const identifier = node.expression as ts.Identifier;
                        if (identifier.escapedText === 'require') {
                            const importPath = helper.parseImportPath(node.arguments[0]);
                            if (importPath === null) return node;
                            const res = importer.importFromStringLiteral(importPath);
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
                            const mpath = helper.makeImportModulePath(path.value);
                            const importPath = tool.getImportPath(mpath);
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
                return helper.visitChildren(_node, visit, ctx);
            };
            
            return (srcfile:ts.SourceFile)=>{
                if (srcfile.fileName !== sourceFile.fileName) return srcfile;
                return ts.visitEachChild(srcfile, visit, ctx);
            };
        };

        const declFactory = (sourceFile:ts.SourceFile)=>{
            return (ctx:ts.TransformationContext)=>{
                const tool = new MakeTool(ctx, helper, sourceFile, true);
                const importer = new DeclImporter(tool, tool.globalVar);
                const arrImporter = new StringArrayImporter(tool, [bundler.globalVarName]);
    
                const visitAbsoluting = (outerModulePath:ParsedImportPath|null)=>{
                    const visitAbsoluting = (_node:ts.Node):ts.Node[]|ts.Node|undefined=>{
                        switch (_node.kind) {
                        case ts.SyntaxKind.Identifier: {
                            if (_node.parent == null) break;
                            const symbol = typeChecker.getSymbolAtLocation(_node);
                            if (symbol == null) break;
                            if (symbol.declarations == null) break;
                            if (!tshelper.isRootIdentifier(_node as ts.Identifier)) break;
                            if (symbol.declarations.indexOf(_node.parent as ts.Declaration) !== -1) break;

                            for (const _decl of symbol.declarations) {
                                switch (_decl.kind) {
                                case ts.SyntaxKind.NamespaceImport: {
                                    const decl = _decl as ts.NamespaceImport;
                                    const importDecl = decl.parent.parent;
                                    const importPath = helper.parseImportPath(importDecl.moduleSpecifier);
                                    if (importPath === null) continue;
                                    const res = importer.importFromStringLiteral(importPath);
                                    if (res === NOIMPORT) continue;
                                    return res.node;
                                }
                                case ts.SyntaxKind.ImportSpecifier: {
                                    const decl = _decl as ts.ImportSpecifier;
                                    const importDecl = decl.parent.parent.parent;
                                    const importPath = helper.parseImportPath(importDecl.moduleSpecifier);
                                    if (importPath === null) continue;
                                    if (_node.parent.kind === ts.SyntaxKind.ExpressionWithTypeArguments) {
                                        const res = arrImporter.importFromStringLiteral(importPath);
                                        if (res === NOIMPORT) continue;
                                        // transformer.
                                        return tool.createIdentifierChain([...res.node, decl.propertyName || decl.name]);
                                    } else {
                                        const res = importer.importFromStringLiteral(importPath);
                                        if (res === NOIMPORT) continue;
                                        return ctx.factory.createQualifiedName(res.node, decl.propertyName || decl.name);
                                    }
                                }
                                case ts.SyntaxKind.Parameter:
                                case ts.SyntaxKind.TypeParameter:
                                    return _node;
                                default:{
                                    const res = tool.analyizeDeclPath(_node, _decl, outerModulePath);
                                    return visitWith(res, visitAbsoluting);
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
    
                const visitWith = (_node:ts.Node, visitor:ts.Visitor):ts.Node[]|ts.Node|undefined=>{
                    switch (_node.kind) {
                    case ts.SyntaxKind.ModuleDeclaration: {
                        let node = _node as ts.ModuleDeclaration;
                        const res = importer.importFromModuleDecl(node);
                        if (res === null) break;
                        if (res === GLOBAL) {
                            // global module
                            const visited = ts.visitEachChild(node, visitAbsoluting(null), ctx);
                            globalDeclaration += 'declare global ';
                            globalDeclaration += printer.printNode(ts.EmitHint.Unspecified, visited.body!, sourceFile);
                            globalDeclaration += '\n';
                        } else if (res.module === null) {
                            // external module
                            const visited = ts.visitEachChild(node, visitAbsoluting(res.importPath), ctx);
                            globalDeclaration += 'declare module "';
                            globalDeclaration += res.importPath.mpath;
                            globalDeclaration += '"';
                            globalDeclaration += printer.printNode(ts.EmitHint.Unspecified, visited.body!, sourceFile);
                            globalDeclaration += '\n';
                        } else {
                            const visited = ts.visitEachChild(node, visitAbsoluting(res.importPath), ctx);
                            moduleDeclaration += 'export namespace ';
                            moduleDeclaration += res.moduleId.varName;
                            moduleDeclaration += printer.printNode(ts.EmitHint.Unspecified, visited.body!, sourceFile);
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
                            helper.error(IfTsbError.Unsupported, `if-tsb cannot export identifiers from the module`);
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
                            const res = importer.importFromStringLiteral(importPath);
                            if (res === NOIMPORT) return undefined;
                            return ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, node.name, res.node);
                        }
                        break;
                    }
                    case ts.SyntaxKind.ImportType: { // let v:import('module').Type;
                        const node = _node as ts.ImportTypeNode;
                        const importPath = helper.parseImportPath(node.argument);
                        if (importPath === null) return node;
                        const res = importer.importFromStringLiteral(importPath);
                        if (res === NOIMPORT) return node;
                        if (res.moduleId === null) return node;
                        return tool.joinEntityNames(res.node, node.qualifier);
                    }
                    case ts.SyntaxKind.ImportDeclaration: { // import 'module'; import { a } from 'module'; import a from 'module';
                        const node = _node as ts.ImportDeclaration;
                        const importPath = helper.parseImportPath(node.moduleSpecifier);
                        if (importPath === null) return node;
                        const res = importer.importFromStringLiteral(importPath);
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
                                    helper.error(IfTsbError.Unsupported, `Unexpected import syntax`);
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
                            helper.error(IfTsbError.Unsupported, `Unexpected import syntax`);
                            return node;
                        }
                    }
                    case ts.SyntaxKind.CallExpression: {
                        const node = _node as ts.CallExpression;
                        switch (node.expression.kind) {
                        case ts.SyntaxKind.ImportKeyword: { // const res = import('module');
                            if (node.arguments.length !== 1) {
                                helper.error(IfTsbError.Unsupported, `Cannot call import with multiple parameters`);
                                return _node;
                            }
                            const importPath = helper.parseImportPath(node.arguments[0]);
                            if (importPath === null) return node;
                            const res = importer.importFromStringLiteral(importPath);;
                            if (res === NOIMPORT) return ctx.factory.createObjectLiteralExpression();
                            return res.node;
                        }}
                        break;
                    }
                    }
                    return helper.visitChildren(_node, visitor, ctx);
                }
    
                const visit = (_node:ts.Node):ts.Node[]|ts.Node|undefined=>{
                    return visitWith(_node, visit);
                };
                
                return (srcfile:ts.SourceFile)=>{
                    if (srcfile.fileName !== sourceFile.fileName) return srcfile;
                    return ts.visitEachChild(srcfile, visit, ctx);
                };
            };
        };

        const transformer = { 
            after: [jsFactory],
            afterDeclarations: [declFactory(sourceFile)],
        };

        let sourceMapText:string|null = null;
        let declaration:string|null = null as any;
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
                        if (!tshelper.hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;
                        if ((st.flags & ts.NodeFlags.Namespace) !== 0) continue;
                        if ((st.flags & ts.NodeFlags.GlobalAugmentation) !== 0) continue;
                        const moduleDecl = st as ts.ModuleDeclaration;
                        const importPath = helper.parseImportPath(moduleDecl.name);
                        if (importPath === null) continue;
                        if (importPath.isBuiltInModule()) continue;
                        const apath = importPath.getAbsolutePath();
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
                const dtsPath = moduleinfo.modulePath + '.d.ts';
                try {
                    const dtsSourceFile = getSourceFile(dtsPath);
                    const res = ts.transform(dtsSourceFile, [declFactory(dtsSourceFile)], bundler.tsoptions);
                    const printer = ts.createPrinter();
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
        let {refined, sourceMtime, dtsMtime} = await RefinedModule.getRefined(this.bundler, this.id);
        if (refined === null || 
            refined.errored || 
            (this.needDeclaration && refined.declaration === null) || !refined.checkRelativePath(this.rpath) ||
            (await this._checkExternalChanges(refined))) {
            if (refined !== null) memcache.unuse(refined);
            refined = await this._refine(sourceMtime, dtsMtime);
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

export class BundlerModuleId {
    public readonly kind:ScriptKind;
    constructor(
        public readonly number:number,
        public readonly varName:string,
        public readonly apath:string) {
        this.kind = getScriptKind(apath);
    }
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
    error(code:number, message:string):void {
        this.refined!.errored = true;
        return this.module.error(this.getErrorPosition(), code, message);
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
    makeImportModulePath(mpath:string):ParsedImportPath {
        const module = this.module;
        const baseMPath = module.mpath;
        const baseAPath = module.id.apath;
        const importPath = mpath;

        let out:string;
        const parsedAPath = path.parse(baseAPath);
        if (!baseMPath.endsWith('/index') && parsedAPath.name === 'index') {
            out = joinModulePath(baseMPath, importPath);
        } else {
            const dirmodule = dirnameModulePath(baseMPath);
            out = joinModulePath(dirmodule, importPath);
        }
        return new ParsedImportPath(this, importPath, out);
    }
    parseImportPath(stringLiteralNode:ts.Node):ParsedImportPath|null {
        if (stringLiteralNode.kind === ts.SyntaxKind.LiteralType) {
            stringLiteralNode = (stringLiteralNode as ts.LiteralTypeNode).literal;
        }
        if (stringLiteralNode.kind !== ts.SyntaxKind.StringLiteral) {
            if (!this.bundler.suppressDynamicImportErrors) {
                this.error(IfTsbError.Unsupported, `if-tsb does not support dynamic import for local module, (${ts.SyntaxKind[stringLiteralNode.kind]} is not string literal)`);
            }
            return null;
        }
        const node = stringLiteralNode as ts.StringLiteral;
        return this.makeImportModulePath(node.text);
    }
    visitChildren<T extends ts.Node>(node:T, visitor:ts.Visitor, ctx:ts.TransformationContext):T {
        this.stacks.push(node);
        try {
            return ts.visitEachChild(node, visitor, ctx);
        } finally {
            this.stacks.pop();
        }
    }
    importError(importName:string):void {
        this.error(IfTsbError.ModuleNotFound, `Cannot find module '${importName}' or its corresponding type declarations.`);
    }

}

const PREIMPORT = '#pre';
type PREIMPORT = '#pre';
const NOIMPORT = '#noimp';
type NOIMPORT = '#noimp';
const GLOBAL = '#global';
type GLOBAL = '#global';

interface ImportResult<T> {
    node:T;
    module:BundlerModule|null;
    moduleId:BundlerModuleId;
    importPath:ParsedImportPath;
}

class MakeTool {
    public readonly refined:RefinedModule;
    public readonly bundler:Bundler;
    public readonly module:BundlerModule;
    public readonly factory:ts.NodeFactory;
    public readonly globalVar:ts.Identifier;

    constructor(
        public readonly ctx:ts.TransformationContext,
        public readonly helper:RefineHelper,
        public readonly sourceFile:ts.SourceFile,
        public readonly delcaration:boolean,
        ) {
        this.bundler = helper.bundler;
        this.module = helper.module;
        this.refined = helper.refined;
        this.factory = ctx.factory;
        this.globalVar = this.factory.createIdentifier(this.bundler.globalVarName);
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
            this.helper.importError(importPath.importName);
            return null;
        }

        let childmoduleApath = path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(this.bundler.basedir, info.resolvedFileName);
        const kind = getScriptKind(childmoduleApath);
        if (kind.kind === ts.ScriptKind.External) {
            childmoduleApath = kind.modulePath+'.js';
            if (!cachedStat.existsSync(childmoduleApath)) {
                this.helper.importError(importPath.importName);
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
                if (importPath.isBuiltInModule()) {
                    return PREIMPORT;
                }
                if (!this.bundler.bundleExternals) return null;
            }
            this.helper.importError(importPath.importName);
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
                this.helper.importError(importPath.importName);
                return null;
            }
        }
        return childmoduleApath;
    }
    
    createIdentifierChain(names:(string|ts.MemberName|ts.Expression)[]):ts.Expression {
        if (names.length === 0) throw Error('empty array');
        const first = names[0];
        let node:ts.Expression = typeof first === 'string' ? this.factory.createIdentifier(first) : first;
        for (let i=1;i<names.length;i++) {
            const name = names[i];
            if (typeof name !== 'string' && !ts.isMemberName(name)) throw Error(`Unexpected kind ${name.kind}`);
            node = this.factory.createPropertyAccessExpression(node, name);
        }
        return node;
    }

    createQualifiedChain(base:ts.EntityName, names:string[]):ts.EntityName {
        let chain:ts.EntityName = base;
        for (const name of names) {
            chain = this.factory.createQualifiedName(chain, name);
        }
        return chain;
    }
        
    analyizeDeclPath(oriNode:ts.Node, declNode:ts.Declaration, outerModulePath:ParsedImportPath|null):ts.Node {
        let outerModuleAPath:string|null;
        if (outerModulePath !== null) {
            if (!outerModulePath.isExternalModule()) {
                outerModuleAPath = outerModulePath.getAbsolutePath();
                if (outerModuleAPath !== null) {
                    outerModuleAPath = outerModuleAPath.replace(/\\/g, '/');
                }
            }
        }
        class ReturnDirect {
            constructor(public readonly node:ts.Node) {}
        }
        const moduleAPath = this.module.id.apath.replace(/\\/g, '/');
        const getNodeName = (node:ts.Node)=>{
            if (ts.isClassDeclaration(node)) {
                if (node.name == null) {
                    // export default
                    return 'default';
                } else {
                    return node.name.text;
                }
            } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
                return node.name.text;
            } else {
                return null;
            }
        };
        const get = (node:ts.Node):ts.EntityName|ReturnDirect|null=> {
            let name:string|null;
            if (ts.isModuleDeclaration(node)) {
                const imported = new DeclImporter(this, this.globalVar).importFromModuleDecl(node);
                if (imported === null) {
                    this.helper.error(IfTsbError.Unsupported, `Unresolved module ${node.name}`);
                    return new ReturnDirect(oriNode);
                } else if (imported === GLOBAL) {
                    return new ReturnDirect(oriNode);
                } else if (outerModulePath !== null && imported.importPath.mpath === outerModulePath.mpath) {
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
                    return this.factory.createQualifiedName(this.globalVar, this.module.id.varName);
                }
                if (!tshelper.isExportingModule(node)) { // global expected
                    return new ReturnDirect(oriNode);
                } else {
                    debugger;
                    this.helper.error(IfTsbError.Unsupported, `Unexpected source file ${node.fileName}`);
                    return new ReturnDirect(oriNode);
                }
            } else if (ts.isModuleBlock(node)) {
                return get(node.parent);
            } else {
                name = getNodeName(node);
            }
            if (name !== null) {
                const res = get(node.parent);
                if (res instanceof ReturnDirect) {
                    return res;
                }
                if (!tshelper.isExportingOnDecl(node)) {
                    if (ts.isTypeAliasDeclaration(node)) {
                        if (node.getSourceFile().fileName === this.sourceFile.fileName) {
                            return new ReturnDirect(node.type);
                        }
                        const type = node.type;
                        if (ts.isIdentifier(type)) return new ReturnDirect(type);
                    }
                    this.helper.error(IfTsbError.Unsupported, `Need to export`);
                    return new ReturnDirect(oriNode);
                }
                if (res === null ){
                    return this.factory.createIdentifier(name);
                } else {
                    return this.factory.createQualifiedName(res, name);
                }
            } else {
                debugger;
                this.helper.error(IfTsbError.Unsupported, `Unexpected node kind ${ts.SyntaxKind[node.kind]}`);
                return new ReturnDirect(oriNode);
            }
        };
        const res = get(declNode);
        if (res === null) {
            debugger;
            throw Error('Invalid');
        } else if (res instanceof ReturnDirect) {
            return res.node;
        } else {
            return res;
        }
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

abstract class Importer<T> {
    public readonly bundler:Bundler;
    public readonly factory:ts.NodeFactory;
    public readonly helper:RefineHelper;
    public readonly delcaration:boolean;

    constructor(
        public readonly tool:MakeTool,
        public readonly globalVar:T,
    ) {
        this.bundler = tool.bundler;
        this.factory = tool.factory;
        this.helper = tool.helper;
        this.delcaration = tool.delcaration;
    }

    abstract makeIdentifier(name:string):T;
    abstract makePropertyAccess(left:T, right:string):T;
    abstract importLocal(childModule:BundlerModule):T;

    preimport(importPath:ParsedImportPath):ImportResult<T>{
        if (importPath.importName.startsWith('.')) throw Error(`Invalid preimport ${importPath.importName}`);
        const module = this.helper.addExternalList(importPath.mpath, ExternalMode.Preimport, this.helper.getErrorPosition(), this.delcaration);
        let node:T;
        if (this.delcaration) node = this.makeIdentifier(`${this.bundler.globalVarName}_${module.varName}`);
        else node = this.makePropertyAccess(this.globalVar, module.varName);
        return {
            node,
            module: null,
            moduleId: module,
            importPath,
        };
    }

    importFromStringLiteral(importPath:ParsedImportPath):ImportResult<T>|NOIMPORT|null{
        if (importPath.mpath === 'if-tsb/reflect') {
            return NOIMPORT;
        }
        const resolved = this.tool.resolveImport(importPath);
        if (resolved === null) return null;
        if (resolved === PREIMPORT) {
            return this.preimport(importPath);
        } else {
            const childModule = this.helper.addToImportList(importPath.mpath, resolved, this.helper.getErrorPosition(), this.delcaration);
            return {
                node: this.importLocal(childModule),
                module: childModule,
                moduleId: childModule.id,
                importPath,
            };
        }
    }
    
    importFromModuleDecl(node:ts.ModuleDeclaration):ImportResult<T>|GLOBAL|null {
        if (!tshelper.hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return null;
        if ((node.flags & ts.NodeFlags.Namespace) !== 0) return null;
        if ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) {
            return GLOBAL;
        } else {
            const importPath = this.helper.parseImportPath(node.name);
            if (importPath === null) return null;
            const res = this.importFromStringLiteral(importPath);
            if (res === NOIMPORT) return null;
            if (res === null) return null;
            return res;
        }
    }
}

class JsImporter extends Importer<ts.Expression> {
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

class DeclImporter extends Importer<ts.EntityName> {
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
        if (importName === null) return this.preimport(importPath);
        return importName;
    }
}

class StringArrayImporter extends Importer<string[]> {
    makeIdentifier(name:string):string[] {
        return [name];
    }
    makePropertyAccess(left:string[], right:string):string[]{
        return [...left, right];
    }
    importLocal(childModule:BundlerModule):string[]{
        return this.makePropertyAccess(this.globalVar, childModule.id.varName);
    }
    importFromStringLiteral(importPath:ParsedImportPath):ImportResult<string[]>|NOIMPORT {
        const importName = super.importFromStringLiteral(importPath);
        if (importName === null) return this.preimport(importPath);
        return importName;
    }
}
