
const reservedWords = {
    // for if-tsb
    'entry': true,

    'do': true,
    'if': true,
    'in': true,
    'for': true,
    'let': true,
    'new': true,
    'try': true,
    'var': true,
    'case': true,
    'else': true,
    'enum': true,
    'eval': true,
    'null': true,
    'this': true,
    'true': true,
    'void': true,
    'with': true,
    'break': true,
    'catch': true,
    'class': true,
    'const': true,
    'false': true,
    'super': true,
    'throw': true,
    'while': true,
    'yield': true,
    'delete': true,
    'export': true,
    'import': true,
    'public': true,
    'return': true,
    'static': true,
    'switch': true,
    'typeof': true,
    'default': true,
    'extends': true,
    'finally': true,
    'package': true,
    'private': true,
    'continue': true,
    'debugger': true,
    'function': true,
    'arguments': true,
    'interface': true,
    'protected': true,
    'implements': true,
    'instanceof': true,
    'await': true,
    'NaN':true,
    'Infinity':true,
    'undefined':true,
};

export function identifierValidating(name:string):string
{
    name = name.replace(/[^0-9A-Za-z$_\u007f-\uffff]+/g, '_');
    if (name === '') return '_';
    const first = name.charCodeAt(0);
    if (0x30 <= first && first <= 0x39) return '_'+name;
    if (name in reservedWords) return '_'+name;
    return name;
}
