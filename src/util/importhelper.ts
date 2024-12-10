import ts = require("typescript");
import { tshelper } from "../tshelper";
import { cachedStat } from "./cachedstat";
import { getScriptKind } from "./util";

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
        public readonly compilerOptions: ts.CompilerOptions,
        public readonly cache: ts.ModuleResolutionCache,
    ) {}
    resolve(
        importFrom: string,
        importString: string,
        noJS = false,
    ): ImportingModuleInfo {
        let module = ts.nodeModuleNameResolver(
            importString,
            importFrom,
            this.compilerOptions,
            this.sys,
            this.cache,
        );
        if (module.resolvedModule === undefined && importString === ".")
            module = ts.nodeModuleNameResolver(
                "./index",
                importFrom,
                this.compilerOptions,
                this.sys,
                this.cache,
            );
        const info = module.resolvedModule;
        if (info === undefined) {
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

        let childmoduleApath = this.sys.resolvePath(info.resolvedFileName);
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
            info.isExternalLibraryImport ?? false,
            false,
            fileNotFound,
        );
    }
}
