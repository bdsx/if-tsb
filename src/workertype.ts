
export declare namespace WorkerThread {
    export let workerData:any;
    export let parentPort:MessagePort;

    export class MessagePort {
        postMessage(message:any):void;
        on(event:'message', on:(message:any)=>void):void;
        once(event:'message', on:(message:any)=>void):void;
        close():void;
    }

    export class Worker {
        constructor(path:string, workerData:any);
        postMessage(message:any):void;
        on(event:'message', on:(message:any)=>void):void;
        once(event:'message', on:(message:any)=>void):void;
        unref():void;
        ref():void;
    }
}

export function getWorkerThreadModule():typeof WorkerThread {
    return require('worker_thread');
}
