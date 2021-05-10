import { Bundler } from "./bundler";
import { BundlerModule, BundlerModuleId } from "./module";
import path = require('path');
import fs = require('fs');
import colors = require('colors');
import ts = require('typescript');
import { defaultFormatHost } from "./util";
import { cacheMapPath, CACHE_VERSION, getCacheFilePath } from "./cachedir";
import { IfTsbError, TsConfig } from "./types";
import { namelock } from "./namelock";
import { fsp } from "./fsp";

const defaultCompilerOptions = ts.getDefaultCompilerOptions();

function getOutFileName(options:TsConfig, name:string):string
{
    if (options.output)
    {
        const filename = path.basename(name);
        const ext = path.extname(filename);
        
        const varmap = new Map<string, string>();
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

export class BundlerMainContext
{
    public errorCount = 0;
    private readonly cache:Record<string, Record<string, BundlerModuleId>>;
    private readonly cacheUnusingId:number[] = [];
    private lastCacheId = -1;
    public cacheJsonModified = false;
    private readonly outputs = new Set<string>();

    constructor()
    {
        process.on('exit', ()=>this.saveCacheJson());
        
        try
        {
            const cache = JSON.parse(fs.readFileSync(cacheMapPath, 'utf-8'));;
            if (cache.version !== CACHE_VERSION)
            {
                this.cache = {};
                this.lastCacheId = -1;
                return;
            }
            delete cache.version;
            this.cache = cache;
            let count = 0;
            const using = new Set<number>();
            for (const entryApath in this.cache)
            {
                const cache = this.cache[entryApath];
                for (const apath in cache)
                {
                    const id = cache[apath];
                    cache[apath] = new BundlerModuleId(id.number, id.varName, apath);
                    if (id.number >= 0) {
                        if (using.has(id.number)) {
                            console.error(colors.red(`if-tsb: cache file is corrupted (${apath})`));
                            delete cache[apath];
                        } else {
                            count++;
                            using.add(id.number);
                        }
                    }
                }
            }
            for (let i=0; count !== 0; i++)
            {
                if (using.has(i))
                {
                    count--;
                    this.lastCacheId = i;
                    continue;
                }
                this.cacheUnusingId.push(i);
            }
        }
        catch (err)
        {
            this.cache = {};
            this.lastCacheId = -1;
        }
    }

    saveCacheJson():void
    {
        if (!this.cacheJsonModified) return;
        this.cacheJsonModified = false;

        const output:Record<string, any> = {};
        output.version = CACHE_VERSION;
        for (const entrypath in this.cache)
        {
            const cache = this.cache[entrypath];
            const outcache:Record<string,any> = output[entrypath] = {};
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

    reportFromDiagnostics(diagnostics:readonly ts.Diagnostic[]):void
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

        if (line !== 0) {
            console.log(colors.black(colors.bgWhite(linestr))+' '+lineText);
            console.log(colors.bgWhite(' '.repeat(linestr.length))+' '.repeat(column+1)+colors.red('~'.repeat(width)));
            console.log();   
        }
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
            this.reportMessage(IfTsbError.ModuleNotFound, err.message);
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

    private _removeCache(bundler:Bundler, cache:Record<string, BundlerModuleId>, id:BundlerModuleId):void
    {
        bundler.deleteModuleVarName(id.varName);
        if (id.number < 0) return;
        this.freeCacheId(id.number);
        delete cache[id.apath];
        this.cacheJsonModified = true;

        namelock.lock(id.number);
        function unlock(){ namelock.unlock((id as BundlerModuleId).number); }
        fsp.unlink(getCacheFilePath(id)).then(unlock, unlock);
    }

    clearCache(bundler:Bundler, modules:Map<string, BundlerModule>):void
    {
        const map = this.cache[bundler.output];
        if (!map) return;

        const names = new Set<string>(modules.keys());
        for (const apath in map)
        {
            if (names.has(apath)) continue;
            this._removeCache(bundler, map, map[apath]);
        }
    }


    allocateCacheId():number
    {
        if (this.cacheUnusingId.length === 0)
        {
            return ++this.lastCacheId;
        }
        else
        {
            return this.cacheUnusingId.pop()!;
        }
    }

    freeCacheId(id:number):void
    {
        if (id < 0) return;
        if (id === this.lastCacheId)
        {
            --this.lastCacheId;

            for (;;)
            {
                const idx = this.cacheUnusingId.lastIndexOf(this.lastCacheId);
                if (idx === -1) return;
                this.lastCacheId--;
                const last = this.cacheUnusingId.pop()!;
                if (last === this.lastCacheId) continue;
                this.cacheUnusingId[idx] = last;
            }
        }
        else
        {
            this.cacheUnusingId.push(id);
        }
    }

    getCacheMap(apath:string):Record<string,BundlerModuleId>
    {
        const map = this.cache[apath];
        if (map) return map;
        return this.cache[apath] = {};
    }

    private _makeBundlers(options:TsConfig, basedir:string, tsconfig:string|null, compilerOptions:ts.CompilerOptions):Bundler[]
    {
        for (const key in defaultCompilerOptions)
        {
            if (compilerOptions[key] !== undefined) continue;
            compilerOptions[key] = defaultCompilerOptions[key];
        }

        if (compilerOptions.module !== ts.ModuleKind.CommonJS)
        {
            if (compilerOptions.module === undefined) compilerOptions.module = ts.ModuleKind.None;
            options.bundlerOptions = Object.assign({}, options.bundlerOptions);
            options.bundlerOptions.module = ts.ModuleKind[compilerOptions.module!];
            compilerOptions.module = ts.ModuleKind.CommonJS;
        }

        let entry = options.entry;
        if (entry === undefined)
        {
            const name = './index.ts';
            entry = {[name]: getOutFileName(options, name)};
        }
        else if (typeof entry === 'string')
        {
            entry = {[entry]: getOutFileName(options, entry)};
        }
        else if (entry instanceof Array)
        {
            const out:Record<string, string> = {};
            for (const filepath of entry)
            {
                out[filepath] = getOutFileName(options, filepath);
            }
            entry = out;
        }
        const bundlers:Bundler[] = [];
        for (const entryfile in entry)
        {
            let output = entry[entryfile];
            let newoptions = options;
            if (typeof output === 'object')
            {
                newoptions = Object.assign({}, newoptions);
                newoptions.bundlerOptions = Object.assign({}, output, newoptions.bundlerOptions);
                output = getOutFileName(newoptions, entryfile);
            }
            const resolvedOutput = path.resolve(basedir, output);
            if (this.outputs.has(resolvedOutput))
            {
                this.reportMessage(IfTsbError.Dupplicated, `outputs are dupplicated. ${output}`);
                continue;
            }
            try
            {
                const bundler = new Bundler(this, basedir, resolvedOutput, newoptions, entryfile, [], tsconfig, compilerOptions);
                bundlers.push(bundler);
                const cache = this.cache[bundler.output];
                for (const apath in cache)
                {
                    const moduleId = cache[apath];
                    const oldid = bundler.addModuleVarName(moduleId);
                    if (oldid !== null)
                    {
                        this._removeCache(bundler, cache, oldid);
                        this._removeCache(bundler, cache, moduleId);
                    }
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
                    {});
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
