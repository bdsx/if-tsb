import ts = require("typescript");
import { tshelper } from "../tshelper";

export class ErrorPosition {
    constructor(
        public readonly fileName: string,
        public readonly line: number,
        public readonly column: number,
        public readonly width: number,
        public readonly lineText: string
    ) {}

    static fromNode(node: ts.Node): ErrorPosition | null {
        const source = node.getSourceFile();
        if (source == null) {
            return null;
        }
        const fileName = source.fileName;
        const pos = source.getLineAndCharacterOfPosition(node.getStart());
        const width = node.getWidth();

        const sourceText = source.getFullText();
        const lines = source.getLineStarts();
        const start = lines[pos.line];
        const linenum = pos.line + 1;
        const end =
            linenum < lines.length ? lines[linenum] - 1 : sourceText.length;

        const lineText = sourceText.substring(start, end);
        return new ErrorPosition(
            fileName,
            linenum,
            pos.character,
            width,
            lineText
        );
    }

    report(code: number, message: string, filePath?: string): void {
        tshelper.report(
            filePath ?? this.fileName,
            this.line,
            this.column,
            code,
            message,
            this.lineText,
            this.width
        );
    }

    static report(
        node: ts.Node,
        code: number,
        message: string,
        filePath?: string
    ): void {
        const pos = ErrorPosition.fromNode(node);
        if (pos === null) {
            tshelper.report(filePath ?? "?", 0, 0, code, message, "", 0);
        } else {
            pos.report(code, message, filePath);
        }
    }
}
