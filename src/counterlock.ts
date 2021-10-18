import { resolved } from "./util";

export class CounterLock {
    private resolver:(()=>void)|null = null;
    private prom:Promise<void>|null = null;
    private counter = 0;

    increase():void {
        this.counter++;
    }

    decrease():void {
        this.counter--;
        if (this.counter === 0) {
            if (this.resolver !== null) {
                this.resolver();
            }
        }
    }

    ifZero():boolean {
        return this.counter === 0;
    }

    waitZero():Promise<void> {
        if (this.counter === 0) return resolved;
        if (this.prom === null) {
            this.prom = new Promise<void>(resolve=>{
                this.resolver = resolve;
            });
        }
        return this.prom;
    }
}
