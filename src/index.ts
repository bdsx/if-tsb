
import ts = require('typescript');
import fs = require('fs');
import path = require('path');
import sourceMap = require('source-map');
import { ConcurrencyQueue, defaultFormatHost, identifierValidating, SkipableTaskQueue, splitContent, FilesWatcher, getScriptKind, changeExt, time, fsp, mkdirRecursiveSync } from './util';
import colors = require('colors');
import { findCacheDir } from './findcachedir';

const cacheDir = findCacheDir('if-tsb') || './.if-tsb.cache';
const cacheMapPath = path.join(cacheDir, 'cachemap.json');
const builtin = new Set<string>(require('module').builtinModules);
const CACHE_SIGNATURE = '\ntsb-kr-cache-0.6';

function getCacheFilePath(id:BundlerModuleId):string
{
    return path.join(cacheDir, id.number+'');
}

export interface BundlerOptions
{
    clearConsole?:boolean;
    verbose?:boolean;
    checkCircularDependency?:boolean;
    suppressDynamicImportErrors?:boolean;
    faster?:boolean;
    watchWaiting?:number;
    globalModuleVarName?:string;
}

export interface TsConfig
{
    entry:string[]|Record<string, string>|string;
    output?:string;

    bundlerOptions?:BundlerOptions;
    
    /**
     * compiler option override.
     * if not define it, it will load [cwd]/tsconfig.json
     */
    compilerOptions?:ts.CompilerOptions;
}

export class BundlerRefined
{
    firstLineComment:string|null;
    sourceMapOutputLineOffset:number;
    outputLineCount:number;
    dependency:string[];
    sourceMapText:string|null;
    content:string;

    constructor(public readonly id:BundlerModuleId)
    {
    }

    private readonly saving = new SkipableTaskQueue;

    save(bundler:Bundler):void
    {
        bundler.taskQueue.ref();
        this.saving.run(async()=>{
            const writer = fs.createWriteStream(getCacheFilePath(this.id), {encoding: 'utf-8'});
            writer.on('error', (err:Error)=>{
                bundler.taskQueue.error(err);
            });
            await write(writer, this.dependency.join(path.delimiter)+'\n');
            await write(writer, this.firstLineComment ? this.firstLineComment+'\n' : '\n');
            await write(writer, this.sourceMapOutputLineOffset+'\n');
            await write(writer, this.outputLineCount+'\n');
            await write(writer, this.sourceMapText ? this.sourceMapText.replace(/[\r\n]/g, '')+'\n' : '\n');
            await write(writer, this.content);
            await write(writer, CACHE_SIGNATURE);
            await writerEnd(writer);
            bundler.taskQueue.unref();
        });
    }

    async load():Promise<void>
    {
        const cachepath = getCacheFilePath(this.id);
        const content = await fsp.readFile(cachepath);
        if (!content.endsWith(CACHE_SIGNATURE)) throw Error('Outdated cache or failed data');
        const splited = splitContent(content, 6, '\n');
        content.endsWith('')
        const deps = splited[0];
        this.dependency = deps === '' ? [] : deps.split(path.delimiter);
        this.firstLineComment = splited[1] || null;
        this.sourceMapOutputLineOffset = +splited[2];
        this.outputLineCount = +splited[3];
        this.sourceMapText = splited[4] || null;
        const source = splited[5];
        this.content = source.substr(0, source.length - CACHE_SIGNATURE.length);
    }
    
    static async loadCacheIfNotModified(id:BundlerModuleId):Promise<BundlerRefined|null>
    {
        try
        {
            const cachepath = getCacheFilePath(id);
            const [cache, file] = await Promise.all([fsp.stat(cachepath), fsp.stat(id.apath)]);
            if (cache.mtime < file.mtime) return null;
            
            const refined = new BundlerRefined(id);
            await refined.load();
            return refined;
        }
        catch (err)
        {
            return null;
        }
    }
    
}

const resolved = Promise.resolve();

function write(writer:fs.WriteStream, data:string):Promise<void>
{
    if (writer.write(data)) return resolved;
    return new Promise(resolve=>writer.once('drain', resolve));
}
function writerEnd(writer:fs.WriteStream):Promise<void>
{
    return new Promise(resolve=>writer.end(resolve));
}

export class Bundler
{
    private readonly names = new Map<string, string>();

    private writer:fs.WriteStream|null = null;
    private mapgen:sourceMap.SourceMapGenerator|null = null;
    private entryModule:BundlerModule|null = null;
    private lineOffset = 0;

    public readonly output:string;
    public readonly outdir:string;
    public readonly globalVarName:string;
    public readonly clearConsole:boolean;
    public readonly watchWaiting:number|undefined;
    public readonly verbose:boolean;
    public readonly checkCircularDependency:boolean;
    public readonly suppressDynamicImportErrors:boolean;
    public readonly faster:boolean;

    public readonly modules = new Map<string, BundlerModule>();
    public readonly taskQueue = new ConcurrencyQueue;
    private readonly sourceFileCache = new Map<string, ts.SourceFile>();

    private csResolve:(()=>void)[] = [];
    private csEntered = false;

    constructor(
        public readonly main:BundlerMainContext,
        public readonly basedir:string, 
        public readonly entry:string, 
        resolvedOutput:string,
        options:TsConfig, 
        public readonly tsconfig:string|null,
        public readonly tsoptions:ts.CompilerOptions)
    {
        if (!this.tsoptions.target)
        {
            this.tsoptions.target = ts.getDefaultCompilerOptions().target!;
        }
        this.output = resolvedOutput;
        this.outdir = path.dirname(this.output);
        const boptions = options.bundlerOptions || {};

        this.globalVarName = boptions.globalModuleVarName || '__tsb';
        this.clearConsole = boptions.clearConsole || false;
        this.verbose = boptions.verbose || false;
        this.checkCircularDependency = boptions.checkCircularDependency || false;
        this.suppressDynamicImportErrors = boptions.suppressDynamicImportErrors || false;
        this.faster = boptions.faster || false;
        this.watchWaiting = boptions.watchWaiting;
    }

    private _lock():Promise<void>
    {
        if (!this.csEntered)
        {
            this.csEntered = true;
            return resolved;
        }

        return new Promise<void>(resolve=>{
            this.csResolve.push(resolve);
        });
    }

    private _unlock():void
    {
        if (this.csResolve.length === 0)
        {
            if (this.csEntered)
            {
                this.csEntered = false;
                return;
            }
            this.main.reportMessage(20000, 'Internal implementation problem');
            return;
        }
        const resolve = this.csResolve.pop()!;
        resolve();
    }

    resolvePath(filepath:string):string
    {
        return path.isAbsolute(filepath) ? path.join(filepath) : path.join(this.basedir, filepath);
    }

    isEntryModule(module:BundlerModule):boolean
    {
        return this.entryModule === module;
    }

    async getSourceFile(filepath:string):Promise<ts.SourceFile>
    {
        let sourceFile = this.sourceFileCache.get(filepath);
        if (sourceFile) return sourceFile;
        
        const source = await fsp.readFile(filepath);
        sourceFile = ts.createSourceFile(filepath, source, this.tsoptions.target!);
        this.sourceFileCache.set(filepath, sourceFile);
        
        return sourceFile;
    }

    getSourceFileSync(filepath:string, languageVersion?: ts.ScriptTarget):ts.SourceFile|undefined
    {
        let sourceFile = this.sourceFileCache.get(filepath);
        if (sourceFile) return sourceFile;
        const source = fs.readFileSync(filepath, 'utf-8');
        sourceFile = ts.createSourceFile(filepath, source, languageVersion || this.tsoptions.target!);
        this.sourceFileCache.set(filepath, sourceFile);

        return sourceFile;
    }

    setModuleVarName(apath:string, varname:string):void
    {
        const oldpath = this.names.get(varname);
        if (oldpath !== undefined)
        {
            this.main.reportMessage(20002, `module name '${varname}' is dupplicated. (${apath}, ${oldpath})`);
            return;
        }
        this.names.set(varname, apath);
    }

    private async _startWriting(firstLineComment:string|null):Promise<void>
    {
        await this._lock();
        if (this.writer === null)
        {
            await fsp.mkdirRecursive(this.outdir);
            this.writer = fs.createWriteStream(this.output, {encoding: 'utf-8'});
            if (firstLineComment !== null)
            {
                await write(this.writer, firstLineComment+'\n');
                this.lineOffset++;
            }
            if (this.tsoptions.alwaysStrict)
            {
                await write(this.writer, '"use strict";\n');
                this.lineOffset++;
            }
            await write(this.writer, `const ${this.globalVarName} = {\n`);
            this.lineOffset++;
        }
        this._unlock();
    }

    allocModuleVarName(apath:string, name:string):string
    {
        name = identifierValidating(name);
        if (this.names.has(name))
        {
          const base = name;
          let num = 2;
          for (;;)
          {
            name = base + num;
            if (!this.names.has(name)) break;
            num++;
          }
        }
        this.names.set(name, apath);
        return name;
    }
    
    async write(refined:BundlerRefined):Promise<void>
    {
        if (this.writer === null)
        {
            await this._startWriting(refined.firstLineComment);
        }
        if (this.verbose) console.log(refined.id.apath+': writing');
        await this._lock();
        await write(this.writer!, refined.content);
        const offset = this.lineOffset + refined.sourceMapOutputLineOffset;
        this.lineOffset += refined.outputLineCount;
        this._unlock();

        if (refined.sourceMapText)
        {
            try
            {
                let rpath = path.relative(this.outdir, refined.id.apath).replace(/\\/g, '/');
                // if (!path.isAbsolute(rpath) && !rpath.startsWith('.')) rpath = './'+rpath;
                const consumer = new sourceMap.SourceMapConsumer(JSON.parse(refined.sourceMapText));
                consumer.eachMapping(entry=>{
                  this.mapgen!.addMapping({
                    generated:{
                      column: entry.generatedColumn,
                      line: entry.generatedLine + offset,
                    },
                    original:{
                      column: entry.originalColumn,
                      line: entry.originalLine,
                    },
                    name: entry.name,
                    source: rpath
                  });
                });
            }
            catch (err)
            {
                console.error(`${refined.id.apath}: Invalid source map (${refined.sourceMapText.substr(0, 16)})`);
            }
        }
    }

    refine(module:BundlerModule, dependency:string[], content:string, selfExports:boolean, sourceMapText:string|null, doNotSave:boolean):BundlerRefined
    {
        let contentBegin = 0;
        let contentEnd = content.length;
        let stripedLine = 0;

        function stripFirstLine(check:string):string|null
        {
          let idx = content.indexOf('\n', contentBegin);
          if (idx == -1) return content;
    
          let cr = 0;
          if (content.charAt(idx-1) === '\r') cr = 1;
          const actual = content.substring(contentBegin, idx-cr);
          if (actual.startsWith(check))
          {
            stripedLine++;
            contentBegin = idx+1;
            return actual;
          }
          return null;
        }

        const firstLineComment = stripFirstLine('#');
        const stricted = stripFirstLine('"use strict";');
        stripFirstLine('Object.defineProperty(exports, "__esModule", { value: true });');
    
        let lastLineIdx = content.lastIndexOf('\n')+1;
        
        const lastLine = content.substr(lastLineIdx);
        if (lastLine.startsWith('//# sourceMappingURL='))
        {
            lastLineIdx -= 2;
            if (content.charAt(lastLineIdx) !== '\r') lastLineIdx++;
            contentEnd = lastLineIdx;
        }

        const useStrict = !this.tsoptions.alwaysStrict && stricted;
        
        let sourceMapOutputLineOffset = 5;
        if (useStrict) sourceMapOutputLineOffset ++;
        if (!selfExports) sourceMapOutputLineOffset += 2;
        sourceMapOutputLineOffset -= stripedLine;

        const refined = new BundlerRefined(module.id);
        refined.dependency = dependency;
        refined.firstLineComment = firstLineComment;
        refined.sourceMapOutputLineOffset = sourceMapOutputLineOffset;
        refined.content = `////////////////////////////////////////////////////////////////
// ${module.rpath}\n${refined.id.varName}(){\n`;
        if (useStrict) refined.content += '"use strict";\n';
        refined.content += `var module = ${this.globalVarName}.${refined.id.varName};
if (module.exports) return module.exports;\n`;
        if (!selfExports) refined.content += `var exports = {};\nmodule.exports = exports;\n`;
        refined.content += content.substring(contentBegin, contentEnd);
        refined.content += '\nreturn module.exports;\n},\n';
        refined.sourceMapText = sourceMapText;
        refined.outputLineCount = refined.content.split('\n').length-1;
        if (!doNotSave) refined.save(this);
        return refined;
    }
        
    async bundle():Promise<boolean>
    {
        if (this.writer !== null) throw Error('bundler is busy');
        if (this.verbose) console.log(this.entry+': starting');
        this.mapgen = new sourceMap.SourceMapGenerator({
            file:'./'+path.basename(this.output)
        });
        this.entryModule = this.add(null, this.entry).module;

        await this.taskQueue.onceEnd();
        if (this.writer === null)
        {
            if (this.verbose) console.log(this.entry+': no writer');
            console.error('no writer');
            return false;
        }
        if (this.verbose) console.log(this.entry+': writing end');
        await write(this.writer!, `\n};\nmodule.exports=${this.globalVarName}.${this.entryModule.id.varName}();\n//# sourceMappingURL=${path.basename(this.output)}.map`);
        await new Promise<void>(resolve=>{
            let counter = 2;
            function done()
            {
                counter --;
                if (counter === 0)
                {
                    resolve();
                }
            }
            this.writer!.end(done);
            fs.writeFile(this.output+'.map', this.mapgen!.toString(), done);
        });
        if (this.verbose) console.log(this.entry+': done');
        this.writer = null;
        this.mapgen = null;
        this.entryModule = null;
        this.modules.clear();
        this.sourceFileCache.clear();

        // const sourceMapContent = await fsp.readFile(this.output+'.map', 'utf-8');
        // const content = await fsp.readFile(this.output, 'utf-8');
        // const validate = await import('sourcemap-validator');
        // const modules:Record<string, string> = {};
        // for (const module of this.modules.values())
        // {
        //     const rpath = path.relative(this.outdir, module.id.apath).replace(/\\/g, '/');
        //     modules[rpath] = await fsp.readFile(module.id.apath, 'utf-8');
        // }
        // validate(content, sourceMapContent, modules);

        return true;
    }

    add(parent:BundlerModule|null, filepath:string):{module:BundlerModule, circularDependency: boolean}
    {
        const apath = path.resolve(this.basedir, filepath);
        let module = this.modules.get(apath);
        if (module)
        {
            if (this.checkCircularDependency)
            {
                while (parent !== null)
                {
                    if (parent === module)
                    {
                        return {module, circularDependency: true};
                    }
                    parent = parent.parent;
                }
            }
            return {module, circularDependency: false,};
        }
        module = new BundlerModule(this, parent, apath);
        this.modules.set(apath, module);
        this.taskQueue.run(()=>module!.load());
        return {module, circularDependency: false};
    }
}

export class BundlerModule
{
    public readonly id:BundlerModuleId;
    public readonly rpath:string;

    constructor(
        public readonly bundler:Bundler, 
        public readonly parent:BundlerModule|null, 
        apath:string)
    {
        this.id = bundler.main.getModuleId(bundler, apath);
        this.rpath = path.relative(bundler.basedir, apath);
    }

    error(node:ts.Node, code:number, message:string):void
    {
        const source = node.getSourceFile();
        if (source === undefined)
        {
            this.bundler.main.reportMessage(code, message);
            return;
        }
        const pos = source.getLineAndCharacterOfPosition(node.getStart());
        const width = node.getWidth();

        const sourceText = source.getFullText();
        const lines = source.getLineStarts();
        const start = lines[pos.line];

        const linenum = pos.line+1;
        const end = linenum < lines.length ? lines[linenum]-1 : sourceText.length;

        const lineText = sourceText.substring(start, end);
        this.bundler.main.report(this.rpath, linenum, pos.character, code, message, lineText, width);
    }

    getParents():BundlerModule[]
    {
        const out:BundlerModule[] = [this];

        let node = this.parent;
        while (node !== null)
        {
            out.push(node);
            node = node.parent;
        }
        return out;
    }

    private async _refine():Promise<BundlerRefined|null>
    {
        let doNotSave = false;
        const bundler = this.bundler;
        const basedir = bundler.basedir;
        const sys:ts.System = {
            getCurrentDirectory():string
            {
                return basedir;
            },
            directoryExists(filepath:string):boolean
            {
                try
                {
                    const stat = fs.statSync(bundler.resolvePath(filepath));
                    return stat.isDirectory();
                }
                catch (err)
                {
                    return false;
                }
            },
            fileExists(filepath:string):boolean
            {
                return fs.existsSync(bundler.resolvePath(filepath));
            },
        } as any;
        Object.setPrototypeOf(sys, ts.sys);

        const dependency:string[] = [];

        const factory = (ctx:ts.TransformationContext)=>{
            const stacks:ts.Node[] = [];

            const findPositionedNode = ():ts.Node=>{
                for (let i = stacks.length-1; i >= 0; i--)
                {
                    let node = stacks[i];
                    const ori  =(node as any).original;
                    if (ori) node = ori;
                    if (node.pos === -1) continue;
                    return node;
                }
                return sourceFile;
            };

            const importFromStringLiteral = (_node:ts.Node, base:ts.Node):ts.Node=>{
                if (_node.kind !== ts.SyntaxKind.StringLiteral)
                {
                    if (!bundler.suppressDynamicImportErrors)
                    {
                        doNotSave = true;
                        this.error(findPositionedNode(), 20001, `if-tsb does not support dynamic import for local module, (${ts.SyntaxKind[_node.kind]} is not string literal)`);
                    }
                    return base;
                }
                const node = _node as ts.StringLiteral;
                let module = ts.nodeModuleNameResolver(node.text, this.id.apath, this.bundler.tsoptions, sys);
                if (!module.resolvedModule && node.text === '.') 
                    module = ts.nodeModuleNameResolver(path.join(basedir, 'index'), this.id.apath, this.bundler.tsoptions, sys);
                const info = module.resolvedModule;
                if (!info)
                {
                    if (builtin.has(node.text)) return base;
                    doNotSave = true;
                    this.error(findPositionedNode(), 2307, `Cannot find module '${node.text}' or its corresponding type declarations.`);
                    return base;
                }    
                if (info.isExternalLibraryImport) return base;
    
                let filepath = info.resolvedFileName;
                const kind = getScriptKind(filepath);
                if (kind.kind === ts.ScriptKind.External)
                {
                    filepath = filepath.substr(0, filepath.length-kind.ext.length+1)+'js';
                    if (!fs.existsSync(filepath))
                    {
                        doNotSave = true;
                        this.error(findPositionedNode(), 2307, `Cannot find module '${node.text}' or its corresponding type declarations.`);
                        return base;
                    }
                }
    
                const {module: source, circularDependency} = this.bundler.add(this, filepath);
                if (circularDependency)
                {
                    let parents = this.getParents();
                    parents.reverse();
                    parents.push(source);
                    doNotSave = true;
                    this.error(findPositionedNode(), 1005, 'Circular dependency '+parents.map(m=>colors.yellow(m.rpath)).join(' → '));
                }
    
                dependency.push(source.id.apath);
        
                return ctx.factory.createCallExpression(
                    ctx.factory.createPropertyAccessExpression(ctx.factory.createIdentifier(this.bundler.globalVarName), ctx.factory.createIdentifier(source.id.varName)), 
                    [], []);;
            };
    
            const visit = (_node:ts.Node):ts.Node=>{
                stacks.push(_node);

                switch (_node.kind)
                {
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
                case ts.SyntaxKind.CallExpression:
                    const node = _node as ts.CallExpression;
                    switch (node.expression.kind)
                    {
                    case ts.SyntaxKind.ImportKeyword: {
                    if (node.arguments.length !== 1)
                    {
                        doNotSave = true;
                        this.error(findPositionedNode(), 1005, `Cannot call import with multiple parameters`);
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
                    }
                    // case ts.SyntaxKind.PropertyAccessExpression:
                    }
                    break;
                }
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
            this.bundler.main.reportMessage(6053, err.message+' '+filepath);
            return null;
        }
        
        let sourceMapText:string|null = null;
        let outputText = '';

        switch (info.kind)
        {
        case ts.ScriptKind.JSON:
            return this.bundler.refine(this, dependency, 'module.exports = '+sourceFile.text+';', true, null, doNotSave);
        case ts.ScriptKind.JS:
            const result = ts.transform(sourceFile, [factory], this.bundler.tsoptions);
            if (result.diagnostics && result.diagnostics.length !== 0)
            { 
                doNotSave = true;
                this.bundler.main.reportFromDiagnostics(result.diagnostics);
            }
            const printer = ts.createPrinter({
                removeComments: false
            });
            const content = printer.printFile(result.transformed[0]);
            return this.bundler.refine(this, dependency, content, false, null, doNotSave);
        }

        const isEntry = bundler.isEntryModule(this);
        const compilerHostBase = ts.createCompilerHost(bundler.tsoptions);
        const compilerHost:ts.CompilerHost = {
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
                    outputText = text;
                }
                else if (info.kind === ts.ScriptKind.External) {
                    if (isEntry)
                    {
                        bundler.taskQueue.ref();
                        if (bundler.verbose) console.log(`${name}: writing`);
                        fsp.writeFile(changeExt(bundler.output, 'd.ts'), text).then(()=>{
                            bundler.taskQueue.unref();
                        }, err=>bundler.taskQueue.error(err));
                    }
                }
                else if (info.ext === '.MAP') {
                    sourceMapText = text;
                }
            },
            getCurrentDirectory() { return sys.getCurrentDirectory(); },
            fileExists(fileName:string) { return bundler.resolvePath(fileName) === filepath; },
            readFile(fileName:string) { return sys.readFile(fileName); },
            directoryExists(dirName:string) { return sys.directoryExists(dirName); },
            getDirectories(dirName:string) { return sys.getDirectories(dirName); }
        } as any;
        Object.setPrototypeOf(compilerHost, compilerHostBase);

        const diagnostics:ts.Diagnostic[]|undefined = bundler.faster ? undefined : [];
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
            doNotSave = true;
            this.bundler.main.reportFromDiagnostics(diagnostics);
        }
        if (!outputText)
        {
            this.bundler.main.reportMessage(6053, `Failed to parse ${filepath}`);
            return null;
        }
        return this.bundler.refine(this, dependency, outputText, false, sourceMapText, doNotSave);
    }

    async refine():Promise<BundlerRefined|null>
    {
        let refined = await BundlerRefined.loadCacheIfNotModified(this.id);
        if (refined !== null)
        {
            for (const dep of refined.dependency)
            {
                this.bundler.add(this, dep);
            }
        }
        else
        {
            refined = await this._refine();
        }
        return refined;
    }

    async load():Promise<void>
    {
        const refined = await this.refine();
        if (refined === null) return;
        await this.bundler.write(refined);
    }
}

export interface BundlerModuleId
{
    number:number;
    varName:string;
    apath:string;
}

export class BundlerMainContext
{
    public errorCount = 0;
    private readonly cache:Record<string, Record<string,BundlerModuleId>>;
    private readonly cacheUnusingId:number[] = [];
    private cahceIdCounter = -1;
    private cacheJsonModified = false;
    private readonly outputs = new Set<string>();

    constructor()
    {
        process.on('exit', ()=>this.saveCacheJson());
        
        try
        {
            this.cache = JSON.parse(fs.readFileSync(cacheMapPath, 'utf-8'));
            let count = 0;
            const using = new Set<number>();
            for (const entrypath in this.cache)
            {
                const cache = this.cache[entrypath];
                for (const apath in cache)
                {
                    count++;
                    const id = cache[apath];
                    id.apath = apath;
                    using.add(id.number);
                }
            }
            for (let i=0; count !== 0; i++)
            {
                if (using.has(i))
                {
                    count--;
                    this.cahceIdCounter = i;
                    continue;
                }
                this.cacheUnusingId.push(i);
            }
            this.cahceIdCounter ++;
        }
        catch (err)
        {
            this.cache = {};
            this.cahceIdCounter = 0;
        }
    }

    saveCacheJson():void
    {
        if (!this.cacheJsonModified) return;
        this.cacheJsonModified = false;

        const output:Record<string, Record<string,BundlerModuleId>> = {};
        for (const entrypath in this.cache)
        {
            const cache = this.cache[entrypath];
            const outcache:Record<string,{varName:string, number:number}> = output[entrypath] = {};
            for (const apath in cache)
            {
                const id = cache[apath];
                outcache[apath] = {
                    number:id.number,
                    varName:id.varName
                };
            }
        }
        fs.writeFileSync(cacheMapPath, JSON.stringify(output), 'utf-8');
    }

    reportFromDiagnostics(diagnostics:ts.Diagnostic[]):void
    {
        this.errorCount++;
        console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, defaultFormatHost));
    }

    /**
     * mimic TS errors
     */
    report(source:string, line:number, column:number, code:number, message:string, lineText:string, width:number):void
    {
        this.errorCount++;
        
        const linestr = line+'';
        console.log(`${colors.cyan(source)}:${colors.yellow(linestr)}:${colors.yellow((column)+'')} - ${colors.red('error')} ${colors.gray('TS'+code+':')} ${message}`);
        console.log();

        console.log(colors.black(colors.bgWhite(linestr))+' '+lineText);
        console.log(colors.bgWhite(' '.repeat(linestr.length))+' '.repeat(column+1)+colors.red('~'.repeat(width)));
        console.log();
    }

    /**
     * mimic TS errors
     */
    reportMessage(code:number, message:string):void
    {
        this.errorCount++;
        console.log(`${colors.red('error')} ${colors.gray(`TS${code}:`)} ${message}`);
    }

    /**
     * mimic TS errors
     */
    reportFromCatch(err:any):boolean
    {
        if (err.code === 'ENOENT')
        {
            this.reportMessage(6053, err.message);
            return true;
        }
        this.errorCount++;
        console.error(err);
        return false;
    }

    getErrorCountString():string
    {
        if (this.errorCount === 1)
            return `Found 1 error`;
        else 
            return `Found ${this.errorCount} errors`;
    }

    getModuleId(bundler:Bundler, apath:string):BundlerModuleId
    {
        let map = this.cache[bundler.entry];
        if (!map) this.cache[bundler.entry] = map = {};

        let id = map[apath];
        if (id === undefined)
        {
            let number:number;
            if (this.cacheUnusingId.length === 0)
            {
                number = this.cahceIdCounter++;
            }
            else
            {
                number = this.cacheUnusingId.pop()!;
            }
            
            let varName = path.basename(apath);
            const dotidx = varName.lastIndexOf('.');
            if (dotidx !== -1) varName = varName.substr(0, dotidx);
            if (varName === 'index')
            {
                varName = path.basename(path.dirname(apath));
            }
            
            id = {
                number: number,
                apath,
                varName: bundler.allocModuleVarName(apath, varName)
            };
            map[apath] = id;
            this.cacheJsonModified = true;
        }
        return id;
    }

    private _makeBundlers(options:TsConfig, basedir:string, tsconfig:string|null, compilerOptions:ts.CompilerOptions):Bundler[]
    {
        const varmap = new Map<string, string>();

        function getOutFileName(name:string):string
        {
            if (options.output)
            {
                const filename = path.basename(name);
                const ext = path.extname(filename);
                varmap.set('name', filename.substr(0, filename.length - ext.length));
                varmap.set('dirname', path.dirname(name));

                const regex = /\[.+\]/g;
                return options.output.replace(regex, matched=>{
                    return varmap.get(matched) || process.env[matched] || '';
                });
            }
            else
            {
                const ext = path.extname(name);
                return name.substr(0, name.length - ext.length)+'.bundle.js';
            }
        }
        let entry = options.entry;
        if (entry === undefined)
        {
            const name = './index.ts';
            entry = {[name]: getOutFileName(name)};
        }
        else if (typeof entry === 'string')
        {
            entry = {[entry]: getOutFileName(entry)};
        }
        else if (entry instanceof Array)
        {
            const out:Record<string, string> = {};
            for (const filepath of entry)
            {
                out[filepath] = getOutFileName(filepath);
            }
            entry = out;
        }
        const bundlers:Bundler[] = [];
        for (const entryfile in entry)
        {
            const output = entry[entryfile];
            const resolvedOutput = path.resolve(basedir, output);
            if (this.outputs.has(resolvedOutput))
            {
                this.reportMessage(6053, `outputs are dupplicated. ${output}`);
                continue;
            }
            try
            {
                const bundler = new Bundler(this, basedir, entryfile, resolvedOutput, options, tsconfig, compilerOptions);
                bundlers.push(bundler);
                const cache = this.cache[bundler.entry];
                for (const apath in cache)
                {
                    bundler.setModuleVarName(apath, cache[apath].varName);
                }
            }
            catch (err)
            {
                this.reportFromCatch(err);
            }
        }
        return bundlers;
    }

    makeBundlersWithPath(configPath:string, output?:string):Bundler[]
    {
        configPath = path.resolve(configPath);
        let basedir:string;
        try
        {
            const stat = fs.statSync(configPath);
            if (stat.isDirectory())
            {
                basedir = configPath;
                const npath = path.join(configPath, 'tsconfig.json');
                if (fs.existsSync(npath))
                {
                    configPath = npath;
                }
                else
                {
                    configPath = path.join(configPath, 'index.ts');
                }
            }
            else
            {
                basedir = path.dirname(configPath);
            }

            if (configPath.endsWith('.json'))
            {
                const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
                const tsoptions = ts.parseJsonConfigFileContent(configFile.config, ts.sys, './').options;
        
                if (configFile.error)
                {
                    console.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], defaultFormatHost));
                }
                const options = configFile.config as TsConfig;
                if (output) options.output = output;
                return this._makeBundlers(
                    options, 
                    basedir,
                    configPath,
                    tsoptions);
            }
            else
            {
                return this._makeBundlers(
                    { entry: configPath, output }, 
                    basedir,
                    null,
                    ts.getDefaultCompilerOptions());
            }
        }
        catch (err)
        {
            this.reportFromCatch(err);
            return [];
        }
    }

    makeBundlers(options:TsConfig):Bundler[]
    {
        let tsoptions:ts.CompilerOptions;
        let tsconfig:string|null = null;
        const basedir = process.cwd();
        
        try
        {
            if (options.compilerOptions)
            {
                tsoptions = options.compilerOptions;
            }
            else
            {
                tsconfig = path.resolve('./tsconfig.json');
                const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile);
                tsoptions = ts.parseJsonConfigFileContent(configFile.config, ts.sys, './').options;
            }
        }
        catch (err)
        {
            this.reportFromCatch(err);
            return [];
        }

        return this._makeBundlers(options, basedir, tsconfig, tsoptions);
    }
}

export async function bundle(entries:string[], output?:string):Promise<void>
{
    mkdirRecursiveSync(cacheDir);
    const started = process.hrtime();
    const ctx = new BundlerMainContext;
    const bundlers:Bundler[] = [];
    for (const p of entries)
    {
        bundlers.push(...ctx.makeBundlersWithPath(p, output));
    }
    for (const bundler of bundlers)
    {
        try
        {
            await bundler.bundle();
        }
        catch (err)
        {
            ctx.reportFromCatch(err);
        }
    }
    ctx.saveCacheJson();
    if (ctx.errorCount !== 0)
    {
        console.error(ctx.getErrorCountString());
    }
    const duration = process.hrtime(started);
    console.log((duration[0]*1000+duration[1]/1000000).toFixed(6)+'ms');
}

export function bundleWatch(entries:string[], output?:string):void
{
    mkdirRecursiveSync(cacheDir);
    (async()=>{
        const ctx = new BundlerMainContext;
        const bundlers:Bundler[] = [];
        for (const p of entries)
        {
            bundlers.push(...ctx.makeBundlersWithPath(p, output));
        }
        if (bundlers.length === 0) return;
        
        async function bundle(bundlers:Bundler[]):Promise<void>
        {
            const started = process.hrtime();
            watcher.pause();
            if (bundlers.length === 0)
            {
                console.log('no changes');
            }
            else
            {
                for (const bundler of bundlers)
                {
                    try
                    {
                        await bundler.bundle();
                    }
                    catch (err)
                    {
                        ctx.reportFromCatch(err);
                    }
                    const files = [...bundler.modules.keys()];
                    if (bundler.tsconfig !== null) files.push(bundler.tsconfig);
                    watcher.watch(bundler, files);
                }
            }

            console.log(`[${time()}] ${ctx.getErrorCountString()}. Watching for file changes.`);
            ctx.errorCount = 0;
            ctx.saveCacheJson();
            watcher.resume();

            const duration = process.hrtime(started);
            console.log((duration[0]*1000+duration[1]/1000000).toFixed(6)+'ms');
        }

        let clearConsole = false;
        let watchWaiting = 0;
        let watchWaitingCount = 0;
        for (const bundler of bundlers)
        {
            if (bundler.clearConsole) clearConsole = true;
            if (bundler.watchWaiting !== undefined)
            {
                watchWaiting += bundler.watchWaiting;
                watchWaitingCount ++;
            }
        }
        if (watchWaitingCount === 0) watchWaiting = 30;
        else watchWaiting /= watchWaitingCount;

        const watcher = new FilesWatcher<Bundler>(watchWaiting, async(list)=>{
            if (clearConsole)
            {
                if ((console as any).clear) (console as any).clear();
                else console.log(`node@${process.version} does not support console.clear`);
            }
            console.log(`[${time()}] File change detected. Starting incremental compilation...`);
            bundle([...list].map(items=>items[0]));
        });
        console.log(`[${time()}] Starting compilation in watch mode...`);
        bundle(bundlers);
    })();
}
