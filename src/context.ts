import * as colors from "colors";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { Bundler } from "./bundler";
import {
    cacheDir,
    cacheMapPath,
    CACHE_VERSION,
    getCacheFilePath,
} from "./cachedir";
import { fsp } from "./fsp";
import { BundlerModule, BundlerModuleId } from "./module";
import { cachedStat } from "./cachedstat";
import { namelock } from "./namelock";
import { Reporter } from "./reporter";
import { IfTsbError, TsConfig } from "./types";
import { printDiagnostrics } from "./util";

const defaultCompilerOptions = ts.getDefaultCompilerOptions();

function getOutFileName(options: TsConfig, name: string): string {
    if (options.output != null) {
        const filename = path.basename(name);
        const ext = path.extname(filename);

        const varmap = new Map<string, string>();
        varmap.set("name", filename.substr(0, filename.length - ext.length));
        varmap.set("dirname", path.dirname(name));

        const regex = /\[.+\]/g;
        return options.output.replace(regex, (matched) => {
            return varmap.get(matched) || process.env[matched] || "";
        });
    } else {
        const ext = path.extname(name);
        return name.substr(0, name.length - ext.length) + ".bundle.js";
    }
}

let instance: Promise<BundlerMainContext> | null = null;

type IdMapJson = Record<
    string,
    Record<string, { number: number; varName: string }> & { $cacheTo?: number }
> & { version: string };

export class IdMap extends Map<string, BundlerModuleId> {
    cacheTo?: number;
}

export class BundlerMainContext implements Reporter {
    public errorCount = 0;
    private readonly idmap: Map<string, IdMap>;
    private readonly accessedOutputs = new Set<string>();
    private readonly cacheUnusingId = new Set<number>();
    private lastCacheId = -1;
    public cacheJsonModified = false;
    public cacheJsonSaving = false;
    public cacheJsonNeedResave = false;
    private readonly outputs = new Set<string>();

    private constructor(caches: IdMapJson) {
        process.on("exit", () => this.saveCacheJsonSync());

        try {
            if (caches.version !== CACHE_VERSION) {
                this.idmap = new Map();
                this.lastCacheId = -1;
                return;
            }
            this.idmap = new Map();
            let count = 0;
            const using = new Set<number>();
            for (const entryApath in caches) {
                const cache = caches[entryApath];
                const out = new IdMap();
                this.idmap.set(entryApath, out);

                for (const apath in cache) {
                    const id = cache[apath];
                    if (id.number >= 0) {
                        if (using.has(id.number)) {
                            console.error(
                                colors.red(
                                    `if-tsb: cache file is corrupted (${apath})`
                                )
                            );
                            continue;
                        } else {
                            count++;
                            using.add(id.number);
                        }
                    }
                    out.set(
                        apath,
                        new BundlerModuleId(id.number, id.varName, apath)
                    );
                }
            }
            for (let i = 0; count !== 0; i++) {
                if (using.has(i)) {
                    count--;
                    this.lastCacheId = i;
                    continue;
                }
                this.cacheUnusingId.add(i);
            }
        } catch (err) {
            this.idmap = new Map();
            this.lastCacheId = -1;
        }
    }

    static getInstance(): Promise<BundlerMainContext> {
        if (instance !== null) return instance;
        return (instance = (async () => {
            await fsp.mkdirRecursive(cacheDir);
            let cache: any;
            try {
                cache = JSON.parse(await fsp.readFile(cacheMapPath));
            } catch (err) {
                cache = {};
            }
            return new BundlerMainContext(cache);
        })());
    }

    getCacheJson(): any {
        const output = { version: CACHE_VERSION } as IdMapJson;
        for (const [outputpath, cache] of this.idmap) {
            const outcache = (output[outputpath] = {} as IdMapJson[string]);
            for (const id of cache.values()) {
                outcache[id.apath] = {
                    number: id.number,
                    varName: id.varName,
                };
                if (cache.cacheTo != null) {
                    outcache.$cacheTo = cache.cacheTo;
                }
            }
        }
        return output;
    }

    private _cleanBeforeSave(): void {
        const now = Date.now();
        const next = now + 24 * 60 * 60 * 1000;
        for (const [output, cache] of this.idmap) {
            if (this.accessedOutputs.has(output)) {
                cache.cacheTo = next;
            } else {
                const cacheTo = cache.cacheTo;
                if (cacheTo == null || now > cacheTo) {
                    this.idmap.delete(output);
                    this.cacheJsonModified = true;
                }
            }
        }
    }

    saveCacheJsonSync(): void {
        this._cleanBeforeSave();
        if (!this.cacheJsonModified) return;
        this.cacheJsonModified = false;
        const output = this.getCacheJson();
        if (this.cacheJsonSaving)
            console.error(`cachejson is writing async and sync at once`);
        fs.writeFileSync(
            cacheMapPath,
            JSON.stringify(output, null, 2),
            "utf-8"
        );
    }

    async saveCacheJson(): Promise<void> {
        this._cleanBeforeSave();
        if (this.cacheJsonSaving) return;
        this.cacheJsonSaving = true;
        while (this.cacheJsonModified) {
            this.cacheJsonModified = false;
            const output = this.getCacheJson();
            await fsp.writeFile(cacheMapPath, JSON.stringify(output, null, 2));
        }
        this.cacheJsonSaving = false;
    }

    /**
     * mimic TS errors
     */
    report(
        source: string,
        line: number,
        column: number,
        code: number,
        message: string,
        lineText: string,
        width: number
    ): void {
        this.errorCount++;

        const linestr = line + "";
        console.log(
            `${colors.cyan(source)}:${colors.yellow(linestr)}:${colors.yellow(
                column + ""
            )} - ${colors.red("error")} ${colors.gray(
                "TS" + code + ":"
            )} ${message}`
        );
        console.log();

        if (line !== 0) {
            console.log(colors.black(colors.bgWhite(linestr)) + " " + lineText);
            console.log(
                colors.bgWhite(" ".repeat(linestr.length)) +
                    " ".repeat(column + 1) +
                    colors.red("~".repeat(width))
            );
            console.log();
        }
    }

    /**
     * mimic TS errors
     */
    reportMessage(code: number, message: string, noError?: boolean): void {
        if (!noError) this.errorCount++;
        console.log(
            `${
                noError ? colors.gray("message") : colors.red("error")
            } ${colors.gray(`TS${code}:`)} ${message}`
        );
    }

    /**
     * mimic TS errors
     */
    reportFromCatch(err: any): boolean {
        if (err.code === "ENOENT") {
            this.reportMessage(IfTsbError.ModuleNotFound, err.message);
            return true;
        }
        this.errorCount++;
        console.error(err);
        return false;
    }

    getErrorCountString(): string {
        if (this.errorCount === 1) return `Found 1 error`;
        else return `Found ${this.errorCount} errors`;
    }

    private async _removeCache(
        bundler: Bundler,
        cache: IdMap,
        id: BundlerModuleId
    ): Promise<void> {
        console.trace("remove cache");
        bundler.deleteModuleVarName(id.varName);
        if (id.number < 0) return;
        cache.delete(id.apath);
        this.freeCacheId(id.number);
        this.cacheJsonModified = true;
    }

    clearCache(bundler: Bundler, modules: Map<string, BundlerModule>): void {
        const map = this.idmap.get(bundler.output);
        if (!map) return;

        const names = new Set<string>(modules.keys());
        for (const [apath, id] of map) {
            if (names.has(apath)) continue;
            this._removeCache(bundler, map, id);
        }
    }

    allocateCacheId(): number {
        for (const first of this.cacheUnusingId) {
            this.cacheUnusingId.delete(first);
            return first;
        }
        const id = ++this.lastCacheId;
        try {
            fs.unlinkSync(getCacheFilePath(id));
        } catch (err) {}
        return id;
    }

    async freeCacheId(id: number): Promise<void> {
        if (id < 0) throw TypeError(`Unexpected id: ${id}`);

        if (this.cacheUnusingId.has(id)) {
            console.error(colors.red(`Already unused id: ${id}`));
        } else if (id === this.lastCacheId) {
            do {
                --this.lastCacheId;
            } while (this.cacheUnusingId.delete(this.lastCacheId));
        } else {
            this.cacheUnusingId.add(id);
        }

        await namelock.lock(id);
        try {
            await fsp.unlink(getCacheFilePath(id));
        } catch (err) {
        } finally {
            namelock.unlock(id);
        }
    }

    getCacheMap(apath: string): IdMap {
        this.accessedOutputs.add(apath);
        let map = this.idmap.get(apath);
        if (map != null) return map;
        map = new IdMap();
        this.idmap.set(apath, map);
        return map;
    }

    private _makeBundlers(
        options: TsConfig,
        basedir: string,
        tsconfig: string | null,
        compilerOptions: ts.CompilerOptions
    ): Bundler[] {
        for (const key in defaultCompilerOptions) {
            if (compilerOptions[key] !== undefined) continue;
            compilerOptions[key] = defaultCompilerOptions[key];
        }

        if (compilerOptions.module !== ts.ModuleKind.CommonJS) {
            if (compilerOptions.module === undefined)
                compilerOptions.module = ts.ModuleKind.None;
            options.bundlerOptions = Object.assign({}, options.bundlerOptions);
            options.bundlerOptions.module =
                ts.ModuleKind[compilerOptions.module!];
            compilerOptions.module = ts.ModuleKind.CommonJS;
        }

        let entry = options.entry;
        if (entry == null) {
            const name = "./index.ts";
            entry = { [name]: getOutFileName(options, name) };
        } else if (typeof entry === "string") {
            entry = { [entry]: getOutFileName(options, entry) };
        } else if (entry instanceof Array) {
            const out: Record<string, string> = {};
            for (const filepath of entry) {
                out[filepath] = getOutFileName(options, filepath);
            }
            entry = out;
        }

        const bundlers: Bundler[] = [];
        for (const entryfile in entry) {
            let output = entry[entryfile];
            let newoptions = options;
            if (typeof output === "object") {
                newoptions = Object.assign({}, newoptions);
                newoptions.bundlerOptions = Object.assign(
                    {},
                    output,
                    newoptions.bundlerOptions
                );
                output = getOutFileName(newoptions, entryfile);
            }
            const resolvedOutput = path.resolve(basedir, output);
            if (this.outputs.has(resolvedOutput)) {
                this.reportMessage(
                    IfTsbError.Dupplicated,
                    `outputs are dupplicated. ${output}`
                );
                continue;
            }
            try {
                const bundler = new Bundler(
                    this,
                    basedir,
                    resolvedOutput,
                    newoptions,
                    entryfile,
                    [],
                    tsconfig,
                    compilerOptions,
                    options
                );
                bundlers.push(bundler);
                const cache = this.idmap.get(bundler.output)!;
                for (const [apath, moduleId] of cache) {
                    const oldid = bundler.addModuleVarName(moduleId);
                    if (oldid !== null) {
                        this._removeCache(bundler, cache, oldid);
                        this._removeCache(bundler, cache, moduleId);
                    }
                }
            } catch (err) {
                this.reportFromCatch(err);
            }
        }
        return bundlers;
    }

    makeBundlersWithPath(
        configPath: string,
        output?: string | TsConfig | null
    ): Bundler[] {
        configPath = path.resolve(configPath);
        try {
            if (output != null && typeof output === "object") {
                const basedir = configPath;
                const parsed = ts.parseJsonConfigFileContent(
                    output,
                    ts.sys,
                    basedir
                );
                printDiagnostrics(parsed.errors);
                return this._makeBundlers(
                    output,
                    basedir,
                    null,
                    parsed.options
                );
            } else {
                let basedir: string;
                const stat = fs.statSync(configPath);
                if (stat.isDirectory()) {
                    basedir = configPath;
                    const npath = path.join(configPath, "tsconfig.json");
                    if (cachedStat.existsSync(npath)) {
                        configPath = npath;
                    } else {
                        configPath = path.join(configPath, "index.ts");
                        if (!cachedStat.existsSync(configPath)) {
                            this.reportMessage(
                                IfTsbError.ModuleNotFound,
                                "Entry not found"
                            );
                            return [];
                        }
                    }
                } else {
                    basedir = path.dirname(configPath);
                }

                if (configPath.endsWith(".json")) {
                    const configFile = ts.readConfigFile(
                        configPath,
                        ts.sys.readFile
                    );
                    if (configFile.error != null) {
                        printDiagnostrics([configFile.error]);
                    }

                    const parsed = ts.parseJsonConfigFileContent(
                        configFile.config,
                        ts.sys,
                        basedir
                    );
                    printDiagnostrics(parsed.errors);
                    const options = configFile.config as TsConfig;

                    if (typeof output === "string") options.output = output;
                    return this._makeBundlers(
                        options,
                        basedir,
                        configPath,
                        parsed.options
                    );
                } else {
                    return this._makeBundlers(
                        { entry: configPath, output },
                        basedir,
                        null,
                        {}
                    );
                }
            }
        } catch (err) {
            this.reportFromCatch(err);
            return [];
        }
    }

    makeBundlers(options: TsConfig): Bundler[] {
        let tsoptions: ts.CompilerOptions;
        let tsconfig: string | null = null;
        const basedir = process.cwd();

        try {
            if (options.compilerOptions) {
                tsoptions = options.compilerOptions;
            } else {
                tsconfig = path.resolve("./tsconfig.json");
                const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile);
                if (configFile.error != null) {
                    printDiagnostrics([configFile.error]);
                }

                const parsed = ts.parseJsonConfigFileContent(
                    configFile.config,
                    ts.sys,
                    "./"
                );
                printDiagnostrics(parsed.errors);
                tsoptions = parsed.options;
            }
        } catch (err) {
            this.reportFromCatch(err);
            return [];
        }

        return this._makeBundlers(options, basedir, tsconfig, tsoptions);
    }
}
