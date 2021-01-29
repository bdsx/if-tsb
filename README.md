## if-tsb: Insanely Fast TypeScript Bundler
if-tsb is Bundler for TypeScript.

```sh
npm i -g if-tsb # install
if-tsb # build
if-tsb . # build with specific path
if-tsb ./index.ts # build with specific entry
if-tsb ./tsconfig.json # build with specific tsconfig.json
if-tsb -o ./output.js # build with specific output
if-tsb -w # build with watch
if-tab --clear-cache # clear cache
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
* all default options
```js
{
    "entry": "./index.ts",
    "output": "[dirname]/[name].bundled.js",
    "bundlerOptions": {
        "globalModuleVarName": "__tsb",
        "checkCircularDependency": false, 
        "suppressDynamicImportErrors": false, 
        "cleanConsole": false, // clean console before repeated by watch
        "faster": false, // skip external parsing and reporting, cannot emit some d.ts and will not replace enum const
        "watchWaiting": 30, // bundling after ${watchWaiting}ms from file modifying
        "verbose": false,
        "bundleExternals":false, // bundle files in node_modules
        "externals": [] // files that do not bundle
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