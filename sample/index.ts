import value = require("./moduleexport");
import value2 = require("./moduleexport2");
import "./declaremodule";
import "./jsfile";

export let x = 0;

let b: number = value.v;
console.log(value2);

interface A {}

export type UnionString = "as" | "df";

export type TypesType = A | Test2;

export let c: A = {};

export class Test2 {}
