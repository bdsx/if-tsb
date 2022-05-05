#!/usr/bin/env node

import { bundle } from "./index";
import { time } from "./util";
import fs = require('fs');
import path = require('path');

(async()=>{

    const targetPathes:string[] = [];

    const argc = process.argv.length;
    let watch = false;
    let error = false;
    let clearCache = false;
    let output:string|undefined = undefined;
    
    for (let i=2;i<argc;) {
        const v = process.argv[i++];
        if (v.startsWith('-')) {
            switch (v.substr(1)) {
            case 'o':
                output = process.argv[i++];
                if (!output)
                {
                    console.error(`if-tsb: need a filepath after -o`);
                    error = true;
                }
                break;
            case 'w':
                watch = true;
                break;
            case '-clear-cache':
                clearCache = true;
                break;
            case '-version':
            case 'v':
                const packagejson = JSON.parse(fs.readFileSync(`${__dirname}${path.sep}..${path.sep}package.json`, 'utf-8'));
                console.log(packagejson.version);
                break;
            default:
                console.error(`if-tsb: unknown options: ${v}`);
                error = true;
                break;
            }
        } else {  
            targetPathes.push(v);
        }
    }
    
    if (error) return;
    if (clearCache) {
        await bundle.clearCache();
    }
    if (targetPathes.length === 0) {
        if (clearCache) return;
        targetPathes.push('.');
    }

    if (watch) {
        bundle.watch(targetPathes, output);
    } else {
        const ms = await bundle(targetPathes, output);
        console.log(`[${time()}] ${ms.toFixed(6)}ms`);
    }
})().catch(err=>console.error(err));
