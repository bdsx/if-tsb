
import sourceMap = require('source-map');
import path = require('path');
import fs = require('fs');
import { getWorkerThreadModule } from './workertype';

const { workerData, parentPort } = getWorkerThreadModule();

const output:string = workerData;
const outdir = path.dirname(output);

const mapgen = new sourceMap.SourceMapGenerator({
    file:path.basename(output)
});

function append(apath:string, sourceMapText:string, offset:number):void {
    let rpath = path.relative(outdir, apath);
    if (path.sep === '\\') rpath = rpath.replace(/\\/g, '/');
    const consumer = new sourceMap.SourceMapConsumer(JSON.parse(sourceMapText));
    consumer.eachMapping(entry=>{
      mapgen.addMapping({
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

parentPort.on('message', (message:[string, string, number])=>{
    if (message === null) {
        fs.writeFileSync(output+'.map', mapgen!.toString());
        parentPort.postMessage(null);
        parentPort.close();
        return;
    } else {
        append(...message);
    }
});
