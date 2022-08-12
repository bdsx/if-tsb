import { Test3 as Test4 } from "./types";
import * as fs2 from 'fs';
import {Dir as Dir2} from 'fs';

export class Test {
}

declare module "." {
    let fromDeclaredModule:Test2;
    let fromCurrentModule:Test;
    let import_fs_dir:import('fs').Dir;
    let dir2:Dir2;
    let fs_dir:fs2.Dir;
    let imported:Test4;
    let number:number;
}

export let a = new Test;

export { };
