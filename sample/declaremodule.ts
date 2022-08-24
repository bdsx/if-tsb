import { Test3 as Test4 } from "./types";
import * as fs2 from 'fs';
import {Dir as Dir2} from 'fs';

export class Test {
}
declare global {
    interface GlobalCls {
    }
}

type GlobalClsRef = GlobalCls;

declare module "." {
    let fromDeclaredModule:Test2;
    let fromCurrentModule:Test;
    let import_fs_dir:import('fs').Dir;
    let dir2:Dir2;
    let fs_dir:fs2.Dir;
    let imported:Test4;
    let number:number;
    let globalCls:GlobalCls;
    let globalClsRef:GlobalClsRef;

    interface Template<T> {
        v:T;
        is(v:any):v is T;
        t:IterableIterator<number>;
    }

    interface DeclaredType {
    }

    let test:DeclaredType;
}

export let a = new Test;

export { };
