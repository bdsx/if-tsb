import ts = require("typescript");
import { tshelper } from "../tshelper";
import { cachedStat } from "./cachedstat";
import { getScriptKind } from "./util";
import { Bundler } from "../bundler";

export class ImportingModuleInfo {
    constructor(
        public readonly fileName: string,
        public readonly isExternal: boolean,
        public readonly isBuiltIn: boolean,
        public readonly fileNotFound: boolean,
    ) {}
}

export class ImportHelper {
    constructor(
        public readonly sys: ts.System,
        public readonly bundler: Bundler,
    ) {}
    resolve(
        importFrom: string,
        importString: string,
        noJS = false,
    ): ImportingModuleInfo {
        const info = this.bundler.resolveModuleName(
            importString,
            importFrom,
            this.sys,
        );
        if (info === null) {
            if (!importString.startsWith(".")) {
                if (tshelper.isBuiltInModule(importString)) {
                    return new ImportingModuleInfo(
                        importString,
                        true,
                        true,
                        false,
                    );
                }
            }
            return new ImportingModuleInfo(importString, true, false, true);
        }

        let childmoduleApath = info.apath;
        const kind = getScriptKind(childmoduleApath);
        let fileNotFound = false;
        if (kind.kind === ts.ScriptKind.External) {
            if (!noJS) {
                const jsFile = kind.js();
                if (cachedStat.existsSync(jsFile)) {
                    childmoduleApath = jsFile;
                } else {
                    fileNotFound = true;
                }
            }
        } else if (kind.kind === ts.ScriptKind.JS) {
            if (noJS) {
                fileNotFound = true;
                childmoduleApath = kind.ts();
            }
        }
        return new ImportingModuleInfo(
            childmoduleApath,
            info.isExternal,
            false,
            fileNotFound,
        );
    }
}
