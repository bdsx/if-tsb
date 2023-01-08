import { Test3 as Test4, Test5 } from "./types";
import * as fs2 from 'fs';
import {Dir as Dir2} from 'fs';
import { IGlob } from 'glob';
import { number } from ".";

export class Test {
}

declare global {
    interface GlobalCls {
    }
    namespace Namespace {
        interface TypeInNamespace {
        }
    }
}

type GlobalClsRef = GlobalCls;
type IGlob2 = IGlob;
export enum Enum {
}
export const vardecl = 0;

declare module "." {
    let unionTypes:UnionString;
    let types:TypesType;
    let fromDeclaredModule:Test2;
    let fromCurrentModule:Test;
    let import_fs_dir:import('fs').Dir;
    let import_glob_iglob:import('glob').IGlob;
    let dir2:Dir2;
    let fs_dir:fs2.Dir;
    let imported:Test4;
    let number:number;
    let globalCls:GlobalCls;
    let globalClsRef:GlobalClsRef;
    let typeInNamespace:Namespace.TypeInNamespace;
    let enumValue:Enum;
    let a:typeof vardecl;

    interface Template<T> {
        v:T;
        is(v:any):v is T;
        t:IterableIterator<number>;
    }

    class Test3 extends Test5 {
    }

    interface DeclaredType {
    }

    let test:DeclaredType;
}

declare module "fs" {
    interface Dir {
        test2?:Dirent;
        test?:Test;
    }
}
declare module "glob" {
    interface IGlobBase {
        test?:Test;
        test2?:IGlob2;
    }
}

export let a = new Test;

export { };
