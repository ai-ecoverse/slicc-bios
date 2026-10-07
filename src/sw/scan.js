const regexAfterWord = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
const controls = new Set(['if', 'while', 'for', 'with']);
const objectAfter = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '?',
  '!',
  '&',
  '|',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);
const word = /[\w$\u0080-￿]/;
const space = /\s/;

class Scanner {
  constructor(source) {
    this.source = source;
    this.at = source.startsWith('#!') ? source.indexOf('\n') + 1 || source.length : 0;
    this.previous = { kind: 'start', value: '' };
    this.parens = [];
    this.braces = [];
    this.found = [];
    this.module = false;
  }

  skipTrivia() {
    const { source } = this;
    while (this.at < source.length) {
      const char = source[this.at];
      if (space.test(char)) this.at++;
      else if (char === '/' && source[this.at + 1] === '/') {
        const end = source.indexOf('\n', this.at);
        this.at = end < 0 ? source.length : end;
      } else if (char === '/' && source[this.at + 1] === '*') {
        const end = source.indexOf('*/', this.at + 2);
        this.at = end < 0 ? source.length : end + 2;
      } else return;
    }
  }

  readString(quote) {
    const start = this.at + 1;
    let at = start;
    while (at < this.source.length && this.source[at] !== quote)
      at += this.source[at] === '\\' ? 2 : 1;
    this.at = at + 1;
    return { kind: 'string', value: this.source.slice(start, at), start, end: at };
  }

  readTemplate(resume = false) {
    const { source } = this;
    if (!resume) this.at++;
    const start = this.at;
    while (this.at < source.length) {
      const char = source[this.at];
      if (char === '\\') this.at += 2;
      else if (char === '`') {
        this.at++;
        const end = this.at - 1;
        if (resume) return { kind: 'template', value: '`' };
        return { kind: 'template', value: source.slice(start, end), start, end, whole: true };
      } else if (char === '$' && source[this.at + 1] === '{') {
        this.at += 2;
        this.braces.push('template');
        return { kind: 'punct', value: '${' };
      } else this.at++;
    }
    return { kind: 'template', value: '`' };
  }

  readRegex() {
    const { source } = this;
    let at = this.at + 1;
    let inClass = false;
    while (at < source.length && source[at] !== '\n') {
      const char = source[at];
      if (char === '\\') at += 2;
      else if (char === '/' && !inClass) break;
      else {
        if (char === '[') inClass = true;
        else if (char === ']') inClass = false;
        at++;
      }
    }
    if (source[at] === '/') {
      at++;
      while (at < source.length && word.test(source[at])) at++;
    }
    this.at = at;
    return { kind: 'regex', value: '/' };
  }

  regexAllowed() {
    const { kind, value } = this.previous;
    if (kind === 'start') return true;
    if (kind === 'word') return regexAfterWord.has(value);
    if (kind !== 'punct') return false;
    if (value === ')') return this.previous.control === true;
    if (value === '}') return this.previous.block === true;
    return value !== ']' && value !== '++' && value !== '--';
  }

  readPunct() {
    const { source } = this;
    const two = source.slice(this.at, this.at + 2);
    if (two === '++' || two === '--' || two === '=>' || two === '?.') {
      this.at += 2;
      return { kind: 'punct', value: two };
    }
    const char = source[this.at++];
    if (char === '(') {
      this.parens.push(this.previous.kind === 'word' && controls.has(this.previous.value));
    } else if (char === ')') {
      return { kind: 'punct', value: ')', control: this.parens.pop() === true };
    } else if (char === '{') {
      const { kind, value } = this.previous;
      const expression =
        (kind === 'punct' && objectAfter.has(value)) ||
        (kind === 'word' && regexAfterWord.has(value));
      this.braces.push(expression ? 'expression' : 'block');
    } else if (char === '}') {
      const opened = this.braces.pop();
      if (opened === 'template') return this.readTemplate(true);
      return { kind: 'punct', value: '}', block: opened !== 'expression' };
    }
    return { kind: 'punct', value: char };
  }

  next() {
    this.skipTrivia();
    const { source } = this;
    if (this.at >= source.length) return undefined;
    const char = source[this.at];
    let token;
    if (char === '"' || char === "'") token = this.readString(char);
    else if (char === '`') token = this.readTemplate();
    else if (char === '/' && this.regexAllowed()) token = this.readRegex();
    else if (word.test(char) || char === '#') {
      const start = this.at;
      do this.at++;
      while (this.at < source.length && word.test(source[this.at]));
      token = { kind: 'word', value: source.slice(start, this.at), start };
    } else token = this.readPunct();
    return token;
  }

  peek() {
    const saved = [this.at, this.previous, [...this.parens], [...this.braces]];
    const token = this.next();
    [this.at, this.previous, this.parens, this.braces] = saved;
    return token;
  }

  record(token, dynamic) {
    this.found.push({
      value: token.value,
      start: token.start,
      end: token.end,
      dynamic,
      statement: this.statement,
    });
  }

  dynamicImport() {
    this.previous = this.next();
    const argument = this.peek();
    if (argument?.kind !== 'string' && !argument?.whole) return;
    const string = this.next();
    const after = this.peek();
    if (after?.value === ')' || after?.value === ',') this.record(string, true);
    this.previous = string;
  }

  clause(stop) {
    for (let token = this.peek(); token && !stop(token); token = this.peek()) {
      const before = this.previous.value;
      this.previous = this.next();
      if (token.kind === 'string' && (before === 'from' || before === 'import')) {
        this.record(this.previous, false);
        return;
      }
    }
  }

  importStatement() {
    const following = this.peek();
    if (following?.value === '(') this.dynamicImport();
    else if (following?.kind === 'punct' && following.value !== '{' && following.value !== '*')
      return;
    else {
      this.module = true;
      this.clause(
        (token) => token.value === ';' || token.value === '=' || token.value === 'import'
      );
    }
  }

  exportStatement() {
    const following = this.peek();
    if (following?.kind === 'punct' && following.value === ':') return;
    this.module = true;
    if (following?.value !== '*' && following?.value !== '{') return;
    let closed = false;
    this.clause((token) => {
      if (closed && token.value !== 'from' && token.kind !== 'string') return true;
      if (token.value === '}') closed = true;
      return token.value === ';';
    });
  }

  run() {
    for (let token = this.next(); token; token = this.next()) {
      const property =
        this.previous.kind === 'punct' &&
        (this.previous.value === '.' || this.previous.value === '?.');
      this.previous = token;
      if (token.kind !== 'word' || property) continue;
      this.statement = token.start;
      if (token.value === 'import') this.importStatement();
      else if (token.value === 'export') this.exportStatement();
    }
    return this.found;
  }
}

export function scanImports(source) {
  return new Scanner(source).run();
}

export function scan(source) {
  const scanner = new Scanner(source);
  return { imports: scanner.run(), module: scanner.module };
}
