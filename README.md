## if-tsb: Insanely Fast TypeScript Bundler
if-tsb is Bundler for TypeScript.

```sh
npm i -g if-tsb # install
tsb # build
tsb . # build with specific path
tsb ./index.ts # build with specific entry
tsb ./tsconfig.json # build with specific tsconfig.json
tsb -o ./output.js # build with specific output
tsb -w # build with watch
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
* default all options
```js
{
    "entry": "./index.ts",
    "output": "[dirname]/[name].bundled.js",
    "bundlerOptions": {
        "globalModuleVarName": "__tsb",
        "checkCircularDependency": false, 
        "suppressDynamicImportErrors": false, 
        "cleanConsole": false,
        "verbose": false
    },
    "compilerOptions": {
        /* ... */
    }
}
```

### Build with API
```ts
import { bundle, bundleWatch } = require('if-tsb');

bundle(['./entry.ts'] /*, './output.js' */); // build

// bundleWatch(['./entry.ts']); // watch

```