
import ts = require('typescript');
import fs = require('fs');
import path = require('path');
import sourceMap = require('source-map');
import { ConcurrencyQueue, defaultFormatHost, identifierValidating, SkipableTaskQueue, splitContent, FilesWatcher, getScriptKind } from './util';
import findCacheDir = require('find-cache-dir');
import colors = require('colors');
import { writer } from 'repl';

const cacheDir = findCacheDir({name: 'tsb-kr'}) || './.tsb-kr.cache';
const cacheMapPath = path.join(cacheDir, 'cachemap.json');

const builtin = new Set<string>(require('module').builtinModules);

const CACHE_SIGNATURE = 'tsb-kr-cache-0.4';

function getCacheFilePath(id:TsBundlerModuleId):string
{
    return path.join(cacheDir, id.number+'');
}

export interface TsBundlerOptions
{
    clearConsole?:boolean;
    verbose?:boolean;
    entry:string[]|Record<string, string>|string;
    globalModuleVarName?:string;
    output?:string;

    /**
     * compiler option override.
     * if not define it, it will load [cwd]/tsconfig.json
     */
    compilerOptions?:ts.CompilerOptions;
}

export class TsBundlerRefined
{
    firstLineComment:string|null;
    sourceMapOutputLineOffset:number;
    outputLineCount:number;
    dependency:string[];
    sourceMapText:string|null;
    content:string;

    constructor(public readonly id:TsBundlerModuleId)
    {
    }

    private readonly saving = new SkipableTaskQueue;

    save(bundler:TsBundler):void
    {
        bundler.taskQueue.ref();
        this.saving.run(async()=>{
            const writer = fs.createWriteStream(getCacheFilePath(this.id), 'utf-8');
            writer.on('error', err=>{
                bundler.taskQueue.error(err);
            });
            await write(writer, CACHE_SIGNATURE+'\n');
            await write(writer, this.dependency.join(path.delimiter)+'\n');
            await write(writer, this.firstLineComment ? this.firstLineComment+'\n' : '\n');
            await write(writer, this.sourceMapOutputLineOffset+'\n');
            await write(writer, this.outputLineCount+'\n');
            await write(writer, this.sourceMapText ? this.sourceMapText.replace(/[\r\n]/g, '')+'\n' : '\n');
            await write(writer, this.content);
            await writerEnd(writer);
            bundler.taskQueue.unref();
        });
    }

    async load():Promise<void>
    {
        const cachepath = getCacheFilePath(this.id);
        const content = await fs.promises.readFile(cachepath, 'utf-8');
        const splited = splitContent(content, 7, '\n');
        const version = splited[0];
        if (CACHE_SIGNATURE !== version) throw Error('Outdated cache');
        const deps = splited[1];
        this.dependency = deps === '' ? [] : deps.split(path.delimiter);
        this.firstLineComment = splited[2] || null;
        this.sourceMapOutputLineOffset = +splited[3];
        this.outputLineCount = +splited[4];
        this.sourceMapText = splited[5] || null;
        this.content = splited[6];
    }
    
    static async loadCacheIfNotModified(id:TsBundlerModuleId):Promise<TsBundlerRefined|null>
    {
        try
        {
            const cachepath = getCacheFilePath(id);
            const [cache, file] = await Promise.all([fs.promises.stat(cachepath), fs.promises.stat(id.apath)]);
            if (cache.mtime < file.mtime) return null;
            
            const refined = new TsBundlerRefined(id);
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

export class TsBundler
{
    private readonly names = new Set<string>();

    private writer:fs.WriteStream|null = null;
    private lineOffset = 0;
    private mapgen:sourceMap.SourceMapGenerator|null = null;
    private entryModule:TsBundlerModule|null = null;

    public readonly output:string;
    public readonly outdir:string;
    public readonly globalVarName:string;
    public readonly clearConsole:boolean;
    public readonly verbose:boolean;

    public readonly modules = new Map<string, TsBundlerModule>();
    public readonly taskQueue = new ConcurrencyQueue;

    constructor(
        public readonly main:TsBundlerMainContext,
        public readonly entry:string, 
        resolvedOutput:string,
        options:TsBundlerOptions, 
        public readonly tsconfig:string|null,
        public readonly tsoptions:ts.CompilerOptions)
    {
        if (!this.tsoptions.target)
        {
            this.tsoptions.target = ts.getDefaultCompilerOptions().target!;
        }
        this.output = resolvedOutput;
        this.outdir = path.dirname(this.output);
        this.globalVarName = options.globalModuleVarName || '__tsb';
        this.clearConsole = options.clearConsole || false;
        this.verbose = options.verbose || false;
    }

    isEntryModule(module:TsBundlerModule):boolean
    {
        return this.entryModule === module;
    }

    private async _startWriting(firstLineComment:string|null):Promise<void>
    {
        await fs.promises.mkdir(this.outdir, {recursive:true});
        this.writer = fs.createWriteStream(this.output, 'utf-8');
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

    allocModuleVarName(name:string):string
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
        this.names.add(name);
        return name;
    }
    
    async write(refined:TsBundlerRefined):Promise<void>
    {
        if (this.writer === null)
        {
            await this._startWriting(refined.firstLineComment);
        }
        if (this.verbose) console.log(refined.id.apath+': writing');
        await write(this.writer!, refined.content);

        if (refined.sourceMapText)
        {
            try
            {
                const rpath = path.relative(this.outdir, refined.id.apath).replace(/\\/g, '/');
                const offset = this.lineOffset + refined.sourceMapOutputLineOffset;
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
        this.lineOffset += refined.outputLineCount;
    }

    refine(module:TsBundlerModule, dependency:string[], content:string, selfExports:boolean, sourceMapText:string|null):TsBundlerRefined
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
        let outputLineCount = sourceMapOutputLineOffset + 3 + content.split('\n').length;
        sourceMapOutputLineOffset -= stripedLine;

        const refined = new TsBundlerRefined(module.id);
        refined.dependency = dependency;
        refined.firstLineComment = firstLineComment;
        refined.sourceMapOutputLineOffset = sourceMapOutputLineOffset;
        refined.outputLineCount = outputLineCount;
        refined.content = `////////////////////////////////////////////////////////////////
// ${module.rpath}\n${refined.id.varName}(){\n`;
        if (useStrict) refined.content += '"use strict";\n';
        refined.content += `var module = ${this.globalVarName}.${refined.id.varName};
if (module.exports) return module.exports;\n`;
        if (!selfExports) refined.content += `var exports = {};\nmodule.exports = exports;\n`;
        refined.content += content.substring(contentBegin, contentEnd);
        refined.content += '\nreturn module.exports;\n},\n';
        refined.sourceMapText = sourceMapText;
        refined.save(this);
        return refined;
    }
        
    async bundle():Promise<boolean>
    {
        if (this.writer !== null) throw Error('bundler is busy');
        this.mapgen = new sourceMap.SourceMapGenerator({
            file:'./'+path.basename(this.output)
        });
        this.modules.clear();
        this.entryModule = this.add(this.entry);
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
        return true;
    }

    add(filepath:string):TsBundlerModule
    {
        const apath = path.resolve(filepath);
        let file = this.modules.get(apath);
        if (file) return file;
        file = new TsBundlerModule(this, apath);
        this.modules.set(apath, file);
        this.taskQueue.run(()=>file!.load());
        return file;
    }
}

export class TsBundlerModule
{
    public readonly id:TsBundlerModuleId;
    public readonly rpath:string;

    constructor(public readonly bundler:TsBundler, apath:string)
    {
        this.id = bundler.main.getModuleId(bundler, apath);
        this.rpath = path.relative(bundler.main.cwd, apath);
    }

    error(node:ts.Node, code:number, message:string):void
    {
        const source = node.getSourceFile();
        const pos = source.getLineAndCharacterOfPosition(node.pos);
        const width = node.getWidth();

        const sourceText = source.getFullText();
        const lines = source.getLineStarts();
        const start = lines[pos.line];

        const linenum = pos.line+1;
        const end = linenum < lines.length ? lines[linenum]-1 : sourceText.length;

        const lineText = sourceText.substring(start, end);
        this.bundler.main.report(this.rpath, linenum, pos.character+1, code, message, lineText, width);
    }

    private async _refine():Promise<TsBundlerRefined|null>
    {
        const dependency:string[] = [];
        const importFromStringLiteral = (_node:ts.Node, base:ts.Node, ctx:ts.TransformationContext):ts.Node=>{
            if (_node.kind !== ts.SyntaxKind.StringLiteral)
            {
                this.error(_node, 1005, `Does not support dynamic import, (${ts.SyntaxKind[_node.kind]} is not string literal)`);
                return base;
            }
            const node = _node as ts.StringLiteral;
            let module = 
                ts.nodeModuleNameResolver(node.text, this.id.apath, this.bundler.tsoptions, ts.sys);
            if (!module.resolvedModule && node.text === '.') 
                module = ts.nodeModuleNameResolver('./index', this.id.apath, this.bundler.tsoptions, ts.sys) ;
            const info = module.resolvedModule;
            if (!info)
            {
                if (builtin.has(node.text)) return base;
                this.error(_node, 2307, `Cannot find module '${node.text}' or its corresponding type declarations.`);
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
                    this.error(_node, 2307, `Cannot find module '${node.text}' or its corresponding type declarations.`);
                    return base;
                }
            }

            const source = this.bundler.add(filepath);
            dependency.push(source.id.apath);
    
            return ctx.factory.createCallExpression(
                ctx.factory.createPropertyAccessExpression(ctx.factory.createIdentifier(this.bundler.globalVarName), ctx.factory.createIdentifier(source.id.varName)), 
                [], []);;
        };

        const factory:ts.TransformerFactory<ts.SourceFile> = (ctx:ts.TransformationContext)=>{
            const visit = (_node:ts.Node):ts.Node=>{
                switch (_node.kind)
                {
                case ts.SyntaxKind.ImportEqualsDeclaration: {
                    const node = _node as ts.ImportEqualsDeclaration;
                    
                    const ref = node.moduleReference as ts.ExternalModuleReference;
                    if (ref.kind === ts.SyntaxKind.ExternalModuleReference)
                    {
                    const nnode = importFromStringLiteral(ref.expression, _node, ctx);
                    if (nnode === _node) return _node;
                    return ctx.factory.createVariableDeclaration(node.name, undefined, undefined, nnode as ts.Expression);
                    }
                    break;
                }
                case ts.SyntaxKind.ImportDeclaration: {
                    const node = _node as ts.ImportDeclaration;
                    return importFromStringLiteral(node.moduleSpecifier, node, ctx);
                }
                case ts.SyntaxKind.CallExpression:
                    const node = _node as ts.CallExpression;
                    switch (node.expression.kind)
                    {
                    case ts.SyntaxKind.ImportKeyword: {
                    if (node.arguments.length !== 1)
                    {
                        this.error(_node, 1005, `Cannot call import with multiple parameters`);
                        return _node;
                    }
                    return importFromStringLiteral(node.arguments[0], _node, ctx);
                    }
                    case ts.SyntaxKind.Identifier: {
                    const identifier = node.expression as ts.Identifier;
                    if (identifier.escapedText === 'require')
                    {
                        return importFromStringLiteral(node.arguments[0], _node, ctx);
                    }
                    break;
                    }
                    // case ts.SyntaxKind.PropertyAccessExpression:
                    }
                    break;
                }
                return ts.visitEachChild(_node, visit, ctx);
            };
            return sourceFile=>ts.visitNode(sourceFile, visit);
        };

        let filepath = this.id.apath;
        const info = getScriptKind(filepath);
        
        let source:string;
        try
        {
            source = await fs.promises.readFile(filepath, 'utf-8');
        }
        catch (err)
        {
            this.bundler.main.reportMessage(err.message);
            return null;
        }

        const sourceFile = ts.createSourceFile(filepath, source, this.bundler.tsoptions.target!, undefined, info.kind);
        let sourceMapText:string|null = null;
        let outputText = '';

        switch (info.kind)
        {
        case ts.ScriptKind.JSON:
            return this.bundler.refine(this, dependency, 'module.exports = '+source+';', true, null);
        case ts.ScriptKind.JS:
            const result = ts.transform(sourceFile, [factory], this.bundler.tsoptions);
            if (result.diagnostics && result.diagnostics.length !== 0)
            { 
                this.bundler.main.reportFromDiagnostics(result.diagnostics);
            }
            const printer = ts.createPrinter({
                removeComments: false
            });
            const content = printer.printFile(result.transformed[0]);
            return this.bundler.refine(this, dependency, content, false, null);
        }

        const bundler = this.bundler;
        const isEntry = bundler.isEntryModule(this);
        const compilerHost:ts.CompilerHost = {
            getSourceFile(fileName) { 
                return path.normalize(fileName) === filepath ? sourceFile : undefined;
            },
            writeFile(name, text) {
                const info = getScriptKind(name);
                if (info.kind === ts.ScriptKind.JS) {
                    outputText = text;
                }
                else if (info.kind === ts.ScriptKind.External) {
                    if (isEntry)
                    {
                        bundler.taskQueue.ref();
                        if (bundler.verbose) console.log(`${name}: writing`);
                        fs.promises.writeFile(name, text).then(()=>{
                            bundler.taskQueue.unref();
                        }, err=>bundler.taskQueue.error(err));
                    }
                }
                else if (info.ext === '.MAP') {
                    sourceMapText = text;
                }
            },
            getDefaultLibFileName() { return 'lib.d.ts'; },
            useCaseSensitiveFileNames() { return false; },
            getCanonicalFileName(fileName) { return fileName; },
            getCurrentDirectory() { return ""; },
            getNewLine() { return ts.sys.newLine; },
            fileExists(fileName) { return path.normalize(fileName) === filepath; },
            readFile() { return ""; },
            directoryExists() { return true; },
            getDirectories() { return []; }
        };
        const diagnostics:ts.Diagnostic[] = [];
        const program = ts.createProgram([filepath], this.bundler.tsoptions, compilerHost, undefined, diagnostics);
        
        program.emit(
            /*targetSourceFile*/ undefined, 
            /*writeFile*/ undefined, 
            /*cancellationToken*/ undefined, 
            /*emitOnlyDtsFiles*/ undefined, 
            { after: [factory] });
        
        if (diagnostics.length !== 0)
        {
            this.bundler.main.reportFromDiagnostics(diagnostics);
        }
        if (!outputText)
        {
            this.bundler.main.reportMessage(`Failed to parse ${filepath}`);
            return null;
        }
        return this.bundler.refine(this, dependency, outputText, false, sourceMapText);
    }

    async refine():Promise<TsBundlerRefined|null>
    {
        let refined = await TsBundlerRefined.loadCacheIfNotModified(this.id);
        if (refined !== null)
        {
            for (const dep of refined.dependency)
            {
                this.bundler.add(dep);
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

export interface TsBundlerModuleId
{
    number:number;
    varName:string;
    apath:string;
}

export class TsBundlerMainContext
{
    public errorCount = 0;
    public readonly cwd = process.cwd();
    private readonly cache:Record<string, Record<string,TsBundlerModuleId>>;
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
            for (const outpath in this.cache)
            {
                const cache = this.cache[outpath];
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
        fs.mkdirSync(cacheDir, {recursive: true});

        const output:Record<string, Record<string,TsBundlerModuleId>> = {};
        for (const outpath in this.cache)
        {
            const cache = this.cache[outpath];
            const outcache:Record<string,{varName:string, number:number}> = output[outpath] = {};
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
    reportMessage(message:string):void
    {
        console.log(`${colors.red('error')} ${colors.gray('TS6053:')} ${message}`);
    }

    /**
     * mimic TS errors
     */
    reportFromCatch(err:any):boolean
    {
        this.errorCount++;
        if (err.code === 'ENOENT')
        {
            this.reportMessage(err.message);
            return true;
        }
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

    getModuleId(bundler:TsBundler, apath:string):TsBundlerModuleId
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
            
            id = {
                number: number,
                apath,
                varName: bundler.allocModuleVarName(varName)
            };
            map[apath] = id;
            this.cacheJsonModified = true;
        }
        return id;
    }

    private _makeBundlers(options:TsBundlerOptions, tsconfig:string|null, compilerOptions:ts.CompilerOptions):TsBundler[]
    {
        const varmap = new Map<string, string>();

        function getOutFileName(name:string):string
        {
            if (options.output)
            {
                const filename = path.basename(name);
                const ext = path.extname(filename);
                varmap.set('name', filename.substr(0, filename.length - ext.length));

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
        if (typeof entry === 'string')
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
        const bundlers:TsBundler[] = [];
        for (const entryfile in entry)
        {
            const output = entry[entryfile];
            const resolvedOutput = path.resolve(output);
            if (this.outputs.has(resolvedOutput))
            {
                this.reportMessage(`outputs are dupplicated. ${output}`);
                continue;
            }
            try
            {
                const bundler = new TsBundler(this, entryfile, resolvedOutput, options, tsconfig, compilerOptions);
                bundlers.push(bundler);
            }
            catch (err)
            {
                this.reportFromCatch(err);
            }
        }
        return bundlers;
    }

    makeBundlersWithPath(configPath:string, output?:string):TsBundler[]
    {
        configPath = path.resolve(configPath);
        try
        {
            const stat = fs.statSync(configPath);
            if (stat.isDirectory())
            {
                configPath = path.join(configPath, 'tsconfig.json');
            }
            if (configPath.endsWith('.json'))
            {
                const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
                const tsoptions = ts.parseJsonConfigFileContent(configFile.config, ts.sys, './').options;
        
                if (configFile.error)
                {
                    console.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], defaultFormatHost));
                }
                const options = configFile.config as TsBundlerOptions;
                if (output) options.output = output;
                return this._makeBundlers(
                    options, 
                    configPath,
                    tsoptions);
            }
            else
            {
                return this._makeBundlers(
                    { entry: configPath, output }, 
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

    makeBundlers(options:TsBundlerOptions):TsBundler[]
    {
        let tsoptions:ts.CompilerOptions;
        let tsconfig:string|null = null;
        
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

        return this._makeBundlers(options, tsconfig, tsoptions);
    }
}

export async function bundle(entries:string[], output?:string):Promise<void>
{
    const ctx = new TsBundlerMainContext;
    const bundlers:TsBundler[] = [];
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
}

function time():string
{
    return new Date().toLocaleTimeString();
}

export function bundleWatch(entries:string[], output?:string):void
{
    (async()=>{
        const ctx = new TsBundlerMainContext;
        const bundlers:TsBundler[] = [];
        for (const p of entries)
        {
            bundlers.push(...ctx.makeBundlersWithPath(p, output));
        }
        if (bundlers.length === 0) return;
        
        async function bundle(bundlers:TsBundler[]):Promise<void>
        {
            if (bundlers.length === 0)
            {
                console.log('no changes');
            }
            else
            {
                watcher.pause();
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
                watcher.resume();
            }

            console.log(`[${time()}] ${ctx.getErrorCountString()}. Watching for file changes.`);
            ctx.errorCount = 0;
            ctx.saveCacheJson();
        }

        const clearConsole = bundlers.some(bundler=>bundler.clearConsole);

        const watcher = new FilesWatcher<TsBundler>(async(list)=>{
            if (clearConsole) console.clear();
            console.log(`[${time()}] File change detected. Starting incremental compilation...`);
            bundle([...list].map(items=>items[0]));
        });
        console.log(`[${time()}] Starting compilation in watch mode...`);
        bundle(bundlers);
    })();
}
