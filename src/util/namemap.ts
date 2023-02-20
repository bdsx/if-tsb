import { identifierValidating } from "../checkvar";

export class NameMap<T> extends Map<string, T> {
    getFreeName(name: string): string {
        name = identifierValidating(name);
        if (this.has(name)) {
            const base = name;
            let num = 2;
            for (;;) {
                name = base + num;
                if (!this.has(name)) break;
                num++;
            }
        }
        return name;
    }
}
