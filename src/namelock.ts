import { resolved } from "./util";

export namespace namelock
{
    const locks = new Map<string|number, (()=>void)[]>();
    export function lock(name:string|number):Promise<void>
    {
        const locked = locks.get(name);
        if (locked)
        {
            return new Promise(resolve=>{
                locked.push(resolve);
            });
        }
        locks.set(name, []);
        return resolved;
    }
    export function unlock(name:string|number):void
    {
        const locked = locks.get(name)!;
        if (locked.length === 0)
        {
            locks.delete(name);
            return;
        }
        locked.shift()!();
    }
    export async function waitAll():Promise<void>
    {
        const proms:Promise<void>[] = [];
        for (const arr of locks.values())
        {
            proms.push(new Promise(resolve=>{
                arr.push(resolve);
            }));
        }
        await Promise.all(proms);
    }
}
