
import ts = require('typescript');
import path = require('path');
import { FilesWatcher } from './watch';

export function registerModuleReloader(compilerOptions?:ts.CompilerOptions):void {
    if (!(Symbol.for("ts-node.register.instance") in process)) {
        const tsnode = require('ts-node') as typeof import('ts-node');
        if (process.env.TS_NODE !== 'true') {
            tsnode.register({ compilerOptions });
        }
    }
    
    // const watcher = new FilesWatcher<null>(500, list=>{
    //     for (const [_, files] of list) {
    //         for (const file of files) {
    //             delete require.cache[file];
    //         }
    //     }
    // });
    // const oldRequire = module.constructor.prototype.require;
    // module.constructor.prototype.require = function (this:NodeModule, mpath:string) {
    //     const exports = oldRequire.apply(this, arguments);
    //     const module:NodeModule = exports.module; // TODO: get module from require
    //     watcher.add(null, module.filename);
    //     return exports;
    // }
}

export function reloadableRequire(requireMethod:(path:string)=>unknown, path:string):any {
    return requireMethod(path);
}
