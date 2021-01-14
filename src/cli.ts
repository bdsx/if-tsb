#!/usr/bin/env node

import { bundle, bundleWatch } from "./index";

(async()=>{

    const path:string[] = [];

    const argc = process.argv.length;
    let watch = false;
    let error = false;
    let output:string|undefined = undefined;
    
    for (let i=2;i<argc;)
    {
        const v = process.argv[i++];
        if (v.startsWith('-'))
        {
            switch (v.substr(1))
            {
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
            default:
                console.error(`if-tsb: unknown options: ${v}`);
                error = true;
                break;
            }
        }
        else
        {  
            path.push(v);
        }
    }
    
    if (error) return;
    if (path.length === 0) path.push('.');

    if (watch)
    {
        bundleWatch(path, output);
    }
    else
    {
        await bundle(path, output);
    }
})().catch(err=>console.error(err));
