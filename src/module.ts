import { Bundler } from "./bundler";
import { CACHE_SIGNATURE, getCacheFilePath } from "./cachedir";
import { ErrorPosition } from "./errpos";
import { fsp } from "./fsp";
import { MemoryManager } from "./memmgr";
import { namelock } from "./namelock";
import { WriterStream as FileWriter } from './streamwriter';
import { ExportRule, ExternalMode, IfTsbError } from "./types";
import { changeExt, count, dirnameModulePath, getScriptKind, joinModulePath, SkipableTaskQueue, splitContent } from "./util";
import path = require('path');
import fs = require("fs");
import ts = require("typescript");
import { LineStripper } from "./linestripper";

export const CACHE_MEMORY_DEFAULT = 1024*1024*1024;
export const memoryCache = new MemoryManager<RefinedModule>(CACHE_MEMORY_DEFAULT);
const builtin = new Set<string>(require('module').builtinModules);

export class ImportInfo
{
    constructor(
        public readonly apath:string,
        public readonly mpath:string,
        public readonly codepos: ErrorPosition|null)
    {
    }

    getExternalMode():ExternalMode|null
    {
        if (/^[0-9]$/.test(this.apath)) return -+this.apath;
        return null;
    }

    static stringify(imports:ImportInfo[]):string
    {
        type SerializedInfo = [string, string, number?, number?, number?, string?];
        const out:SerializedInfo[] = [];
        for (const info of imports)
        {
            const line:SerializedInfo = [info.apath, info.mpath];
            if (info.codepos !== null)
            {
                const pos = info.codepos;
                line[2] = pos.line;
                line[3] = pos.column;
                line[4] = pos.width;
                line[5] = pos.lineText;
            }
            out.push(line);
        }
        return JSON.stringify(out);
    }
    static parse(str:string):ImportInfo[]
    {
        const imports = JSON.parse(str);
        const out:ImportInfo[] = [];
        for (const [apath, mpath, line, column, width, lineText] of imports)
        {
            const codepos = line === undefined ? null : new ErrorPosition(line, column, width, lineText);
            out.push(new ImportInfo(apath, mpath, codepos));
        }
        return out;
    }

}

export class RefinedModule
{
    firstLineComment:string|null = null;
    sourceMapOutputLineOffset:number = 0;
    outputLineCount:number;
    imports:ImportInfo[] = [];
    sourceMapText:string|null = null;
    content:string = '';
    size:number;
    errored = false;
    sourceMtime:number;
    tsconfigMtime:number;

    constructor(
        public readonly id:BundlerModuleId)
    {
    }

    private readonly saving = new SkipableTaskQueue;

    checkRelativePath(rpath:string):boolean {
        const lineend = this.content.indexOf('\n');
        if (lineend === -1) return false;
        const matched = this.content.substr(0, lineend).match(/^\/\/ (.+)$/);
        if (matched === null) return false;
        return matched[1] === rpath;
    }

    clear():void
    {
        this.firstLineComment = null;
        this.imports.length = 0;
        this.sourceMapText = null;
        this.content = '';
        this.size = 0;
    }

    save(bundler:Bundler):void
    {
        if (this.errored) return;
        bundler.taskQueue.ref();
        this.saving.run(async()=>{
            try
            {
                namelock.lock(this.id.number);
                const writer = new FileWriter(getCacheFilePath(this.id));
                await writer.write(`${this.sourceMtime}\n`);
                await writer.write(`${this.tsconfigMtime}\n`);
                await writer.write(ImportInfo.stringify(this.imports)+'\n');
                await writer.write(this.firstLineComment ? this.firstLineComment+'\n' : '\n');
                await writer.write(this.sourceMapOutputLineOffset+'\n');
                await writer.write(this.outputLineCount+'\n');
                await writer.write(this.sourceMapText ? this.sourceMapText.replace(/[\r\n]/g, '')+'\n' : '\n');
                await writer.write(this.content);
                await writer.write(CACHE_SIGNATURE);
                await writer.end();
                bundler.taskQueue.unref();
            }
            finally
            {
                namelock.unlock(this.id.number);
            }
        });
    }

    async load():Promise<boolean>
    {
        const cachepath = getCacheFilePath(this.id);
        let content:string;
        try
        {
            namelock.lock(this.id.number);
            content = await fsp.readFile(cachepath);
        }
        finally
        {
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
            source
        ] = splitContent(content, 8, '\n');
        this.sourceMtime = +sourceMtime;
        this.tsconfigMtime = +tsconfigMtime;
        this.imports = imports === '' ? [] : ImportInfo.parse(imports);
        this.firstLineComment = firstLineComment || null;
        this.sourceMapOutputLineOffset = +sourceMapOutputLineOffset;
        this.outputLineCount = +outputLineCount;
        this.sourceMapText = sourceMapText || null;
        this.content = source.substr(0, source.length - CACHE_SIGNATURE.length);
        this.size = this.content.length + 2048;
        return true;
    }
    
    static async getRefined(id:BundlerModuleId, tsconfigMtime:number):Promise<{refined:RefinedModule|null, sourceMtime:number}>
    {
        let sourceMtime = -1;
        _error:try
        {
            const cached = memoryCache.take(id.number);
            if (cached !== undefined)
            {
                const file = await fsp.stat(id.apath);
                sourceMtime = +file.mtime;
                if (cached.sourceMtime !== sourceMtime) break _error;
                if (cached.tsconfigMtime !== tsconfigMtime) break _error;
                return {refined:cached, sourceMtime};
            }
            else
            {
                try
                {
                    namelock.lock(id.number);
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
                }
                finally
                {
                    namelock.unlock(id.number);
                }
                const refined = new RefinedModule(id);
                const loaded = await refined.load();
                if (!loaded) break _error;
                if (refined.sourceMtime !== sourceMtime) break _error;
                if (refined.tsconfigMtime !== tsconfigMtime) break _error;
                return {refined, sourceMtime};
            }
        }
        catch (err)
        {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
        return {refined:null, sourceMtime};
    }
    
}

export enum CheckState
{
    None,Entered,Checked,
}

export class BundlerModule
{
    public readonly id:BundlerModuleId;
    public readonly rpath:string;
    public readonly children:BundlerModule[] = [];
    public readonly importLines:(ErrorPosition|null)[] = [];
    public isAppended = false;
    public isEntry = false;
    public checkState = CheckState.None;

    constructor(
        public readonly bundler:Bundler, 
        public readonly mpath:string,
        apath:string,
        forceModuleName:string|null)
    {
        this.id = bundler.getModuleId(apath, ExternalMode.NoExternal, forceModuleName);
        this.rpath = path.relative(bundler.basedir, apath);
    }

    error(pos:ErrorPosition|null, code:number, message:string):void
    {
        if (pos === null)
        {
            this.bundler.main.report(this.rpath, 0, 0, code, message, '', 0);
        }
        else
        {
            this.bundler.main.report(this.rpath, pos.line, pos.column, code, message, pos.lineText, pos.width);
        }
    }

    makeErrorPosition(node:ts.Node):ErrorPosition|null
    {
        const source = node.getSourceFile();
        if (source === undefined)
        {
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

    errorWithNode(node:ts.Node, code:number, message:string):void
    {
        return this.error(this.makeErrorPosition(node), code, message);
    }

    async refine():Promise<RefinedModule|null>
    {
        let {refined, sourceMtime} = await RefinedModule.getRefined(this.id, this.bundler.tsconfigMtime);
        if (refined !== null) {
            if (refined.checkRelativePath(this.rpath)) {
                return refined;
            }
            // cache changed
        }
        if (sourceMtime === -1) {
            this.error(null, IfTsbError.ModuleNotFound, `Cannot find module ${this.mpath}`);
            return null;
        }

        this.children.length = 0;
        this.importLines.length = 0;

        refined = new RefinedModule(this.id);
        refined.content = `// ${this.rpath}\n`;
        refined.sourceMtime = sourceMtime;
        refined.tsconfigMtime = this.bundler.tsconfigMtime;

        let useDirName = false;
        let useFileName = false;
        let useModule = false;
        let useExports = false;
        const bundler = this.bundler;
        const basedir = bundler.basedir;

        const addExternalList = (name:string, mode:ExternalMode, codepos:ErrorPosition|null)=>{
            const childModule = bundler.getExternal(name, mode);
            refined!.imports.push(new ImportInfo((-mode)+'', name, codepos));
            return childModule;
        };

        const addToImportList = (mpath:string, apath:string, codepos:ErrorPosition|null, forceModuleName?:string)=>{
            const childModule = bundler.getModule(apath, mpath, forceModuleName);
            refined!.imports.push(new ImportInfo(childModule.id.apath, mpath, codepos));
            return childModule;
        };

        const factory = (ctx:ts.TransformationContext)=>{
            const stacks:ts.Node[] = [];

            const preimport = (mpath:string)=>{
                const module = addExternalList(mpath, ExternalMode.Preimport, getErrorPosition());
                return ctx.factory.createPropertyAccessExpression(
                    ctx.factory.createIdentifier(this.bundler.globalVarName),
                    ctx.factory.createIdentifier(module.varName));
            };

            const getErrorPosition = ():ErrorPosition|null=>{
                for (let i = stacks.length-1; i >= 0; i--)
                {
                    let node = stacks[i];
                    const ori = (node as any).original;
                    if (ori) node = ori;
                    if (node.pos === -1) continue;
                    return this.makeErrorPosition(node);
                }
                return this.makeErrorPosition(sourceFile);
            };
    
            const importFromStringLiteral = (_node:ts.Node, base:ts.Node):ts.Node=>{
                if (_node.kind !== ts.SyntaxKind.StringLiteral)
                {
                    if (!bundler.suppressDynamicImportErrors)
                    {
                        refined!.errored = true;
                        this.error(getErrorPosition(), IfTsbError.Unsupported, `if-tsb does not support dynamic import for local module, (${ts.SyntaxKind[_node.kind]} is not string literal)`);
                    }
                    return base;
                }
                const node = _node as ts.StringLiteral;
                const importName = node.text;                
                const oldsys = this.bundler.sys;
                const sys:ts.System = Object.setPrototypeOf({
                    fileExists(path: string): boolean
                    {
                        if (getScriptKind(path).kind === ts.ScriptKind.External) return false;
                        return oldsys.fileExists(path);
                    }
                }, oldsys);

                let childModuleMpath:string;
                if (!this.id.apath.endsWith(`${path.sep}index`) && !this.mpath.endsWith('/index')) {
                    childModuleMpath = joinModulePath(this.mpath, importName);
                } else {
                    const dirmodule = dirnameModulePath(this.mpath);
                    childModuleMpath = joinModulePath(dirmodule, importName);
                }
                if (childModuleMpath === 'path')
                {
                    return preimport('path');
                }
                if (bundler.preimportTargets.has(childModuleMpath))
                {
                    return preimport(childModuleMpath);
                }
                for (const glob of bundler.externals)
                {
                    if (glob.test(childModuleMpath)) return base;
                }

                let module = ts.nodeModuleNameResolver(importName, this.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
                if (!module.resolvedModule && importName === '.') 
                    module = ts.nodeModuleNameResolver(path.join(basedir, 'index'), this.id.apath, this.bundler.tsoptions, sys, this.bundler.moduleResolutionCache);
                const info = module.resolvedModule;
                if (!info)
                {
                    if (!importName.startsWith('.'))
                    {
                        if (builtin.has(childModuleMpath))
                        {
                            return preimport(childModuleMpath);
                        }
                        if (!this.bundler.bundleExternals) return base;
                    }
                    refined!.errored = true;
                    this.error(getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${importName}' or its corresponding type declarations.`);
                    return base;
                }

                if (info.isExternalLibraryImport)
                {
                    if (!this.bundler.bundleExternals) return base;
                }
                
                let childmoduleApath = path.isAbsolute(info.resolvedFileName) ? path.join(info.resolvedFileName) : path.join(bundler.basedir, info.resolvedFileName);
                const kind = getScriptKind(childmoduleApath);
                if (kind.kind === ts.ScriptKind.External)
                {
                    childmoduleApath = childmoduleApath.substr(0, childmoduleApath.length-kind.ext.length+1)+'js';
                    if (!fs.existsSync(childmoduleApath))
                    {
                        refined!.errored = true;
                        this.error(getErrorPosition(), IfTsbError.ModuleNotFound, `Cannot find module '${node.text}' or its corresponding type declarations.`);
                        return base;
                    }
                }
    
                const childModule = addToImportList(childModuleMpath, childmoduleApath, getErrorPosition());
                const moduleVar = ctx.factory.createPropertyAccessExpression(
                    ctx.factory.createIdentifier(this.bundler.globalVarName),
                    ctx.factory.createIdentifier(childModule.id.varName));

                if (childModule.isEntry) return moduleVar;
                return ctx.factory.createCallExpression(
                    moduleVar, [], []);
            };
    
            const visit = (_node:ts.Node):ts.Node=>{
                stacks.push(_node);

                switch (_node.kind)
                {
                case ts.SyntaxKind.Identifier: {
                    const node = _node as ts.Identifier;
                    const parent = stacks[stacks.length-1];
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
                    
                    const ref = node.moduleReference as ts.ExternalModuleReference;
                    if (ref.kind === ts.SyntaxKind.ExternalModuleReference)
                    {
                    const nnode = importFromStringLiteral(ref.expression, _node);
                    if (nnode === _node) return _node;
                    return ctx.factory.createVariableDeclaration(node.name, undefined, undefined, nnode as ts.Expression);
                    }
                    break;
                }
                case ts.SyntaxKind.ImportDeclaration: {
                    const node = _node as ts.ImportDeclaration;
                    return importFromStringLiteral(node.moduleSpecifier, _node);
                }
                case ts.SyntaxKind.CallExpression: {
                    const node = _node as ts.CallExpression;
                    switch (node.expression.kind)
                    {
                    case ts.SyntaxKind.ImportKeyword: {
                        if (node.arguments.length !== 1)
                        {
                            refined!.errored = true;
                            this.error(getErrorPosition(), IfTsbError.Unsupported, `Cannot call import with multiple parameters`);
                            return _node;
                        }
                        return importFromStringLiteral(node.arguments[0], _node);
                    }
                    case ts.SyntaxKind.Identifier: {
                        const identifier = node.expression as ts.Identifier;
                        if (identifier.escapedText === 'require')
                        {
                            return importFromStringLiteral(node.arguments[0], _node);
                        }
                        break;
                    }}
                    break;
                }}
                const ret = ts.visitEachChild(_node, visit, ctx);
                stacks.pop();
                return ret;
            };
            
            return (sourceFile:ts.SourceFile)=>ts.visitNode(sourceFile, visit);
        };

        let filepath = this.id.apath;
        const info = getScriptKind(filepath);
        
        let sourceFile:ts.SourceFile;
        try
        {
            sourceFile = await bundler.getSourceFile(filepath);
        }
        catch (err)
        {
            this.error(null, IfTsbError.ModuleNotFound, err.message+' '+filepath);
            return null;
        }
        
        let sourceMapText:string|null = null;
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
                if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015)
                {
                    refined.content += `${refined.id.varName}(){\n`;
                }
                else
                {
                    refined.content += `${refined.id.varName}:function(){\n`;
                }
                refined.content += `if(${bundler.globalVarName}.${refined.id.varName}.exports) return ${bundler.globalVarName}.${refined.id.varName}.exports;\n`;
                refined.content += `\nreturn ${bundler.globalVarName}.${refined.id.varName}.exports=${sourceFile.text};\n},\n`;
            }
        }
        else
        {
            let content = '';
            const isEntryModule = this.isEntry;
            const compilerHost:ts.CompilerHost = Object.setPrototypeOf({
                getSourceFile(fileName:string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void, shouldCreateNewSourceFile?: boolean) {
                    if (bundler.faster)
                    {
                        if (path.join(fileName) === filepath) return sourceFile;
                        return undefined;
                    }
    
                    return bundler.getSourceFileSync(fileName, languageVersion);
                },
                writeFile(name:string, text:string) {
                    const info = getScriptKind(name);
                    if (info.kind === ts.ScriptKind.JS) {
                        content = text;
                    }
                    else if (info.kind === ts.ScriptKind.External) {
                        if (isEntryModule)
                        {
                            bundler.taskQueue.ref();
                            const output = changeExt(bundler.output, 'd.ts');
                            if (bundler.verbose) console.log(`${output}: writing`);
                            fsp.writeFile(output, text).then(()=>{
                                if (bundler.verbose) console.log(`${output}: writing end`);
                                bundler.taskQueue.unref();
                            }, err=>bundler.taskQueue.error(err));
                        }
                    }
                    else if (info.ext === '.MAP') {
                        sourceMapText = text;
                    }
                },
                fileExists(fileName:string) { return bundler.resolvePath(fileName) === filepath; }
            }, this.bundler.compilerHost);
    
            let diagnostics:ts.Diagnostic[]|undefined = bundler.faster ? undefined : [];
            const program = ts.createProgram([filepath], this.bundler.tsoptions, compilerHost, undefined, diagnostics);
            
            if (diagnostics !== undefined)
            {
                diagnostics.push(...program.getSyntacticDiagnostics(sourceFile));
                // diagnostics.push(...program.getOptionsDiagnostics());
            }
            
            program.emit(
                /*targetSourceFile*/ undefined, 
                /*writeFile*/ undefined, 
                /*cancellationToken*/ undefined, 
                /*emitOnlyDtsFiles*/ undefined, 
                { 
                    after: [factory] 
                });
            
            if (diagnostics !== undefined && diagnostics.length !== 0)
            {
                refined!.errored = true;
                this.bundler.main.reportFromDiagnostics(diagnostics);
            }
            if (!content)
            {
                if (diagnostics === undefined)
                {
                    diagnostics = [...program.getSyntacticDiagnostics(sourceFile)];
                    this.bundler.main.reportFromDiagnostics(diagnostics);
                }
                this.bundler.main.reportMessage(IfTsbError.Unsupported, `Failed to parse ${filepath}`);
                return null;
            }
            
            const stripper = new LineStripper(content);
            refined.firstLineComment = stripper.strip(line=>line.startsWith('#'));
            stricted = (stripper.strip(line=>line==='"use strict";') !== null) || (stripper.strip(line=>line==="'use strict';") !== null);
            stripper.strip(line=>line==='Object.defineProperty(exports, "__esModule", { value: true });');
            stripper.strip(line=>line==='exports.__esModule = true;');
        
            let lastLineIdx = content.lastIndexOf('\n')+1;
            let contentEnd = content.length;
            const lastLine = content.substr(lastLineIdx);
            if (lastLine.startsWith('//# sourceMappingURL='))
            {
                lastLineIdx -= 2;
                if (content.charAt(lastLineIdx) !== '\r') lastLineIdx++;
                contentEnd = lastLineIdx;
            }
            if (this.isEntry)
            {
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
            }
            else
            {
                const useStrict = !bundler.tsoptions.alwaysStrict && stricted;
    
                if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015)
                {
                    refined.content += `${refined.id.varName}(){\n`;
                }
                else
                {
                    refined.content += `${refined.id.varName}:function(){\n`;
                }
                if (useStrict) refined.content += '"use strict";\n';
                
                refined.content += `if(${bundler.globalVarName}.${refined.id.varName}.exports) return ${bundler.globalVarName}.${refined.id.varName}.exports;\n`;
                refined.content += `${bundler.constKeyword} exports=${bundler.globalVarName}.${refined.id.varName}.exports={};\n`;
                if (useModule)
                {
                    if (bundler.tsoptions.target! >= ts.ScriptTarget.ES2015)
                    {
                        refined.content += `const module={exports};\n`;
                    }
                    else
                    {
                        refined.content += `var module={exports:exports};\n`;
                    }
                }
            }
    
            if (useFileName || useDirName)
            {
                const prefix = this.isEntry ? '' : `${bundler.constKeyword} `;
                let rpath = path.relative(path.dirname(bundler.output), this.id.apath);
                if (useFileName)
                {
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__filename=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    addExternalList('path', ExternalMode.Preimport, null);
                    addExternalList('__resolve', ExternalMode.Manual, null);
                    addExternalList('__dirname', ExternalMode.Manual, null);
                }
                if (useDirName)
                {
                    rpath = path.dirname(rpath);
                    if (path.sep !== '/') rpath = rpath.split(path.sep).join('/');
                    refined.content += `${prefix}__dirname=${bundler.globalVarName}.__resolve(${JSON.stringify(rpath)});\n`;
                    addExternalList('path', ExternalMode.Preimport, null);
                    addExternalList('__resolve', ExternalMode.Manual, null);
                    addExternalList('__dirname', ExternalMode.Manual, null);
                }
            }
            refined.content += stripper.strippedComments;
    
            refined.sourceMapOutputLineOffset = count(refined.content, '\n') - stripper.stripedLine;
            refined.content += content.substring(stripper.index, contentEnd);
            refined.content += '\n';
            if (this.isEntry)
            {
                switch (bundler.exportRule)
                {
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
            refined.sourceMapText = sourceMapText;
        }

        refined.outputLineCount = count(refined.content, '\n');
        refined.size = refined.content.length + 2048;
        refined.save(bundler);
        return refined;
    }
}

export class BundlerModuleId
{
    constructor(
        public readonly number:number,
        public varName:string,
        public readonly apath:string)
    {
    }
}
