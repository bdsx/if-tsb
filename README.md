## if-tsb: Insanely Fast TypeScript Bundler

if-tsb is the bundler for TypeScript.

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

-   define a entry

```js
{
    "entry": "./entry.ts", // output: "./entry.bundle.js"
    "compilerOptions": {
        /* ... */
    }
}
```

-   define multiple entries

```js
{
    "entry": ["./entry.ts", "./entry2.ts"], // output: "./entry.bundle.js", "./entry2.bundle.js"
    "compilerOptions": {
        /* ... */
    }
}
```

-   define entries with specific output

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

-   define entries with specific output alternate

```js
{
    "entry": ["./entry.ts", "./entry2.ts"],
    "output": "./bundled.[name].js", // output: "./bundled.entry.js"
    "compilerOptions": {
        /* ... */
    }
}
```

-   all default options

```js
{
    "entry": "./index.ts",
    "output": "[dirname]/[name].bundled.js",
    "import": ["path/to/other/tsconfig/directory"],
    "bundlerOptions": {
        "globalModuleVarName": "__tsb",
        "checkCircularDependency": false,
        "suppressDynamicImportErrors": false,
        "suppressModuleNotFoundErrors": false,
        "cleanConsole": false, // clean console before repeated by watch
        "faster": false, // skip external parsing and reporting, cannot emit some d.ts and will not replace enum const
        "watchWaiting": 30, // bundling after ${watchWaiting}ms from file modifying
        "verbose": false,
        "bundleExternals": false, // boolean|string[], bundle files in node_modules
        "browser": false, // boolean|"./path/to/web/root"
        "externals": [], // files that do not bundle
        "cacheMemory": "1MB", // cache memory for watching
        "module": "none", // "commonjs"|"none"|"private"|"self"|"window"|"this"|"var (varname)"|"let (varname)"|"const (varname)"
        "preimport": [], // modules for pre-import. it replaces require('name') to __tsb.name,
        "noSourceMapWorker": false, // do not use the worker for the sourcemap generating.
        "wrapBegin": "", // begining of the bundled file. it does not contain any lines
        "wrapEnd": "" // ending of the bundled file. it does not contain any lines
        "declWrapBegin": "", // begining of the declartion file. it does not contain any lines
        "declWrapEnd": "" // ending of the declartion file. it does not contain any lines
    },
    "compilerOptions": {
        /* ... */
    }
}
```

-   define entries with bundler options

```js
{
    "entry": {
        "./entry.ts": {
            "output": "./bundled.output.js",
            /** "bundlerOptions": { ... }, */
            /** "compilerOptions": { ... } */
        },
        "./entry2.ts": {
            "output": "./bundled.output2.js",
            /** "bundlerOptions": { ... }, */
            /** "compilerOptions": { ... } */
        }
    },
    "bundlerOptions": {
        /* ... */
    },
    "compilerOptions": {
        /* ... */
    }
}
```

-   Sharing codes

```js
{
    "entry": "./index.ts",
    "share": {
        "./lib.ts":"share",
        "./libdir/**/*.ts":"share2",
        "globalmodule": "share3"
    },
    "bundlerOptions": {
        /* ...bundlerOptions */
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

// bundle.watch(['./entry.ts']); // watch

```

### Links

-   [Discord](https://discord.gg/pC9XdkC)
-   [Bug Report/Issues](https://github.com/bdsx/if-tsb/issues)
-   [Donate/PayPal](https://rua.kr/webapp/donate)
