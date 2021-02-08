
import path = require('path');
import { fsp } from './fsp';
import { getWorkerThreadModule, WorkerThread } from './workertype';


export abstract class SourceMap {
    constructor() {
    }

    abstract append(apath:string, sourceMapText:string, offset:number):void;
    abstract save():Promise<void>;

    static newInstance(output:string):SourceMap {
        try {
            const module = getWorkerThreadModule();
            return new SourceMapWorker(output, module);
        } catch (err) {
            return new SourceMapDirect(output);
        }
    }
}

class SourceMapWorker extends SourceMap {
    private readonly worker:WorkerThread.Worker;
    constructor(output:string, workerModule:typeof WorkerThread) {
        super();
        try {
            const { Worker } = workerModule;
            this.worker = new Worker(path.join(__dirname, '../worker.bundle.js'), {workerData: output});
        } catch (err) {
        }
    }

    append(apath:string, sourceMapText:string, offset:number):void {
        this.worker.postMessage([apath, sourceMapText, offset]);
    }

    save():Promise<void> {
        this.worker.postMessage(null);
        return new Promise(resolve=>{
            this.worker.once('message', resolve);
            this.worker.unref();
        })
    }
}
class SourceMapDirect extends SourceMap {
    private readonly module:typeof import('source-map') = require('source-map');
    
    private readonly outdir:string;
    private readonly mapgen:import('source-map').SourceMapGenerator;

    constructor(private readonly output:string) {
        super();
        this.outdir = path.dirname(output);

        this.mapgen = new this.module.SourceMapGenerator({
            file:'./'+path.basename(output)
        });
    }
    
    append(apath:string, sourceMapText:string, offset:number):void {
        let rpath = path.relative(this.outdir, apath);
        if (path.sep === '\\') rpath = rpath.replace(/\\/g, '/');
        const consumer = new this.module.SourceMapConsumer(JSON.parse(sourceMapText));
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

    save():Promise<void> {
        return fsp.writeFile(this.output+'.map', this.mapgen!.toString());
    }
}