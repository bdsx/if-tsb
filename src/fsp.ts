
import fs = require('fs');
import path = require('path');

function processMkdirError(dirname:string, err:any):boolean
{
    if (err.code === 'EEXIST') {
        return true;
    }
    if (err.code === 'ENOENT') {
        throw new Error(`EACCES: permission denied, mkdir '${dirname}'`);
    }
    return false;
}

export namespace fsp
{
    export function unlink(path:string):Promise<void>
    {
        return new Promise((resolve, reject)=>fs.unlink(path, (err)=>{
            if (err) reject(err);
            else resolve();
        }))
    }
    export function mkdir(path:string):Promise<void>
    {
        return new Promise((resolve, reject)=>fs.mkdir(path, (err)=>{
            if (err) reject(err);
            else resolve();
        }))
    }
    export function rmdir(path:string):Promise<void>
    {
        return new Promise((resolve, reject)=>fs.rmdir(path, (err)=>{
            if (err) reject(err);
            else resolve();
        }))
    }
    export function readFile(path:string):Promise<string>
    {
        return new Promise((resolve, reject)=>fs.readFile(path, 'utf-8', (err, data)=>{
            if (err) reject(err);
            else resolve(data);
        }))
    }
    export function writeFile(path:string, data:string):Promise<void>
    {
        return new Promise((resolve, reject)=>fs.writeFile(path, data, 'utf-8', (err)=>{
            if (err) reject(err);
            else resolve();
        }))
    }
    export function stat(path:string):Promise<fs.Stats>
    {
        return new Promise((resolve, reject)=>fs.stat(path, (err, data)=>{
            if (err) reject(err);
            else resolve(data);
        }))
    }
    export function readdir(path:string):Promise<string[]>
    {
        return new Promise((resolve, reject)=>fs.readdir(path, (err, out)=>{
            if (err) reject(err);
            else resolve(out);
        }));
    }
        
    export async function mkdirRecursive(dirpath:string):Promise<void> {
        const sep = path.sep;
        dirpath = path.resolve(dirpath);
        
        let index = dirpath.indexOf(sep)+1;
        if (index === 0) return;

        for (;;)
        {
            const nextsep = dirpath.indexOf(sep, index);
            if (nextsep === -1)
            {
                try {
                    await fsp.mkdir(dirpath);
                } catch (err) {
                    if (!processMkdirError(dirpath, err))
                    {
                        throw err;
                    }
                }
                break;
            }
            index = nextsep+1;
            const dirname = dirpath.substr(0, nextsep);
            try {
                await fsp.mkdir(dirname);
            } catch (err) {
                if (!processMkdirError(dirname, err))
                {
                    if (['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) === -1) {
                        throw err;
                    }
                }
            }
        }
    }
    export async function deleteAll(filepath:string):Promise<number>
    {
        let count = 0;
        try
        {
            const stat = await fsp.stat(filepath);
            if (stat.isDirectory())
            {
                for (const file of await readdir(filepath))
                {
                    count += await deleteAll(path.join(filepath, file));
                }
                await fsp.rmdir(filepath);
            }
            else
            {
                await fsp.unlink(filepath);
            }
            count++;
        }
        catch (err)
        {
        }
        return count;
    }
}

export function mkdirRecursiveSync(dirpath:string):void {
    const sep = path.sep;
    dirpath = path.resolve(dirpath);
    
    let index = dirpath.indexOf(sep)+1;
    if (index === 0) return;
    
    for (;;)
    {
        const nextsep = dirpath.indexOf(sep, index);
        if (nextsep === -1)
        {
            try {
                fs.mkdirSync(dirpath);
            } catch (err) {
                if (!processMkdirError(dirpath, err))
                {
                    throw err;
                }
            }
            break;
        }
        index = nextsep+1;
        const dirname = dirpath.substr(0, nextsep);
        try {
            fs.mkdirSync(dirname);
        } catch (err) {
            if (!processMkdirError(dirname, err))
            {
                if (['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) === -1) {
                    throw err;
                }
            }
        }
    }
}
