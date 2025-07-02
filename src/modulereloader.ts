import path = require("path");
import ts = require("typescript");
import { FilesWatcher } from "./util/watch";

export function registerModuleReloader(
    compilerOptions?: ts.CompilerOptions,
): void {
    if (!(Symbol.for("ts-node.register.instance") in process)) {
        const tsnode = require("ts-node") as typeof import("ts-node");
        if (process.env.TS_NODE !== "true") {
            tsnode.register({ compilerOptions });
        }
    }
    const watcher = new FilesWatcher<null>(500, (list) => {
        for (const [_, files] of list) {
            for (const file of files) {
                delete require.cache[file];
            }
        }
    });
    const oldRequire = module.constructor.prototype.require;
    module.constructor.prototype.require = function (
        this: NodeModule,
        mpath: string,
    ) {
        const exports = oldRequire.apply(this, arguments);
        if (mpath.indexOf(path.sep + "node_modules" + path.sep) === -1) {
            watcher.add(null, mpath);
        }
        return exports;
    };
}

export function bypassRequireCall(
    requireMethod: (path: string) => unknown,
    path: string,
): any {
    return requireMethod(path);
}
