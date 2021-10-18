
export interface Reporter {
     report(source:string, line:number, column:number, code:number, message:string, lineText:string, width:number):void;
     reportMessage(code:number, message:string):void;
     reportFromCatch(err:any):boolean;
}
