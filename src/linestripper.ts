
export class LineStripper
{
    index = 0;
    stripedLine = 0;

    strippedComments = '';

    private noMoreStrip = false;

    constructor(public readonly content:string) {
    }

    _strip(cb:(line:string)=>boolean):string|null {
        let idx = this.content.indexOf('\n', this.index);
        if (idx == -1) return null;
    
        let cr = 0;
        if (this.content.charAt(idx-1) === '\r') cr = 1;
        const actual = this.content.substring(this.index, idx-cr);
        if (cb(actual)) {
            this.stripedLine++;
            this.index = idx+1;
            return actual;
        }
        return null;
    }
    
    strip(cb:(line:string)=>boolean):string|null {
        if (this.noMoreStrip) return null;
        let commentLine:string|null;
        while ((commentLine = this._strip(line=>{
            line = line.trim();
            if (line === '') return true;
            if (line.startsWith('//')) return true;

            if (line.startsWith('/*')) {
                const commentOpen = this.content.indexOf('/*', this.index);
                let commentClose = this.content.indexOf('*/', commentOpen+2);
                if (commentClose === -1) return false;
                commentClose += 2;
                this.noMoreStrip = true;

                let end = this.content.indexOf('\n', commentClose);
                if (end === -1) return false;
                if (this.content.substring(commentClose, end).trim() === '')
                {
                    end++;
                    this.strippedComments += this.content.substring(this.index, end);
                    this.index = end;
                }
                return false;
            }
            return false;
        })) !== null) {
            this.strippedComments += commentLine+'\n';
        }
        while (commentLine = this._strip(line=>/^var [,_a-z ]+;$/.test(line))) {
            this.strippedComments += commentLine+'\n';
        }
        return this._strip(cb);
    }
}
