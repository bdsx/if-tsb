## if-tsb: Insanely Fast TypeScript Bundler
if-tsb is Bundler for TypeScript

```sh
npm i if-tsb # install
tsb # build
tsb ./index.ts # build with specific entry
tsb -w # watch
```


### tsconfig.json
```json
{
    "entry": {
        "./entry.input.ts": "./bundled.output.js"
    },
    "compilerOptions": {
        /* ... */
    }
}
```