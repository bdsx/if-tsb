import * as fs2 from "fs";
import { Dir as Dir2 } from "fs";
import { glob } from "glob";
import { number } from ".";
import { Test3 as Test4, Test5 } from "./types";
import { external } from "./externals/test";

export class Test {}
export type b = typeof external;

declare global {
    interface GlobalCls {}
    namespace Namespace {
        interface TypeInNamespace {}
    }
}

type GlobalClsRef = GlobalCls;
type IGlob2 = typeof glob;
export enum Enum {}
export const vardecl = 0;

declare module "." {
    let unionTypes: UnionString;
    let types: TypesType;
    let fromDeclaredModule: Test2;
    let fromCurrentModule: Test;
    let import_fs_dir: import("fs").Dir;
    let import_glob_iglob: typeof import("glob").glob;
    let dir2: Dir2;
    let fs_dir: fs2.Dir;
    let imported: Test4;
    let number: number;
    let globalCls: GlobalCls;
    let globalClsRef: GlobalClsRef;
    let typeInNamespace: Namespace.TypeInNamespace;
    let enumValue: Enum;
    let a: typeof vardecl;

    interface Template<T> {
        v: T;
        is(v: any): v is T;
        t: IterableIterator<number>;
    }

    class Test3 extends Test5 {}

    interface DeclaredType {}

    let test: DeclaredType;
}

declare module "fs" {
    interface Dir {
        test2?: Dirent;
        test?: Test;
    }
}
declare module "glob" {
    interface IGlobBase {
        test?: Test;
        test2?: IGlob2;
    }
}

export let a = new Test();

export {};
