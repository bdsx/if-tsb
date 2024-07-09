import ts = require("typescript");

export interface PropNameMap {
    [key: string]:
        | PropNameMap
        | ((factory: ts.NodeFactory) => ts.Node | void)
        | undefined;
}
export function propNameMap<T extends ts.Node>(
    factory: ts.NodeFactory,
    target: T,
    map: PropNameMap
): T | void {
    const remapper = new Remapper(map);
    const fn = remapper.enter(target);
    if (fn !== undefined) {
        return fn(factory) as any;
    }
}

class Remapper {
    constructor(private map: PropNameMap | undefined) {}
    enter<T extends ts.Node>(
        target: T
    ): ((factory: ts.NodeFactory) => ts.Node | void) | void {
        if (ts.isMetaProperty(target)) {
            if (this.map !== undefined) {
                const importObj = this.map.import;
                this.map = undefined;
                if (importObj === undefined) {
                } else if (typeof importObj === "function") {
                    return importObj;
                } else {
                    const fn = importObj[String(target.name.text)];
                    if (fn === undefined) {
                    } else if (typeof fn === "function") {
                        return fn;
                    } else {
                        this.map = fn;
                        const fn2 = fn.__invoke;
                        if (typeof fn2 === "function") {
                            return fn2;
                        }
                    }
                }
            }
        } else if (ts.isIdentifier(target)) {
            if (this.map !== undefined) {
                const fn = this.map[String(target.text)];
                this.map = undefined;

                if (fn === undefined) {
                } else if (typeof fn === "function") {
                    return fn;
                } else {
                    this.map = fn;
                    const fn2 = fn.__invoke;
                    if (typeof fn2 === "function") {
                        return fn2;
                    }
                }
            }
        } else if (ts.isPropertyAccessExpression(target)) {
            const internal = this.enter(target.expression);
            if (this.map !== undefined) {
                const fn = this.map[String(target.name.text)];
                this.map = undefined;

                if (fn === undefined) {
                } else if (typeof fn === "function") {
                    return fn;
                } else {
                    this.map = fn;
                    const fn2 = fn.__invoke;
                    if (typeof fn2 === "function") {
                        return fn2;
                    }
                }
            }
            if (internal !== undefined) {
                return (factory) => {
                    const expression = internal(factory);
                    if (expression === undefined) return;
                    if (expression.kind === undefined) debugger;
                    return factory.createPropertyAccessExpression(
                        expression as any,
                        target.name
                    );
                };
            }
        } else if (ts.isElementAccessExpression(target)) {
            const internal = this.enter(target.expression);
            if (
                this.map !== undefined &&
                ts.isStringLiteral(target.argumentExpression)
            ) {
                const fn = this.map[String(target.argumentExpression.text)];
                this.map = undefined;
                if (fn === undefined) {
                } else if (typeof fn === "function") {
                    return fn;
                } else {
                    this.map = fn;
                    const fn2 = fn.__invoke;
                    if (typeof fn2 === "function") {
                        return fn2;
                    }
                }
            }
            if (internal !== undefined) {
                return (factory) => {
                    const expression = internal(factory);
                    if (expression === undefined) return;
                    if (expression.kind === undefined) debugger;
                    return factory.createElementAccessExpression(
                        expression as any,
                        target.argumentExpression
                    );
                };
            }
        }
    }
}
