## if-tsb: Insanely Fast TypeScript Bundler
if-tsb is Bundler for TypeScript

```sh
npm i -g if-tsb # install
tsb # build
tsb ./index.ts # build with specific entry
tsb -w # watch
```


### tsconfig.json

* define entry  
```js
{
    "entry": "./entry.ts", // output: "./entry.bundle.js"
    "compilerOptions": {
        /* ... */
    }
}
```
* define multiple entry  
```js
{
    "entry": ["./entry.ts", "./entry2.ts"], // output: "./entry.bundle.js", "./entry2.bundle.js"
    "compilerOptions": {
        /* ... */
    }
}
```
* define entry with specific output  
```js
{
    "entry": {
        "./entry.ts": "./bundled.output.js",
        "./entry2.ts": "./bundled.output2.js"
    },
    "compilerOptions": {
        /* ... */
    }
}
```
* define entry with specific output alternate  
```js
{
    "entry": "./entry.ts",
    "output": "./bundled.[name].js", // output: "./bundled.entry.js"
    "compilerOptions": {
        /* ... */
    }
}
```