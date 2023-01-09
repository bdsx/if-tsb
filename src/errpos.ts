export class ErrorPosition {
    constructor(
        public readonly line: number,
        public readonly column: number,
        public readonly width: number,
        public readonly lineText: string
    ) {}
}
