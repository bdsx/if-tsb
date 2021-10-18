import type { Bundler } from "./bundler";
import { CACHE_SIGNATURE, getCacheFilePath } from "./cachedir";
import { ErrorPosition } from "./errpos";
import { fsp } from "./fsp";
import { LineStripper } from "./linestripper";
import { CacheMap } from "./memmgr";
import { namelock } from "./namelock";
import { SourceFileData } from "./sourcefilecache";
import { WriterStream as FileWriter } from './streamwriter';
import { ExportRule, ExternalMode, IfTsbError } from "./types";
import { count, getScriptKind, makeImportModulePath, printDiagnostrics, SkipableTaskQueue } from "./util";
import path = require('path');
import fs = require("fs");
import ts = require("typescript");
export const CACHE_MEMORY_DEFAULT = 1024*1024*1024;
CacheMap.maximum = CACHE_MEMORY_DEFAULT;
export const memoryCache = new CacheMap<number, RefinedModule>();
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

export class ImportInfo {
    constructor(
        public readonly apathOrExternalMode:string,
        public readonly importPath:string,
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
            const line:SerializedInfo = [info.apathOrExternalMode, info.importPath, info.declaration];
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
    size:number;
    errored = false;
    sourceMtime:number;
    tsconfigMtime:number;

    private mtime:number|null;

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
                const writer = new FileWriter(getCacheFilePath(this.id));
                await writer.write(this.sourceMtime+'\0');
                await writer.write(this.tsconfigMtime+'\0');
                await writer.write(ImportInfo.stringify(this.imports)+'\0');
                await writer.write(this.firstLineComment ? this.firstLineComment+'\0' : '\0');
                await writer.write(this.sourceMapOutputLineOffset+'\0');
                await writer.write(this.outputLineCount+'\0');
                await writer.write(this.sourceMapText !== null ? this.sourceMapText.replace(/[\r\n]/g, '')+'\0' : '\0');
                await writer.write(this.content+'\0');
                await writer.write(this.declaration !== null ? this.declaration+'\0' : '\0');
                await writer.write(CACHE_SIGNATURE);
                await writer.end();
                bundler.taskQueue.unref();
            } finally {
                namelock.unlock(this.id.number);
            }
            this.mtime = Date.now();
        });
    }

    async getMtime():Promise<number> {
        if (this.mtime !== null) return this.mtime;
        const stat = await fsp.stat(this.id.apath);
        return this.mtime = +stat.mtime;
    }

    async load():Promise<boolean> {
        const cachepath = getCacheFilePath(this.id);
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
            declaration
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
        this.size = this.content.length + 2048;
        return true;
    }

    static async getRefined(id:BundlerModuleId, tsconfigMtime:number):Promise<{refined:RefinedModule|null, sourceMtime:number}> {
        let sourceMtime = -1;
        _error:try {
            const cached = memoryCache.take(id.number);
            if (cached != null) {
                sourceMtime = await cached.getMtime();
                if (cached.sourceMtime !== sourceMtime) break _error;
                if (cached.tsconfigMtime !== tsconfigMtime) break _error;
                return {refined:cached, sourceMtime};
            } else {
                try {
                    await namelock.lock(id.number);
                    const cachepath = getCacheFilePath(id);
                    let cacheMtime = -1;
                    await Promise.all([fsp.stat(cachepath).then(cache=>{
                        cacheMtime = +cache.mtime;
                    }, ()=>{}), fsp.stat(id.apath).then(source=>{
                        sourceMtime = +source.mtime;
                    }, ()=>{})]);
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
        apath:string,
        forceModuleName:string|null) {
        this.id = bundler.getModuleId(apath, ExternalMode.NoExternal, forceModuleName);
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

    makeImportModulePath(mpath:string):string {
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
        let useExports = false;
        let exportEquals = false;
        const that = this;
        const isEntryModule = this.isEntry;
        const bundler = this.bundler;
        const importer = new ModuleImporter(this.bundler, refined);

        let filepath = this.id.apath;
        const info = getScriptKind(filepath);
        
        const refs:SourceFileData[] = [];

        let sourceFile:ts.SourceFile;
        try {
            let error = '';
            const data = bundler.sourceFileCache.get(filepath.replace(/\\/g, '/'));
            refs.push(data);
            sourceFile = await data.get();
            if (sourceFile == null) {
                this.error(null, IfTsbError.ModuleNotFound, error+' '+filepath);
                return null;
            }
        } catch (err) {
            this.error(null, IfTsbError.ModuleNotFound, err.message+' '+filepath);
            return null;
        }
        
        const jsFactory = (ctx:ts.TransformationContext)=>{
            const transformer = new JsTransformer(ctx, this, importer, sourceFile, false);
    
            const visit = (_node:ts.Node):ts.Node=>{
                transformer.stacks.push(_node);

                switch (_node.kind) {
                case ts.SyntaxKind.Identifier: {
                    const node = _node as ts.Identifier;
                    const parent = transformer.stacks[transformer.stacks.length-1];
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
                    
                    const ref = node.moduleReference;
                    if (ref.kind === ts.SyntaxKind.ExternalModuleReference) {
                        const importPath = transformer.parseImportPath(ref.expression);
                        if (importPath === null) return node;
                        const nnode = transformer.importFromStringLiteral(importPath) || importPath.call(ctx.factory);
                        return ctx.factory.createVariableDeclaration(node.name, undefined, undefined, nnode);
                    }
                    break;
                }
                case ts.SyntaxKind.CallExpression: {
                    const node = _node as ts.CallExpression;
                    switch (node.expression.kind) {
                    case ts.SyntaxKind.ImportKeyword: {
                        if (node.arguments.length !== 1) {
                            refined!.errored = true;
                            this.error(transformer.getErrorPosition(), IfTsbError.Unsupported, `Cannot call import with multiple parameters`);
                            return node;
                        }
                        const importPath = transformer.parseImportPath(node.arguments[0]);
                        if (importPath === null) return node
                        return transformer.importFromStringLiteral(importPath) || importPath.call(ctx.factory);
                    }
                    case ts.SyntaxKind.Identifier: {
                        const identifier = node.expression as ts.Identifier;
                        if (identifier.escapedText === 'require') {
                            const importPath = transformer.parseImportPath(node.arguments[0]);
                            if (importPath === null) return node;
                            return transformer.importFromStringLiteral(importPath) || importPath.call(ctx.factory);
                        }
                        break;
                    }}
                    break;
                }}
                const ret = ts.visitEachChild(_node, visit, ctx);
                transformer.stacks.pop();
                return ret;
            };
            
            return (srcfile:ts.SourceFile)=>{
                if (srcfile.fileName !== sourceFile.fileName) return srcfile;
                return ts.visitNode(srcfile, visit);
            };
        };

        const declFactory = (ctx:ts.TransformationContext)=>{
            const transformer = new DeclTransformer(ctx, this, importer, sourceFile, true);

            const visit = (_node:ts.Node):ts.Node[]|ts.Node|undefined=>{
                transformer.stacks.push(_node);

                switch (_node.kind) {
                case ts.SyntaxKind.DeclareKeyword:
                    if (!isEntryModule) return undefined;
                    break;
                case ts.SyntaxKind.ExportDeclaration: {
                    const node = _node as ts.ExportDeclaration;
                    const module = node.moduleSpecifier;
                    if (module != null) {
                        this.error(transformer.getErrorPosition(), IfTsbError.Unsupported, `if-tsb cannot export identifiers from modules`);
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
                        exports.push(ctx.factory.createExportSpecifier(identifier, exportName));
                    } else {
                        identifier = exportName;
                        out.push(ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, identifier, node.expression as ts.ModuleReference));
                        exports.push(ctx.factory.createExportSpecifier(undefined, identifier));
                    }

                    if (node.isExportEquals) {
                        // export = item
                        exportEquals = true;
                    } else {
                        // export defualt item
                        exports.push(ctx.factory.createExportSpecifier(identifier, 'default'));
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
                        const importPath = transformer.parseImportPath(ref.expression);
                        if (importPath === null) return node;
                        const nnode = transformer.importFromStringLiteral(importPath);
                        return ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, node.name, nnode);
                    }
                    break;
                }
                case ts.SyntaxKind.ImportDeclaration: { // import 'module'; import { a } from 'module'; import a from 'module';
                    const node = _node as ts.ImportDeclaration;
                    const clause = node.importClause;
                    if (clause == null) {
                        return undefined;
                    }
                    const importPath = transformer.parseImportPath(node.moduleSpecifier);
                    if (importPath === null) return node;
                    const importName = transformer.importFromStringLiteral(importPath);
                    if (clause.namedBindings != null) {
                        const out:ts.Node[] = [];
                        switch (clause.namedBindings.kind) {
                        case ts.SyntaxKind.NamespaceImport: 
                            // import * as a from 'module';
                            if (clause.namedBindings == null) {
                                this.error(transformer.getErrorPosition(), IfTsbError.Unsupported, `Unexpected import syntax`);
                                return node;
                            }
                            return ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, clause.namedBindings.name, importName);
                        case ts.SyntaxKind.NamedImports:
                            // import { a } from 'module';
                            for (const element of clause.namedBindings.elements) {
                                out.push(ctx.factory.createImportEqualsDeclaration(
                                    undefined,
                                    undefined,
                                    false,
                                    element.name,
                                    ctx.factory.createQualifiedName(importName, element.propertyName || element.name)));
                            }
                            break;
                        }
                        return out;
                    } else if (clause.name != null) {
                        // import a from 'module';
                        return ctx.factory.createImportEqualsDeclaration(undefined, undefined, false, clause.name, ctx.factory.createQualifiedName(importName, bundler.globalVarName+'_exported'));
                    } else {
                        this.error(transformer.getErrorPosition(), IfTsbError.Unsupported, `Unexpected import syntax`);
                        return node;
                    }
                }
                case ts.SyntaxKind.CallExpression: {
                    const node = _node as ts.CallExpression;
                    switch (node.expression.kind) {
                    case ts.SyntaxKind.ImportKeyword: { // const res = import('module');
                        if (node.arguments.length !== 1) {
                            refined!.errored = true;
                            this.error(transformer.getErrorPosition(), IfTsbError.Unsupported, `Cannot call import with multiple parameters`);
                            return _node;
                        }
                        const importPath = transformer.parseImportPath(node.arguments[0]);
                        if (importPath === null) return node;
                        return transformer.importFromStringLiteral(importPath);
                    }}
                    break;
                }}
                const ret = ts.visitEachChild(_node, visit, ctx);
                transformer.stacks.pop();
                return ret;
            };
            
            return (srcfile:ts.SourceFile)=>{
                if (srcfile.fileName !== sourceFile.fileName) return srcfile;
                return ts.visitNode(srcfile, visit);
            };
        };

        let sourceMapText:string|null = null;
        let declaration:string|null = null as any;
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
        } else {
            let content = '';
            const filePathForTesting = filepath.replace(/\\/g, '/');
            const superHost = bundler.compilerHost;
            const compilerHost:ts.CompilerHost = Object.setPrototypeOf({
                getSourceFile(fileName:string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void, shouldCreateNewSourceFile?: boolean) {
                    if (fileName === filePathForTesting) return sourceFile;
                    if (bundler.faster) {
                        return undefined;
                    }
                    const data = bundler.sourceFileCache.get(fileName);
                    refs.push(data);
                    return data.getSync();
                },
                writeFile(name:string, text:string) {
                    if (text === '') text = ' ';
                    const info = getScriptKind(name);
                    if (info.kind === ts.ScriptKind.JS) {
                        content = text;
                    }
                    else if (info.kind === ts.ScriptKind.External) {
                        if (that.needDeclaration) {
                            declaration = text;
                        }
                    }
                    else if (info.ext === '.MAP') {
                        sourceMapText = text;
                    }
                },
                fileExists(fileName:string) {
                    if (fileName.endsWith('.d.ts')) return superHost.fileExists(fileName);
                    return bundler.resolvePath(fileName) === filepath;
                }
            }, superHost);
    
            let diagnostics:ts.Diagnostic[]|undefined = bundler.faster ? undefined : [];
            const tsoptions:ts.CompilerOptions = {
                declaration: this.needDeclaration,
                declarationDir: undefined
            };
            Object.setPrototypeOf(tsoptions, this.bundler.tsoptions);

            bundler.program = ts.createProgram([filepath], tsoptions, compilerHost, bundler.program, diagnostics);
            
            bundler.program.emit(
                /*targetSourceFile*/ sourceFile, 
                /*writeFile*/ undefined, 
                /*cancellationToken*/ undefined, 
                /*emitOnlyDtsFiles*/ undefined, { 
                    after: [jsFactory],
                    afterDeclarations: [declFactory]
                });
            
            if (diagnostics != null) {
                diagnostics.push(...bundler.program.getSyntacticDiagnostics(sourceFile));
                refined!.errored = true;
                printDiagnostrics(diagnostics);
            }
            if (content === '') {
                if (diagnostics == null) {
                    printDiagnostrics(bundler.program.getSyntacticDiagnostics(sourceFile));
                }
                this.bundler.main.reportMessage(IfTsbError.Unsupported, `Failed to parse ${filepath}`);
                return null;
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
                const useStrict = !bundler.tsoptions.alwaysStrict && stricted;
    
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
                    importer.addExternalList('path', ExternalMode.Preimport, null, false);
                    importer.addExternalList('__resolve', ExternalMode.Manual, null, false);
                    importer.addExternalList('__dirname', ExternalMode.Manual, null, false);
                }
                if (useDirName)
                {
                    rpath = path.dirname(rpath);
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__dirname=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    importer.addExternalList('path', ExternalMode.Preimport, null, false);
                    importer.addExternalList('__resolve', ExternalMode.Manual, null, false);
                    importer.addExternalList('__dirname', ExternalMode.Manual, null, false);
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

            // declaration
            if (declaration !== null) {
                const stripper = new LineStripper(declaration);
                stripper.strip(line=>line.startsWith('#'));

                refined.declaration = `// ${this.rpath}\n`;
                if (this.isEntry) {
                } else {
                    if (exportEquals) {
                        refined.declaration += `namespace ${refined.id.varName}_module {\n`;
                    } else {
                        refined.declaration += `export namespace ${refined.id.varName} {\n`;
                    }
                }
                refined.content += stripper.strippedComments;
                refined.declaration += declaration.substring(stripper.index);
                refined.declaration += '\n';
                if (this.isEntry) {
                } else {
                    refined.declaration += `}\n`;
                    if (exportEquals) {
                        refined.declaration += `export import ${refined.id.varName} = ${refined.id.varName}_module._exported\n`;
                    }
                }
            } else if (this.needDeclaration) {
                const errormsg = `'${this.mpath}.d.ts' is not emitted`;
                this.error(null, IfTsbError.ModuleNotFound, errormsg);
                refined.declaration = `// ${this.rpath}\n`;
                refined.declaration += `export namespace ${refined.id.varName} {\n`;
                refined.declaration += `// ${errormsg}\n`;
                refined.declaration += `}\n`;
            }

            // sourcemap
            refined.sourceMapText = sourceMapText;
        }

        for (const ref of refs) {
            bundler.sourceFileCache.release(ref);
        }
        refined.outputLineCount = count(refined.content, '\n');
        refined.size = refined.content.length + 2048;
        refined.save(bundler);
        return refined;
    }

    async refine():Promise<RefinedModule|null> {
        let {refined, sourceMtime} = await RefinedModule.getRefined(this.id, this.bundler.tsconfigMtime);
        if (refined === null || (this.needDeclaration && refined.declaration === null) || !refined.checkRelativePath(this.rpath)) {
            refined = await this._refine(sourceMtime);
            if (refined === null) return null;
        } else {
            // check external changes
            _renewed: for (const imp of refined.imports) {
                if (imp.getExternalMode() !== ExternalMode.NoExternal) continue;
                const mpath = this.makeImportModulePath(imp.importPath);
                for (const glob of this.bundler.externals) {
                    if (glob.test(mpath)) {
                        refined = await this._refine(sourceMtime);
                        if (refined === null) return null;
                        break _renewed;
                    }
                }
            }
        }
        for (const imp of refined.imports) {
            const mode = imp.getExternalMode();
            if (mode !== ExternalMode.Preimport) {
                continue;
            }
            const id = this.bundler.getModuleId(imp.importPath, mode, null);
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

class ModuleImporter {
    constructor(
        public readonly bundler:Bundler,
        public readonly refined:RefinedModule) {
    }

    addExternalList(name:string, mode:ExternalMode, codepos:ErrorPosition|null, declaration:boolean):BundlerModuleId {
        const childModule = this.bundler.getModuleId(name, mode, null);
        this.refined.imports.push(new ImportInfo((-mode)+'', name, codepos, declaration));
        return childModule;
    }
    addToImportList(mpath:string, apath:string, codepos:ErrorPosition|null, declaration:boolean):BundlerModule{
        const childModule = this.bundler.getModule(apath, mpath);
        this.refined.imports.push(new ImportInfo(childModule.id.apath, mpath, codepos, declaration));
        return childModule;
    }
}

class ParsedImportPath {
    constructor(
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
}

abstract class Transformer<T> {
    public readonly stacks:ts.Node[] = [];
    public readonly refined:RefinedModule;
    public readonly bundler:Bundler;
    public readonly factory:ts.NodeFactory;

    constructor(
        public readonly ctx:ts.TransformationContext,
        public readonly module:BundlerModule,
        public readonly importer:ModuleImporter,
        public readonly sourceFile:ts.SourceFile,
        public readonly delcaration:boolean,
        ) {
        this.bundler = importer.bundler;
        this.refined = importer.refined;
        this.factory = ctx.factory;
    }

    abstract makeIdentifier(name:string):T;
    abstract makePropertyAccess(left:T, right:string):T;
    abstract importLocal(childModule:BundlerModule):T;

    parseImportPath(_node:ts.Node):ParsedImportPath|null {
        if (_node.kind !== ts.SyntaxKind.StringLiteral) {
            if (!this.bundler.suppressDynamicImportErrors) {
                this.refined.errored = true;
                this.module.error(this.getErrorPosition(), IfTsbError.Unsupported, `if-tsb does not support dynamic import for local module, (${ts.SyntaxKind[_node.kind]} is not string literal)`);
            }
            return null;
        }
        const node = _node as ts.StringLiteral;
        const importName = node.text;
        const childModuleMpath = this.module.makeImportModulePath(importName);
        return new ParsedImportPath(importName, childModuleMpath);
    }

    preimport(mpath:string):T{
        const module = this.importer.addExternalList(mpath, ExternalMode.Preimport, this.getErrorPosition(), this.delcaration);
        if (this.delcaration) return this.makeIdentifier(`${this.bundler.globalVarName}_${module.varName}`);
        return this.makePropertyAccess(this.makeIdentifier(this.bundler.globalVarName), module.varName);
    }

    getErrorPosition():ErrorPosition|null{
        for (let i = this.stacks.length-1; i >= 0; i--) {
            let node = this.stacks[i];
            const ori = (node as any).original;
            if (ori) node = ori;
            if (node.pos === -1) continue;
            return this.module.makeErrorPosition(node);
        }
        return this.module.makeErrorPosition(this.sourceFile);
    }
    
    importFromStringLiteral(importPath:ParsedImportPath):T|null{
        const oldsys = this.bundler.sys;
        const sys:ts.System = Object.setPrototypeOf({
            fileExists(path: string): boolean {
                if (getScriptKind(path).kind === ts.ScriptKind.External) return false;
                return oldsys.fileExists(path);
            }
        }, oldsys);

        for (const glob of this.bundler.externals) {
            if (glob.test(importPath.mpath)) return null;
        }
        if (this.bundler.preimportTargets.has(importPath.mpath)) {
            return this.preimport(importPath.mpath);
        }

        let module = ts.nodeModuleNameResolver(importPath.importName, this.module.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
        if (!module.resolvedModule && importPath.importName === '.') 
            module = ts.nodeModuleNameResolver('./index', this.module.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
        const info = module.resolvedModule;
        if (info == null) {
            if (!importPath.importName.startsWith('.')) {
                if (builtin.has(importPath.mpath)) {
                    return this.preimport(importPath.mpath);
                }
                if (!this.bundler.bundleExternals) return null;
            }
            this.refined.errored = true;
            this.module.error(this.getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importPath.importName}' or its corresponding type declarations.`);
            return null;
        }

        if (info.isExternalLibraryImport) {
            if (!this.bundler.bundleExternals) {
                if (this.delcaration) return this.preimport(importPath.mpath);
                return null;
            }
        }
        
        let childmoduleApath = path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(this.bundler.basedir, info.resolvedFileName);
        const kind = getScriptKind(childmoduleApath);
        if (kind.kind === ts.ScriptKind.External) {
            childmoduleApath = childmoduleApath.substr(0, childmoduleApath.length-kind.ext.length+1)+'js';
            if (!fs.existsSync(childmoduleApath)) {
                this.refined.errored = true;
                this.module.error(this.getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importPath.importName}' or its corresponding type declarations.`);
                return null;
            }
        }

        const childModule = this.importer.addToImportList(importPath.mpath, childmoduleApath, this.getErrorPosition(), this.delcaration);
        return this.importLocal(childModule);
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
        const moduleVar = this.makePropertyAccess(this.makeIdentifier(this.bundler.globalVarName), childModule.id.varName);
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
        return this.makePropertyAccess(this.makeIdentifier(this.bundler.globalVarName), childModule.id.varName);
    }
    importFromStringLiteral(importPath:ParsedImportPath):ts.EntityName {
        const importName = super.importFromStringLiteral(importPath);
        if (importName === null) return this.preimport(importPath.mpath);
        return importName;
    }
}

