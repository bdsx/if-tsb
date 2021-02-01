
export class ErrorPosition
{
    constructor(
        public readonly line:number,
        public readonly column:number,
        public readonly width:number,
        public readonly lineText:string)
    {
    }

    static stringify(pos:(ErrorPosition|null)[]):string
    {
        return JSON.stringify(pos.map(p=>p === null ? null : [p.line, p.column, p.width, p.lineText]));
    }
    static parse(str:string):(ErrorPosition|null)[]
    {
        return JSON.parse(str);
    }

}