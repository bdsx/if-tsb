import ts = require("typescript");
import path = require("path");
import { PhaseListener, TsConfig } from "../types";

export const resolved = Promise.resolve();

export const defaultFormatHost: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => ts.sys.newLine,
};

export function printNode(node: ts.Node, name: string, tab: string): void {
    let line = node.getFullText();
    const lineidx = line.indexOf("\n");
    if (lineidx !== -1) line = line.substr(0, lineidx);

    console.log(`${tab}[${name}:${ts.SyntaxKind[node.kind]}] ${line}`);
    tab += "  ";
    const nodes: Record<string, ts.Node> = {};
    for (const key in node) {
        if (key === "parent") continue;
        if (key === "pos") continue;
        if (key === "end") continue;
        if (key === "flags") continue;
        if (key === "modifierFlagsCache") continue;
        if (key === "transformFlags") continue;
        if (key === "kind") continue;
        if (key === "originalKeywordKind") continue;
        if (key === "flowNode") continue;
        const v = (node as any)[key];
        if (v instanceof Function) continue;
        if (v && v["kind"]) nodes[key] = v;
        else console.log(`${tab}${key}=${v}`);
    }
    for (const key in nodes) {
        printNode((nodes as any)[key], key, tab);
    }
}

/**
 * const [a,b] = splitContent('a,b,b', 2, ',')
 * a = 'a'
 * b = 'b,b'
 * const [a,b] = 'a,b,b'.split(',', 2)
 * a = 'a'
 * b = 'b'
 */
export function splitContent(
    text: string,
    count: number,
    needle: string
): string[] {
    if (count === 0) return [];

    let from = 0;
    const out = new Array(count);
    const last_i = count - 1;
    let i = 0;
    for (;;) {
        if (i === last_i) {
            out[i] = text.substr(from);
            break;
        }
        const next = text.indexOf(needle, from);
        if (next === -1) {
            out[i++] = text.substr(from);
            out.length = i;
            break;
        }
        out[i++] = text.substring(from, next);
        from = next + 1;
    }
    return out;
}

export function instanceProxy(instance: any): void {
    for (const name in instance) {
        const fn = instance[name];
        if (fn instanceof Function) {
            instance[name] = function (...args: any[]): any {
                console.log(name, "(", args.join(", "), ")");
                return fn.apply(this, args);
            };
        } else {
            instance[name] = fn;
        }
    }
}

export function changeExt(filepath: string, ext: string): string {
    const extidx = filepath.lastIndexOf(".");
    const pathidx = filepath.lastIndexOf(path.sep);
    if (extidx < pathidx) return filepath;
    return filepath.substr(0, extidx + 1) + ext;
}

export function time(): string {
    return new Date().toLocaleTimeString();
}

export function count(content: string, chr: string): number {
    const code = chr.charCodeAt(0);
    const n = content.length;
    let count = 0;
    for (let i = 0; i < n; i++) {
        if (content.charCodeAt(i) === code) count++;
    }
    return count;
}

type Task = (() => Promise<any>) | Promise<void> | null;
type TaskToResult<T> = T extends () => Promise<infer R>
    ? R
    : T extends Promise<infer R>
    ? R
    : T;
type TasksToResults<T extends Task[]> = {
    [key in keyof T]: TaskToResult<T[key]>;
};
export function concurrent<PROMS extends Task[]>(
    ...funcs: PROMS
): Promise<TasksToResults<PROMS>> {
    const proms: Promise<any>[] = [];
    for (const func of funcs) {
        if (func === null) continue;
        if (func instanceof Promise) {
            proms.push(func);
        } else {
            proms.push(func());
        }
    }
    return Promise.all(proms) as any;
}

function runTasks(tasks: (() => Promise<void>)[]): Promise<unknown> {
    const proms: Promise<void>[] = [];
    for (const task of tasks) {
        proms.push(task());
    }
    return proms.length === 1 ? proms[0] : Promise.all(proms);
}

export class SkipableTaskQueue {
    private reserved: (() => Promise<void>)[] | null = null;
    private processing = false;
    private endResolve: (() => void) | null = null;
    private endReject: ((err: any) => void) | null = null;
    private endPromise: Promise<void> | null = null;
    private err = null;
    private readonly _continue = () => {
        if (this.reserved !== null) {
            runTasks(this.reserved).then(this._continue, (err) => {
                this.err = err;
                if (this.endReject !== null) {
                    this.endReject(err);
                    this.endResolve = null;
                    this.endReject = null;
                    this.endPromise = null;
                }
            });
        } else {
            this.processing = false;
            if (this.endResolve !== null) {
                this.endResolve();
                this.endResolve = null;
                this.endReject = null;
                this.endPromise = null;
            }
        }
    };

    onceEnd(): Promise<void> {
        if (this.err !== null) return Promise.reject(this.err);
        if (this.endPromise === null) {
            this.endPromise = new Promise((resolve, reject) => {
                this.endResolve = resolve;
                this.endReject = reject;
            });
        }
        return this.endPromise;
    }

    run(...tasks: (() => Promise<void>)[]): void {
        if (this.processing) {
            this.reserved = tasks;
        } else {
            this.processing = true;
            runTasks(tasks).then(this._continue);
        }
    }
}

const _kindMap = new Map<string, ts.ScriptKind>();
_kindMap.set(".TS", ts.ScriptKind.TS);
_kindMap.set(".TSX", ts.ScriptKind.TSX);
_kindMap.set(".JS", ts.ScriptKind.JS);
_kindMap.set(".JSX", ts.ScriptKind.JSX);
_kindMap.set(".JSON", ts.ScriptKind.JSON);

export class ScriptKind {
    constructor(
        public readonly kind: ts.ScriptKind,
        public readonly ext: string,
        public readonly apath: string
    ) {}
    get moduleName(): string {
        const baseName = path.basename(this.apath);
        return baseName.substr(0, baseName.length - this.ext.length);
    }
    get modulePath(): string {
        return this.apath.substr(0, this.apath.length - this.ext.length);
    }
}

export function getScriptKind(filepath: string): ScriptKind {
    let ext = path.extname(filepath).toUpperCase();
    let kind = _kindMap.get(ext) || ts.ScriptKind.Unknown;
    switch (kind) {
        case ts.ScriptKind.TS:
            const nidx = filepath.lastIndexOf(
                ".",
                filepath.length - ext.length - 1
            );
            if (nidx !== -1) {
                const next = filepath.substr(nidx).toUpperCase();
                if (next === ".D.TS") {
                    ext = next;
                    kind = ts.ScriptKind.External;
                }
            }
            break;
    }
    return new ScriptKind(kind, ext, filepath);
}

export function parsePostfix(
    str: string | number | undefined
): number | undefined {
    switch (typeof str) {
        case "string":
            break;
        case "number":
            return str;
        default:
            return undefined;
    }
    let n = str.length;
    if (str.endsWith("B")) {
        n--;
    }
    let value = 0;
    for (let i = 0; i < n; i++) {
        const code = str.charCodeAt(i);
        if (0x30 <= code && code <= 0x39) {
            value *= 10;
            value += code - 0x30;
            continue;
        }
        if (i !== n - 1) {
            console.error(`Invalid number character: ${str.charAt(i)}`);
            continue;
        }
        switch (code) {
            case 0x62:
            case 0x42:
                break;
            case 0x6b:
            case 0x4b: // K
                value *= 1024;
                break;
            case 0x6d:
            case 0x4d: // M
                value *= 1024 * 1024;
                break;
            case 0x67:
            case 0x47: // G
                value *= 1024 * 1024 * 1024;
                break;
            case 0x74:
            case 0x54: // T
                value *= 1024 * 1024 * 1024 * 1024;
                break;
            default:
                console.error(`Unknown number postfix: ${str.charAt(i)}`);
                break;
        }
        break;
    }
    return value;
}

const indexOfSep: (path: string, offset?: number) => number =
    path.sep === "/"
        ? (v, offset) => v.indexOf(v, offset)
        : (v, offset) => {
              const idx1 = v.indexOf("/", offset);
              const idx2 = v.indexOf(path.sep, offset);
              if (idx1 === -1) return idx2;
              if (idx2 === -1) return idx1;
              return Math.min(idx1, idx2);
          };

const lastIndexOfSep: (path: string, offset?: number) => number =
    path.sep === "/"
        ? (v, offset) => v.lastIndexOf(v, offset)
        : (v, offset) =>
              Math.max(
                  v.lastIndexOf("/", offset),
                  v.lastIndexOf(path.sep, offset)
              );

export function dirnameModulePath(path: string): string {
    if (path === "") throw Error("cannot get empty path of directory");

    let p = path.length - 1;
    for (;;) {
        const lastIdx = lastIndexOfSep(path, p);
        if (lastIdx === -1) {
            if (path === ".") return "..";
            return path + "/..";
        }
        const idx = lastIdx + 1;
        switch (path.substr(idx)) {
            case "":
            case ".":
                p = lastIdx - 1;
                continue;
            case "..":
                return path + "/..";
            default:
                return path.substr(0, lastIdx);
        }
    }
}

export function joinModulePath(...pathes: string[]): string {
    const out: string[] = [];
    let backcount = 0;

    let absolute: string | null = null;
    for (const child of pathes) {
        let prev = 0;

        if (!child.startsWith(".")) {
            out.length = 0;
            backcount = 0;
            const sepidx = indexOfSep(child, prev);
            absolute =
                sepidx === -1
                    ? child.substr(prev)
                    : child.substring(prev, sepidx);
            if (sepidx === -1) continue;
            prev = sepidx + 1;
        }

        for (;;) {
            const sepidx = indexOfSep(child, prev);
            const partname =
                sepidx === -1
                    ? child.substr(prev)
                    : child.substring(prev, sepidx);
            switch (partname) {
                case ".":
                    break;
                case "":
                    break;
                case "..":
                    if (out.pop() == null) {
                        backcount++;
                    }
                    break;
                default:
                    out.push(partname);
                    break;
            }
            if (sepidx === -1) break;
            prev = sepidx + 1;
        }
    }
    let outstr = "";
    if (absolute !== null) outstr += absolute + "/";
    if (backcount === 0) {
        if (absolute === null) outstr += "./";
    } else {
        outstr += "../".repeat(backcount);
    }

    if (out.length === 0) return outstr.substr(0, outstr.length - 1);
    else return outstr + out.join("/");
}

export function tsbuild(tsconfig: TsConfig, basedir: string): void {
    const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, basedir);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const emitResult = program.emit();
    const allDiagnostics = ts
        .getPreEmitDiagnostics(program)
        .concat(emitResult.diagnostics);
    if (allDiagnostics.length !== 0) {
        console.error(
            ts.formatDiagnosticsWithColorAndContext(
                allDiagnostics,
                defaultFormatHost
            )
        );
    }
}

export function tswatch(
    tsconfig: TsConfig,
    basedir: string,
    opts: PhaseListener = {}
): void {
    const parsed = ts.parseJsonConfigFileContent(
        tsconfig,
        ts.sys,
        path.resolve(basedir)
    );
    printDiagnostrics(parsed.errors);
    const host = ts.createWatchCompilerHost(
        parsed.fileNames,
        parsed.options,
        ts.sys,
        ts.createSemanticDiagnosticsBuilderProgram,
        (diagnostic) => printDiagnostrics([diagnostic]),
        (diagnostic) => {
            switch (diagnostic.code) {
                case 6031: // start
                case 6032: // change
                    if (opts.onStart != null) opts.onStart();
                    break;
            }
            printDiagnostrics([diagnostic]);
            if (diagnostic.code === 6194) {
                // finish
                if (opts.onFinish != null) opts.onFinish();
            }
        },
        parsed.projectReferences,
        parsed.watchOptions
    );
    ts.createWatchProgram(host);
}

export function printDiagnostrics(diagnostics: readonly ts.Diagnostic[]): void {
    if (diagnostics.length === 0) return;
    console.error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, defaultFormatHost)
    );
}
