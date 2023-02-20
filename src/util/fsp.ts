import fs = require("fs");
import path = require("path");

function processMkdirError(dirname: string, err: any): boolean {
    if (err.code === "EEXIST") {
        return true;
    }
    if (err.code === "ENOENT") {
        throw new Error(`EACCES: permission denied, mkdir '${dirname}'`);
    }
    return false;
}

export namespace fsp {
    export let verbose = false;
    export function unlink(path: string): Promise<void> {
        if (verbose) console.log(`unlink ${path}`);
        return new Promise((resolve, reject) =>
            fs.unlink(path, (err) => {
                if (err) reject(err);
                else resolve();
            })
        );
    }
    export function mkdir(path: string): Promise<void> {
        if (verbose) console.log(`mkdir ${path}`);
        return new Promise((resolve, reject) =>
            fs.mkdir(path, (err) => {
                if (err) reject(err);
                else resolve();
            })
        );
    }
    export function rmdir(path: string): Promise<void> {
        if (verbose) console.log(`rmdir ${path}`);
        return new Promise((resolve, reject) =>
            fs.rmdir(path, (err) => {
                if (err) reject(err);
                else resolve();
            })
        );
    }
    export function readFile(path: string): Promise<string> {
        if (verbose) console.log(`readFile ${path}`);
        return new Promise((resolve, reject) =>
            fs.readFile(path, "utf-8", (err, data) => {
                if (err) reject(err);
                else resolve(data);
            })
        );
    }
    export function readFileBuffer(path:string):Promise<Buffer> {
        if (verbose) console.log(`readFile ${path}`);
        return new Promise((resolve, reject)=>fs.readFile(path, null, (err, data)=>{
            if (err) reject(err);
            else resolve(data);
        }))
    }
    export function writeFileSync(path: string, data: string): void {
        fs.writeFileSync(path, data, "utf-8");
    }
    export function writeFile(path: string, data: string): Promise<void> {
        if (verbose) console.log(`writeFile ${path}`);
        return new Promise((resolve, reject) =>
            fs.writeFile(path, data, "utf-8", (err) => {
                if (err) reject(err);
                else resolve();
            })
        );
    }
    export function stat(path: string): Promise<fs.Stats> {
        if (verbose) console.log(`stat ${path}`);
        return new Promise((resolve, reject) =>
            fs.stat(path, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            })
        );
    }
    export function readdir(path: string): Promise<string[]> {
        if (verbose) console.log(`readdir ${path}`);
        return new Promise((resolve, reject) =>
            fs.readdir(path, (err, out) => {
                if (err) reject(err);
                else resolve(out);
            })
        );
    }

    export async function mkdirRecursive(dir: string): Promise<boolean> {
        try {
            await mkdir(dir);
            return false;
        } catch (err) {
            if (err.code === "EEXIST") {
                return true;
            } else if (err.code === "ENOENT") {
                await mkdirRecursive(path.dirname(dir));
            } else {
                throw err;
            }
        }
        try {
            await mkdir(dir);
        } catch (err) {
            if (err.code === "EEXIST") {
                return true;
            } else {
                throw err;
            }
        }
        return false;
    }
    export async function deleteAll(filepath: string): Promise<number> {
        let count = 0;
        try {
            const stats = await stat(filepath);
            if (stats.isDirectory()) {
                for (const file of await readdir(filepath)) {
                    count += await deleteAll(path.join(filepath, file));
                }
                await rmdir(filepath);
            } else {
                await unlink(filepath);
            }
            count++;
        } catch (err) {}
        return count;
    }

    export function mkdirRecursiveSync(dir: string): boolean {
        try {
            fs.mkdirSync(dir);
            return false;
        } catch (err) {
            if (err.code === "EEXIST") {
                return true;
            } else if (err.code === "ENOENT") {
                mkdirRecursiveSync(path.dirname(dir));
            } else {
                throw err;
            }
        }
        try {
            fs.mkdirSync(dir);
        } catch (err) {
            if (err.code === "EEXIST") {
                return true;
            } else {
                throw err;
            }
        }
        return false;
    }
}
