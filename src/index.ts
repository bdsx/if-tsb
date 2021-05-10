
if (!Date.now) Date.now = ()=>+new Date();

import { Bundler } from './bundler';
import { cacheDir } from './cachedir';
import { BundlerMainContext } from './context';
import { fsp, mkdirRecursiveSync } from './fsp';
import { CACHE_MEMORY_DEFAULT, memoryCache } from './module';
import { namelock } from './namelock';
import { time } from './util';
import { FilesWatcher } from './watch';

export async function clearBundlerCache():Promise<void>
{
    const filecount = await fsp.deleteAll(cacheDir);

    if (filecount === 1) console.log(`${filecount} cache file deleted`);
    else console.log(`${filecount} cache files deleted`);
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
            bundler.clear();
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
    await namelock.waitAll();
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
        
        async function bundle(infos:[Bundler, string[]][]):Promise<void>
        {
            const started = process.hrtime();
            watcher.pause();
            if (infos.length === 0)
            {
                console.log('no changes');
            }
            else
            {
                const reloads = new Set<string>();

                for (const [bundler, modifies] of infos)
                {
                    if (bundler.tsconfig !== null && modifies.indexOf(bundler.tsconfig) !== -1)
                    {
                        watcher.clear(bundler);
                        reloads.add(bundler.tsconfig);
                        continue;
                    }
                    try
                    {
                        await bundler.bundle();
                    }
                    catch (err)
                    {
                        ctx.reportFromCatch(err);
                    }
                    watcher.reset(bundler, bundler.deplist);
                    bundler.clear();
                }

                for (const tsconfigPath of reloads)
                {
                    for (const bundler of ctx.makeBundlersWithPath(tsconfigPath, output))
                    {
                        try
                        {
                            await bundler.bundle();
                        }
                        catch (err)
                        {
                            ctx.reportFromCatch(err);
                        }
                        const files = bundler.deplist;
                        watcher.reset(bundler, files);
                    }
                }
            }

            console.log(`[${time()}] ${ctx.getErrorCountString()}. Watching for file changes.`);
            ctx.errorCount = 0;
            ctx.saveCacheJson();
            watcher.resume();
            Bundler.clearLibModules();

            const duration = process.hrtime(started);
            console.log((duration[0]*1000+duration[1]/1000000).toFixed(6)+'ms');
        }

        // avg watch waiting settings
        let clearConsole = false;
        let watchWaiting = 0;
        let watchWaitingCount = 0;
        let cacheMemory = 0;
        let cacheMemoryCount = 0;
        for (const bundler of bundlers)
        {
            if (bundler.clearConsole) clearConsole = true;
            if (bundler.watchWaiting !== undefined)
            {
                watchWaiting += bundler.watchWaiting;
                watchWaitingCount ++;
            }
            if (bundler.cacheMemory !== undefined)
            {
                cacheMemory += bundler.cacheMemory;
                cacheMemoryCount ++;
            }
        }
        if (watchWaitingCount === 0) watchWaiting = 30;
        else watchWaiting /= watchWaitingCount;
        if (cacheMemoryCount === 0) cacheMemory = CACHE_MEMORY_DEFAULT;
        else cacheMemory /= cacheMemoryCount;
        memoryCache.maximum = cacheMemory;

        // watch
        const watcher = new FilesWatcher<Bundler>(watchWaiting, async(list)=>{
            if (clearConsole)
            {
                if ((console as any).clear) (console as any).clear();
                else console.log(`node@${process.version} does not support console.clear`);
            }
            console.log(`[${time()}] File change detected. Starting incremental compilation...`);
            bundle([...list]);
        });
        console.log(`[${time()}] Starting compilation in watch mode...`);
        bundle(bundlers.map(bundle=>[bundle, []]));
    })();
}
