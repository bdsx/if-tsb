
if (!Date.now) Date.now = ()=>+new Date();

import { Bundler } from './bundler';
import { cacheDir } from './cachedir';
import { BundlerMainContext } from './context';
import { fsp } from './fsp';
import { memcache } from './memmgr';
import { CACHE_MEMORY_DEFAULT, memoryCache } from './module';
import { namelock } from './namelock';
import { PhaseListener, TsConfig } from './types';
import { defaultFormatHost, printDiagnostrics, resolved, time, tsbuild, tswatch } from './util';
import { FilesWatcher } from './watch';
import fs = require('fs');
import path = require('path');
import ts = require('typescript');
import { getMtime } from './mtimecache';
export { TsConfig };

export async function bundle(entries?:string[]|null, output?:string|null|TsConfig):Promise<number> {
    if (entries == null) entries = ['.'];
    const started = process.hrtime();
    const ctx = await BundlerMainContext.getInstance();
    const bundlers:Bundler[] = [];
    for (const p of entries) {
        bundlers.push(...ctx.makeBundlersWithPath(p, output));
    }
    for (const bundler of bundlers) {
        try {
            await bundler.bundle();
            bundler.clear();
        } catch (err) {
            ctx.reportFromCatch(err);
        }
    }
    const duration = process.hrtime(started);
    await ctx.saveCacheJson();
    if (ctx.errorCount !== 0) {
        console.error(ctx.getErrorCountString());
    }
    await namelock.waitAll();
    getMtime.clear();
    return duration[0]*1000+duration[1]/1000000;
}

/**
 * @deprecated use bundle.clearCache
 */
export function clearBundlerCache():Promise<void> {
    return bundle.clearCache();
}

/**
 * @deprecated use bundle.watch
 */
export function bundleWatch(entries:string[], output?:string|null):void {
    bundle.watch(entries, output);
}

export namespace bundle {
    /**
     * read and check tsconfig.json
     * return null if not found
     */
    export function getTsConfig(configPath:string = '.'):TsConfig|null {
        const stat = fs.statSync(configPath);
        if (stat.isDirectory()) {
            configPath = path.join(configPath, 'tsconfig.json');
            if (!fs.existsSync(configPath)) {
                return null;
            }
        } else {
            if (!configPath.endsWith('.json')) {
                return null;
            }
        }
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.error) {
            console.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], defaultFormatHost));
        }
        return configFile.config as TsConfig;
    }
    export function watch(entries?:string[]|null, output?:string|TsConfig|null, opts:PhaseListener = {}):void {
        if (entries == null) entries = ['.'];
        (async()=>{
            const ctx = await BundlerMainContext.getInstance();
            const bundlers:Bundler[] = [];
            for (const p of entries) {
                bundlers.push(...ctx.makeBundlersWithPath(p, output));
            }
            if (bundlers.length === 0) {
                console.log('no targets');
                return;
            }
            
            async function bundle(infos:[Bundler, string[]][]):Promise<void> {
                const started = process.hrtime();
                watcher.pause();
                if (infos.length === 0) {
                    console.log('no changes');
                } else {
                    const reloads = new Set<string>();
    
                    for (const [bundler, modifies] of infos) {
                        if (bundler.verbose) console.log(`${bundler.basedir}: staring`);
                        if (bundler.tsconfig !== null && modifies.indexOf(bundler.tsconfig) !== -1) {
                            watcher.clear(bundler);
                            reloads.add(bundler.tsconfig);
                            continue;
                        }
                        try {
                            await bundler.bundle();
                        } catch (err) {
                            ctx.reportFromCatch(err);
                        }
                        watcher.reset(bundler, bundler.deplist);
                        bundler.clear();
                    }
    
                    for (const tsconfigPath of reloads) {
                        for (const bundler of ctx.makeBundlersWithPath(tsconfigPath, output)) {
                            try {
                                await bundler.bundle();
                            } catch (err) {
                                ctx.reportFromCatch(err);
                            }
                            const files = bundler.deplist;
                            watcher.reset(bundler, files);
                        }
                    }
                }
    
                console.log(`[${time()}] ${ctx.getErrorCountString()}. Watching for file changes.`);
                const duration = process.hrtime(started);
                console.log(`[${time()}] ${(duration[0]*1000+duration[1]/1000000).toFixed(6)}ms`);
                getMtime.clear();

                ctx.errorCount = 0;
                await ctx.saveCacheJson();
                watcher.resume();
                Bundler.clearLibModules();
    
                if (opts.onFinish != null) opts.onFinish();
            }
    
            // avg watch waiting settings
            let clearConsole = false;
            let watchWaiting = 0;
            let watchWaitingCount = 0;
            let cacheMemory = 0;
            let cacheMemoryCount = 0;
            for (const bundler of bundlers) {
                if (bundler.clearConsole) clearConsole = true;
                if (bundler.watchWaiting != null) {
                    watchWaiting += bundler.watchWaiting;
                    watchWaitingCount ++;
                }
                if (bundler.cacheMemory != null) {
                    cacheMemory += bundler.cacheMemory;
                    cacheMemoryCount ++;
                }
            }
            if (watchWaitingCount === 0) watchWaiting = 30;
            else watchWaiting /= watchWaitingCount;
            if (cacheMemoryCount === 0) cacheMemory = CACHE_MEMORY_DEFAULT;
            else cacheMemory /= cacheMemoryCount;
            memcache.maximum = cacheMemory;
    
            // watch
            const watcher = new FilesWatcher<Bundler>(watchWaiting, async(list)=>{
                if (clearConsole) {
                    if (console.clear != null) console.clear();
                    else console.log(`node@${process.version} does not support console.clear`);
                }
                if (opts.onStart != null) opts.onStart();
                console.log(`[${time()}] File change detected. Starting incremental compilation...`);
                bundle([...list]);
            });
            if (opts.onStart != null) opts.onStart();
            console.log(`[${time()}] Starting compilation in watch mode...`);
            bundle(bundlers.map(bundle=>[bundle, []]));
        })();
    }
    /**
     * clear memory cache
     */
    export function clear():void {
        memoryCache.clear();
    }
    /**
     * clear file cache
     */
    export async function clearCache():Promise<void> {
        const filecount = await fsp.deleteAll(cacheDir);
    
        if (filecount === 1) console.log(`${filecount} cache file deleted`);
        else console.log(`${filecount} cache files deleted`);
    }
    
}

/**
 * normal typescript build
 */
export function tscompile(tsconfig: TsConfig, basedir:string = '.', watch?:boolean, opts:PhaseListener&{noWorker?:boolean} = {}): Promise<void> {
    try {
        if (opts.noWorker) throw 0;

        const { Worker } = require('worker_threads') as typeof import('worker_threads');
        const worker = new Worker(path.join(__dirname, '../tsworker.bundle.js'), {
            workerData: {
                tsconfig,
                basedir,
                watch
            }
        });
        if (watch) {
            worker.on('message', message=>{
                switch (message) {
                case 'start':
                    if (opts.onStart != null) opts.onStart();
                    break;
                case 'finish':
                    if (opts.onFinish != null) opts.onFinish();
                    break;
                }
            });
            return resolved;
        } else {
            return new Promise<void>(resolve=>{
                worker.once('message', message=>{
                    resolve();
                });
            });
        }
    } catch (_) {
        if (watch) {
            tswatch(tsconfig, basedir, opts);
        } else {
            if (opts.onStart != null) opts.onStart();
            tsbuild(tsconfig, basedir);
            if (opts.onFinish != null) opts.onFinish();
        }
        return Promise.resolve();
    }
}

export namespace tscompile {
    export function report(diagnostics:readonly ts.Diagnostic[]):void {
        printDiagnostrics(diagnostics);
    }
}
