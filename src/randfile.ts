
import fs = require('fs');

const MAXIMUM_QUEUE_SIZE = 16*1024;

export class File
{
    private fd:number = -1;
    private latestTask:Promise<void>|null;
    private queuedSize = 0;
    private error:Error|null = null;
    private readonly queue:[Buffer, number][] = [];

    constructor(path:string)
    {
        this.latestTask = new Promise((resolve, reject)=>{
            fs.open(path, 'w', (err, fd)=>{
                if (err)
                {
                    this.error = err;
                    reject(err);
                }
                else
                {
                    this.fd = fd;
                    this.latestTask = null;
                    resolve();
                }
            });
        })
    }

    private _write(buffer:Buffer, offset:number):Promise<void>
    {
        return new Promise((resolve, reject)=>{
            fs.write(this.fd, buffer, offset, err=>{
                if (err)
                {
                    this.error = err;
                    reject(err);
                }
                else
                {
                    resolve();
                }
            });
        });
    }

    async write(buffer:Buffer, offset:number):Promise<void>
    {
        if (this.error !== null) throw this.error;
        if (this.queuedSize >= MAXIMUM_QUEUE_SIZE)
        {
            await this.latestTask;
        }
        this.queue.push([buffer, offset]);
        if (this.latestTask !== null)
        {
            this.latestTask = (async()=>{
                while (this.queue.length !== 0)
                {
                    const [buf, off] = this.queue.shift()!;
                    await this._write(buf, off);
                }
                this.latestTask = null;
            })();
        }
        this.queuedSize += buffer.length;
    }

    async end():Promise<void>
    {
        await this.latestTask;
        await new Promise<void>((resolve, reject)=>{
            fs.close(this.fd,err=>{
                if (err)
                {
                    this.error = err;
                    reject(err);
                }
                else
                {
                    resolve();
                }
            });
        });
    }
}