import * as ts from "typescript";

const isExportingModuleMap = new WeakMap<ts.SourceFile, boolean>();

export namespace tshelper {
    export const builtin = new Set<string>([
        "assert",
        "buffer",
        "child_process",
        "cluster",
        "crypto",
        "dns",
        "domain",
        "events",
        "fs",
        "http",
        "https",
        "net",
        "os",
        "path",
        "punycode",
        "querystring",
        "readline",
        "repl",
        "stream",
        "string_decoder",
        "dgram",
        "url",
        "util",
        "v8",
        "vm",
        "zlib",
    ]);
    export function isExporting(node: ts.Node): boolean {
        if (ts.isVariableDeclaration(node)) {
            return isExporting(node.parent.parent);
        }
        if (node.parent.kind === ts.SyntaxKind.ExportSpecifier) return true;
        if (node.modifiers != null) {
            for (const mod of node.modifiers) {
                if (mod.kind === ts.SyntaxKind.ExportKeyword) return true;
            }
        }
        return false;
    }
    export function isRootIdentifier(node: ts.EntityName): boolean {
        const parent = node.parent;
        switch (parent.kind) {
            case ts.SyntaxKind.PropertyAccessExpression:
                if ((parent as ts.QualifiedName).left !== node) return false;
                return isRootIdentifier(parent as ts.QualifiedName);
            case ts.SyntaxKind.QualifiedName:
                if ((parent as ts.QualifiedName).left !== node) return false;
                return isRootIdentifier(parent as ts.QualifiedName);
            default:
                return true;
        }
    }
    export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
        if (node.modifiers == null) return false;
        for (const mod of node.modifiers) {
            if (mod.kind === kind) return true;
        }
        return false;
    }
    export function nameEquals(node: ts.MemberName, name: string): boolean {
        if (node.kind !== ts.SyntaxKind.Identifier) return false;
        return (node as ts.Identifier).text === name;
    }
    export function isExportingModule(sourceFile: ts.SourceFile): boolean {
        // sourceFile.externalModuleIndicator
        // typeChecker.getSymbolAtLocation(sourceFile) !== undefined;
        const res = isExportingModuleMap.get(sourceFile);
        if (res != null) return res;
        for (const st of sourceFile.statements) {
            if (isExporting(st)) {
                isExportingModuleMap.set(sourceFile, true);
                return true;
            }
        }
        isExportingModuleMap.set(sourceFile, false);
        return false;
    }
    export function isModuleDeclaration(
        node: ts.Node
    ): node is ts.ModuleDeclaration {
        if (!ts.isModuleDeclaration(node)) return false;
        return (node.flags & ts.NodeFlags.Namespace) === 0;
    }
    export function isNamespace(node: ts.Node): node is ts.ModuleDeclaration {
        if (!ts.isModuleDeclaration(node)) return false;
        return (node.flags & ts.NodeFlags.Namespace) !== 0;
    }
    export function getNodeName(node: ts.Node): string | null {
        if (ts.isClassDeclaration(node)) {
            if (node.name == null) {
                // export default
                return "default";
            } else {
                return node.name.text;
            }
        } else if (
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            tshelper.isNamespace(node) ||
            ts.isEnumDeclaration(node)
        ) {
            return node.name.text;
        } else if (ts.isVariableDeclaration(node)) {
            if (ts.isIdentifier(node.name)) {
                return node.name.text;
            }
            throw Error(
                `Unexpected name kind ${ts.SyntaxKind[node.name.kind]}`
            );
        } else {
            return null;
        }
    }
}
