const identifier =
  /#?(?:[\p{ID_Start}$_]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))(?:[\p{ID_Continue}$\u200c\u200d]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))*/uy;
const number =
  /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)n?/y;
const punctuator =
  /\.\.\.|===|!==|\*\*=|<<=|&&=|\|\|=|\?\?=|=>|==|!=|<=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|&&|\|\||\?\?|\?\.(?!\d)|\+\+|--|\*\*|<<|[{}()[\];,<>=!+\-*/%&|^~?:.@]/y;
const lineBreak = /[\n\r\u2028\u2029]/;
const blankable = /\S/g;
const words = (text) => new Set(text.split(' '));
const binary = words('|| && ?? | ^ & == != === !== < <= << + - * / % ** instanceof');
const assignments = words('= += -= *= /= %= **= <<= &= |= ^= &&= ||= ??=');
const prefixes = words('! ~ + - ++ -- typeof void delete await');
const tsModifiers = words('public private protected readonly override');
const memberModifiers = new Set([...tsModifiers, 'abstract', 'declare', 'static', 'accessor']);
const statementKeywords = words(
  'if for while do return throw try switch break continue with debugger'
);
const endsYield = new Set([')', ']', '}', ',', ';', ':']);

class Fail extends Error {}
class Unsupported extends Error {}

export class TypeScriptError extends SyntaxError {
  constructor(message, file, line, column) {
    super(`${file}:${line}:${column}: ${message}`);
    this.name = 'TypeScriptError';
    this.code = 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';
    this.file = file;
    this.line = line;
    this.column = column;
  }
}

class Lexer {
  constructor(source) {
    this.source = source;
    const end = source.search(lineBreak);
    this.pos = source.startsWith('#!') ? (end < 0 ? source.length : end) : 0;
    this.stack = [];
  }

  trivia() {
    const { source } = this;
    let broke = false;
    while (this.pos < source.length) {
      const char = source[this.pos];
      if (char === '/' && source[this.pos + 1] === '/') {
        const end = source.slice(this.pos).search(lineBreak);
        this.pos = end < 0 ? source.length : this.pos + end;
      } else if (char === '/' && source[this.pos + 1] === '*') {
        const end = source.indexOf('*/', this.pos + 2);
        if (end < 0) throw new Fail('unterminated comment', { cause: this.pos });
        broke ||= lineBreak.test(source.slice(this.pos, end));
        this.pos = end + 2;
      } else if (/\s/.test(char)) {
        broke ||= lineBreak.test(char);
        this.pos++;
      } else break;
    }
    return broke;
  }

  token(type, value, start, nl) {
    return { type, value, start, end: this.pos, nl };
  }

  string(quote, start, nl) {
    const { source } = this;
    let at = start + 1;
    while (source[at] !== quote) {
      if (at >= source.length || source[at] === '\n' || source[at] === '\r')
        throw new Fail('unterminated string', { cause: start });
      at += source[at] === '\\' ? 2 : 1;
    }
    this.pos = at + 1;
    return this.token('string', source.slice(start + 1, at), start, nl);
  }

  template(start, from, nl) {
    const { source } = this;
    let at = from;
    while (at < source.length) {
      const char = source[at];
      if (char === '\\') at += 2;
      else if (char === '`') {
        this.pos = at + 1;
        return this.token('template', '`', start, nl);
      } else if (char === '$' && source[at + 1] === '{') {
        this.pos = at + 2;
        this.stack.push('template');
        return this.token('head', '${', start, nl);
      } else at++;
    }
    throw new Fail('unterminated template', { cause: start });
  }

  sticky(pattern, type) {
    pattern.lastIndex = this.pos;
    const match = pattern.exec(this.source);
    if (!match) return undefined;
    const start = this.pos;
    this.pos += match[0].length;
    return { type, value: match[0], start, end: this.pos };
  }

  next() {
    const nl = this.trivia();
    const { source, pos } = this;
    if (pos >= source.length) return this.token('eof', '', pos, true);
    const char = source[pos];
    if (char === '"' || char === "'") return this.string(char, pos, nl);
    if (char === '`') return this.template(pos, pos + 1, nl);
    if (char === '}' && this.stack.at(-1) === 'template') {
      this.stack.pop();
      return this.template(pos, pos + 1, nl);
    }
    const found =
      (/\d/.test(char) || (char === '.' && /\d/.test(source[pos + 1] ?? ''))
        ? this.sticky(number, 'number')
        : undefined) ??
      this.sticky(identifier, 'name') ??
      this.sticky(punctuator, 'punct');
    if (!found) throw new Fail(`unexpected character ${JSON.stringify(char)}`, { cause: pos });
    found.nl = nl;
    if (found.value === '{') this.stack.push('brace');
    else if (found.value === '}') this.stack.pop();
    return found;
  }

  regex(start, nl) {
    const { source } = this;
    let at = start + 1;
    let inClass = false;
    while (inClass || source[at] !== '/') {
      const char = source[at];
      if (at >= source.length || lineBreak.test(char))
        throw new Fail('unterminated regex', { cause: start });
      if (char === '\\') at++;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      at++;
    }
    this.pos = at + 1;
    identifier.lastIndex = this.pos;
    this.pos += identifier.exec(source)?.[0].length ?? 0;
    return this.token('regex', '/', start, nl);
  }
}

class Stripper {
  constructor(source) {
    this.source = source;
    this.lexer = new Lexer(source);
    this.blanks = [];
    this.marks = [];
    this.prevEnd = 0;
    this.safe = 0;
    this.failedArrows = new Set();
    this.tok = { type: 'start', end: 0 };
  }

  save() {
    return {
      pos: this.lexer.pos,
      stack: [...this.lexer.stack],
      tok: this.tok,
      prevEnd: this.prevEnd,
      safe: this.safe,
      blanks: this.blanks.length,
      marks: this.marks.length,
    };
  }

  restore(state) {
    this.lexer.pos = state.pos;
    this.lexer.stack = state.stack;
    this.tok = state.tok;
    this.prevEnd = state.prevEnd;
    this.safe = state.safe;
    this.blanks.length = state.blanks;
    this.marks.length = state.marks;
  }

  attempt(work) {
    const state = this.save();
    try {
      work();
      return true;
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      this.restore(state);
      return false;
    }
  }

  peek(count = 1) {
    const state = this.save();
    let token;
    try {
      for (let index = 0; index < count; index++) this.next();
      token = this.tok;
    } catch {
      const end = this.source.length;
      token = { type: 'eof', value: '', start: end, end, nl: true };
    }
    this.restore(state);
    return token;
  }

  next() {
    this.prevEnd = this.tok.end;
    this.tok = this.lexer.next();
  }

  is(value, token = this.tok) {
    return token.value === value && (token.type === 'punct' || token.type === 'name');
  }

  eat(value) {
    if (!this.is(value)) return false;
    this.next();
    return true;
  }

  expect(value) {
    if (!this.eat(value)) this.fail(`expected "${value}"`);
  }

  at(type) {
    return this.tok.type === type;
  }

  fail(message = 'unexpected token') {
    const shown = this.at('eof') ? 'the end of the file' : `"${this.tok.value}"`;
    const error = new Fail(`${message}, found ${shown}`, { cause: this.tok.start });
    if (!(this.furthest?.cause > error.cause)) this.furthest = error;
    throw error;
  }

  unsupported(what, at = this.tok.start) {
    throw new Unsupported(`${what} is not supported by type stripping`, { cause: at });
  }

  name() {
    if (!this.at('name')) this.fail('expected a name');
    this.next();
  }

  nameOrString() {
    if (this.at('string')) this.next();
    else this.name();
  }

  blank(start, end = this.prevEnd) {
    if (end > start) this.blanks.push([start, end]);
  }

  blankToken() {
    const { start, end } = this.tok;
    this.next();
    this.blank(start, end);
  }

  clean() {
    return this.prevEnd === this.safe;
  }

  blankWhole(start, clean) {
    if (!clean) this.marks.push([start, ';']);
    this.blank(start);
    this.safe = this.prevEnd;
  }

  terminated() {
    return this.is('}') || this.at('eof') || this.tok.nl;
  }

  semicolon() {
    if (this.is(';')) {
      this.next();
      this.safe = this.prevEnd;
    } else if (!this.terminated()) this.fail('expected ";"');
  }

  program() {
    this.next();
    while (!this.at('eof')) this.statement();
    return this.output();
  }

  output() {
    const ranges = this.blanks.toSorted((a, b) => a[0] - b[0]);
    const marks = new Map(this.marks);
    let out = '';
    let at = 0;
    for (const [start, end] of ranges) {
      if (end <= at) continue;
      const from = Math.max(start, at);
      out += this.source.slice(at, from);
      for (let index = from; index < end; index++) {
        out += marks.get(index) ?? this.source[index].replace(blankable, ' ');
      }
      at = end;
    }
    return out + this.source.slice(at);
  }

  statement() {
    const start = this.tok.start;
    const clean = this.clean();
    if (this.at('name')) this.namedStatement(start, clean);
    else if (this.is('{')) this.block();
    else if (this.is(';')) this.semicolon();
    else if (this.is('@')) this.unsupported('A decorator');
    else this.expressionStatement();
  }

  namedStatement(start, clean) {
    const word = this.tok.value;
    const after = this.peek();
    if (statementKeywords.has(word)) this[`${word}Statement`]();
    else if (this.declaration(start, clean)) this.safe = this.prevEnd;
    else if (this.typeStatement(start, clean)) return;
    else if (word === 'import' && !this.is('(', after) && !this.is('.', after))
      this.importDeclaration(start, clean);
    else if (word === 'export') this.exportDeclaration(start, clean);
    else if (this.isVariable()) {
      this.variables();
      this.semicolon();
    } else if (this.is(':', after)) {
      this.next();
      this.next();
      this.statement();
    } else this.expressionStatement();
  }

  isVariable() {
    const word = this.tok.value;
    const after = this.peek();
    if (word === 'const' && this.is('enum', after)) this.unsupported('A TypeScript enum');
    if (word === 'var' || word === 'const') return this.at('name');
    if (word === 'using' || (word === 'await' && this.is('using', after) && !after.nl)) {
      const bound = word === 'using' ? after : this.peek(2);
      return (
        bound.type === 'name' &&
        !bound.nl &&
        !['in', 'of', 'instanceof', 'as'].includes(bound.value)
      );
    }
    return this.is('let') && (after.type === 'name' || this.is('[', after) || this.is('{', after));
  }

  declaration(start, clean) {
    const word = this.tok.value;
    const after = this.peek();
    if (word === 'function' || (word === 'async' && this.is('function', after) && !after.nl)) {
      this.functionDeclaration(start, clean);
      return true;
    }
    if (word === 'class' || (word === 'abstract' && this.is('class', after) && !after.nl)) {
      if (word === 'abstract') this.blankToken();
      this.classDefinition();
      return true;
    }
    return false;
  }

  typeStatement(start, clean) {
    const word = this.tok.value;
    const after = this.peek();
    if (after.nl || !this.at('name')) return false;
    const marks = this.marks.length;
    if (word === 'interface' && after.type === 'name') this.interfaceDeclaration();
    else if (word === 'type' && after.type === 'name' && ['=', '<'].includes(this.peek(2).value))
      this.typeAlias();
    else if (word === 'declare' && after.type === 'name') this.ambient();
    else if (word === 'enum' && after.type === 'name') this.unsupported('A TypeScript enum');
    else if ((word === 'namespace' || word === 'module') && ['name', 'string'].includes(after.type))
      this.namespace(this.tok.start);
    else return false;
    this.marks.length = marks;
    this.blankWhole(start, clean);
    return true;
  }

  interfaceDeclaration() {
    this.next();
    this.name();
    this.typeParametersIfAny();
    if (this.eat('extends')) this.typeList();
    this.balanced();
  }

  typeAlias() {
    this.next();
    this.name();
    this.typeParametersIfAny();
    this.expect('=');
    this.type();
    this.semicolon();
  }

  ambient() {
    this.next();
    const word = this.tok.value;
    const opaque = ['enum', 'namespace', 'module', 'global'].includes(word);
    if (opaque || (word === 'const' && this.is('enum', this.peek()))) {
      while (!this.is('{') && !this.is(';') && !this.at('eof') && !this.tok.nl) this.next();
      if (this.is('{')) this.balanced();
      else this.semicolon();
    } else if (word === 'function' || word === 'async') this.functionDeclaration(0, true, true);
    else if (word === 'class' || word === 'abstract') {
      this.eat('abstract');
      this.classDefinition();
    } else if (word === 'interface') this.interfaceDeclaration();
    else if (word === 'type') this.typeAlias();
    else if (this.isVariable()) {
      this.variables();
      this.semicolon();
    } else this.fail();
  }

  namespace(start) {
    this.next();
    this.next();
    while (this.eat('.')) this.name();
    this.expect('{');
    while (!this.is('}')) {
      if (this.at('eof')) this.fail();
      const at = this.tok.start;
      const count = this.blanks.length;
      this.statement();
      const whole = this.blanks.slice(count).some(([from, to]) => from <= at && to >= this.prevEnd);
      if (!whole && !this.is(';', { type: 'punct', value: this.source[at] }))
        this.unsupported('A TypeScript namespace with values', start);
    }
    this.next();
  }

  block() {
    this.functionBody();
    this.safe = this.prevEnd;
  }

  functionBody() {
    this.expect('{');
    this.safe = this.prevEnd;
    while (!this.is('}')) {
      if (this.at('eof')) this.fail();
      this.statement();
    }
    this.next();
  }

  expressionStatement() {
    this.expression();
    this.semicolon();
  }

  ifStatement() {
    this.next();
    this.parenthesized();
    this.statement();
    if (this.eat('else')) this.statement();
  }

  parenthesized() {
    this.expect('(');
    this.expression();
    this.expect(')');
  }

  forStatement() {
    this.next();
    this.eat('await');
    this.expect('(');
    if (this.isVariable()) this.variables(true);
    else if (!this.is(';')) this.expression(true);
    if (this.eat('of') || this.eat('in')) this.expression();
    else {
      this.expect(';');
      if (!this.is(';')) this.expression();
      this.expect(';');
      if (!this.is(')')) this.expression();
    }
    this.expect(')');
    this.statement();
  }

  whileStatement() {
    this.next();
    this.parenthesized();
    this.statement();
  }

  withStatement() {
    this.whileStatement();
  }

  doStatement() {
    this.next();
    this.statement();
    this.expect('while');
    this.parenthesized();
    if (this.eat(';')) this.safe = this.prevEnd;
  }

  returnStatement() {
    this.next();
    if (!this.is(';') && !this.terminated()) this.expression();
    this.semicolon();
  }

  throwStatement() {
    this.returnStatement();
  }

  breakStatement() {
    this.next();
    if (this.at('name') && !this.tok.nl) this.next();
    this.semicolon();
  }

  continueStatement() {
    this.breakStatement();
  }

  debuggerStatement() {
    this.next();
    this.semicolon();
  }

  tryStatement() {
    this.next();
    this.block();
    if (this.eat('catch')) {
      if (this.eat('(')) {
        this.binding();
        this.annotationIfAny();
        this.expect(')');
      }
      this.block();
    }
    if (this.eat('finally')) this.block();
  }

  switchStatement() {
    this.next();
    this.parenthesized();
    this.expect('{');
    while (!this.is('}')) {
      if (this.eat('case')) {
        this.expression();
        this.expect(':');
        this.safe = this.prevEnd;
      } else if (this.eat('default')) {
        this.expect(':');
        this.safe = this.prevEnd;
      } else if (this.at('eof')) this.fail();
      else this.statement();
    }
    this.next();
    this.safe = this.prevEnd;
  }

  variables(noIn = false) {
    this.eat('await');
    this.next();
    do {
      this.binding();
      if (this.is('!')) this.blankToken();
      this.annotationIfAny();
      if (this.eat('=')) this.assignment(noIn);
    } while (this.eat(','));
  }

  binding() {
    if (this.is('[')) this.arrayPattern();
    else if (this.is('{')) this.objectPattern();
    else this.name();
  }

  arrayPattern() {
    this.next();
    while (!this.is(']')) {
      if (!this.is(',')) {
        this.eat('...');
        this.binding();
        if (this.eat('=')) this.assignment();
      }
      if (!this.is(']')) this.expect(',');
    }
    this.next();
  }

  objectPattern() {
    this.next();
    while (!this.is('}')) {
      if (this.eat('...')) this.binding();
      else {
        this.propertyName();
        if (this.eat(':')) this.binding();
        if (this.eat('=')) this.assignment();
      }
      if (!this.is('}')) this.expect(',');
    }
    this.next();
  }

  annotationIfAny() {
    if (!this.is(':')) return;
    const start = this.tok.start;
    this.next();
    this.type();
    this.blank(start);
  }

  returnTypeIfAny() {
    if (!this.is(':')) return false;
    const start = this.tok.start;
    this.next();
    this.returnType();
    this.blank(start);
    return true;
  }

  returnType() {
    const after = this.peek();
    if (this.is('asserts') && after.type === 'name' && !after.nl) {
      this.next();
      this.next();
      if (this.eat('is')) this.type();
    } else if (this.at('name') && this.is('is', after) && !after.nl) {
      this.next();
      this.next();
      this.type();
    } else this.type();
  }

  typeParametersIfAny() {
    if (!this.is('<')) return;
    const start = this.tok.start;
    this.typeParameters();
    this.blank(start);
  }

  typeParameters() {
    this.expect('<');
    while (!this.is('>')) {
      while (['const', 'in', 'out'].includes(this.tok.value) && this.peek().type === 'name')
        this.next();
      this.name();
      if (this.eat('extends')) this.type();
      if (this.eat('=')) this.type();
      if (!this.eat(',')) break;
    }
    this.expect('>');
  }

  functionDeclaration(start, clean, ambient = false) {
    this.eat('async');
    this.expect('function');
    this.eat('*');
    if (this.at('name')) this.next();
    this.signature();
    if (!ambient && this.is('{')) {
      this.functionBody();
      return;
    }
    this.semicolon();
    if (!ambient) this.blankWhole(start, clean);
  }

  signature(constructor = false) {
    this.typeParametersIfAny();
    this.parameters(constructor);
    return this.returnTypeIfAny();
  }

  parameters(constructor = false) {
    this.expect('(');
    while (!this.is(')')) {
      if (!this.parameter(constructor) && !this.is(')')) this.expect(',');
    }
    this.closing = this.tok.start;
    this.next();
  }

  parameter(constructor) {
    const start = this.tok.start;
    if (this.is('@')) this.unsupported('A decorator');
    const after = this.peek();
    const modified = after.type === 'name' || this.is('{', after) || this.is('[', after);
    if (tsModifiers.has(this.tok.value) && this.at('name') && modified && !after.nl) {
      if (constructor) this.unsupported('A TypeScript parameter property');
      this.fail('expected a parameter');
    }
    if (this.is('this') && [':', ',', ')'].includes(after.value) && after.type === 'punct') {
      this.next();
      this.annotationIfAny();
      this.eat(',');
      this.blank(start);
      return true;
    }
    this.eat('...');
    this.binding();
    if (this.is('?')) this.blankToken();
    this.annotationIfAny();
    if (this.eat('=')) this.assignment();
    return false;
  }

  classDefinition() {
    this.expect('class');
    if (this.at('name') && !this.is('extends') && !this.is('implements')) this.next();
    this.typeParametersIfAny();
    if (this.eat('extends')) {
      this.primary();
      this.postfix();
      const start = this.tok.start;
      if (this.is('<')) {
        this.typeArguments();
        this.blank(start);
      }
    }
    if (this.is('implements')) {
      const start = this.tok.start;
      this.next();
      this.typeList();
      this.blank(start);
    }
    this.expect('{');
    this.safe = this.prevEnd;
    while (!this.is('}')) {
      if (this.at('eof')) this.fail();
      this.member();
    }
    this.next();
  }

  typeList() {
    do this.type();
    while (this.eat(','));
  }

  canFollowModifier(token) {
    if (token.nl) return false;
    if (['name', 'string', 'number'].includes(token.type)) return true;
    return token.type === 'punct' && ['[', '{', '*'].includes(token.value);
  }

  modifiers() {
    const found = new Set();
    while (memberModifiers.has(this.tok.value) && this.at('name')) {
      const after = this.peek();
      if (!this.canFollowModifier(after) || (this.is('static') && this.is('{', after))) break;
      found.add(this.tok.value);
      if (tsModifiers.has(this.tok.value) || this.is('abstract')) this.blankToken();
      else this.next();
    }
    return found;
  }

  member() {
    const start = this.tok.start;
    const clean = this.clean();
    if (this.is(';')) return this.semicolon();
    if (this.is('@')) this.unsupported('A decorator');
    const found = this.modifiers();
    if (this.is('static') && this.is('{', this.peek())) {
      this.next();
      return this.block();
    }
    if (this.is('[') && this.isIndexSignature()) {
      this.indexSignature();
      return this.blankWhole(start, clean);
    }
    const hazard = this.is('[') || this.is('*');
    if (this.blanks.at(-1)?.[0] === start && hazard && !clean) this.marks.push([start, ';']);
    const bodyless = this.memberBody(found);
    if (bodyless || found.has('declare') || found.has('abstract')) this.blankWhole(start, clean);
  }

  isIndexSignature() {
    const name = this.peek();
    return name.type === 'name' && this.is(':', this.peek(2));
  }

  indexSignature() {
    this.next();
    this.next();
    this.annotationIfAny();
    this.expect(']');
    this.annotationIfAny();
    this.semicolon();
  }

  accessorKind() {
    const after = this.peek();
    const word = this.tok.value;
    if (!['get', 'set', 'async'].includes(word) || !this.at('name')) return;
    if (this.canFollowModifier(after)) this.next();
  }

  memberBody(found) {
    this.accessorKind();
    this.eat('*');
    const constructor = this.is('constructor');
    this.propertyName();
    if (this.is('?') || this.is('!')) this.blankToken();
    if (this.is('(') || this.is('<')) {
      this.signature(constructor);
      if (this.is('{')) {
        this.functionBody();
        this.safe = this.prevEnd;
        return false;
      }
      this.semicolon();
      return true;
    }
    this.annotationIfAny();
    if (this.eat('=')) this.assignment();
    this.semicolon();
    return false;
  }

  propertyName() {
    if (this.eat('[')) {
      this.assignment();
      this.expect(']');
    } else if (['name', 'string', 'number'].includes(this.tok.type)) this.next();
    else this.fail('expected a property name');
  }

  importDeclaration(start, clean) {
    this.next();
    if (this.at('string')) {
      this.next();
      this.attributes();
      this.semicolon();
      return;
    }
    const after = this.peek();
    const typeOnly =
      this.is('type') &&
      ((after.type === 'name' && !this.is('from', after)) ||
        this.is('{', after) ||
        this.is('*', after));
    if (typeOnly) this.next();
    this.importClause();
    this.semicolon();
    if (typeOnly) this.blankWhole(start, clean);
  }

  importClause() {
    if (this.at('name')) {
      this.next();
      if (this.is('=')) this.unsupported('A TypeScript import equals declaration');
      if (!this.eat(',')) return this.from();
    }
    if (this.eat('*')) {
      this.expect('as');
      this.name();
    } else this.specifiers();
    this.from();
  }

  from() {
    this.expect('from');
    if (!this.at('string')) this.fail('expected a module specifier');
    this.next();
    this.attributes();
  }

  attributes() {
    if ((this.is('with') || this.is('assert')) && !this.tok.nl) {
      this.next();
      this.objectLiteral();
    }
  }

  isTypeSpecifier() {
    if (!this.is('type')) return false;
    const after = this.peek();
    if (this.is('as', after)) {
      const third = this.peek(2);
      return this.is(',', third) || this.is('}', third) || this.is('as', third);
    }
    return after.type === 'name' || after.type === 'string';
  }

  specifiers() {
    this.expect('{');
    while (!this.is('}')) {
      const start = this.tok.start;
      const typeOnly = this.isTypeSpecifier();
      if (typeOnly) this.next();
      this.nameOrString();
      if (this.eat('as')) this.nameOrString();
      if (!this.is('}')) this.expect(',');
      if (typeOnly) this.blank(start);
    }
    this.next();
  }

  exportDeclaration(start, clean) {
    this.next();
    const after = this.peek();
    if (this.is('type') && (this.is('{', after) || this.is('*', after))) {
      this.next();
      this.exportClause();
      this.blankWhole(start, clean);
    } else if (this.is('=')) this.unsupported('A TypeScript export assignment');
    else if (this.is('import')) this.unsupported('A TypeScript import equals declaration');
    else if (this.is('as') && this.is('namespace', after)) {
      this.next();
      this.next();
      this.name();
      this.semicolon();
      this.blankWhole(start, clean);
    } else if (this.is('default')) this.exportDefault(start, clean);
    else if (this.is('{') || this.is('*')) this.exportClause();
    else if (this.declaration(start, clean)) this.safe = this.prevEnd;
    else if (this.typeStatement(start, clean)) return;
    else if (this.isVariable()) {
      this.variables();
      this.semicolon();
    } else this.fail();
  }

  exportClause() {
    if (this.eat('*')) {
      if (this.eat('as')) this.nameOrString();
      this.from();
    } else {
      this.specifiers();
      if (this.is('from')) this.from();
    }
    this.semicolon();
  }

  exportDefault(start, clean) {
    this.next();
    if (this.is('interface')) {
      this.interfaceDeclaration();
      this.blankWhole(start, clean);
    } else if (this.declaration(start, clean)) this.safe = this.prevEnd;
    else {
      this.assignment();
      this.semicolon();
    }
  }

  expression(noIn = false) {
    do this.assignment(noIn);
    while (this.eat(','));
  }

  assignment(noIn = false, consequent = false) {
    if (this.arrowFunction(noIn, consequent)) return;
    if (this.is('yield')) return this.yieldExpression(noIn);
    this.conditional(noIn);
    if (assignments.has(this.tok.value) && this.at('punct')) {
      this.next();
      this.assignment(noIn);
    } else if (this.is('>')) {
      this.compound();
      this.assignment(noIn);
    }
  }

  compound() {
    let count = 0;
    while (this.is('>') && (count === 0 || this.tok.start === this.prevEnd)) {
      this.next();
      count++;
    }
    if (!this.is('=') || this.tok.start !== this.prevEnd) return 'binary';
    this.next();
    return count > 1 ? 'assign' : 'binary';
  }

  yieldExpression(noIn) {
    this.next();
    const { type, value, nl, start } = this.tok;
    const closing = (type === 'template' || type === 'head') && this.source[start] === '}';
    if (nl || type === 'eof' || closing || (endsYield.has(value) && type === 'punct')) return;
    this.eat('*');
    this.assignment(noIn);
  }

  mayStartArrow() {
    if (this.is('(') || this.is('<')) return true;
    if (!this.at('name')) return false;
    const after = this.peek();
    if (this.is('=>', after) && !after.nl) return true;
    if (!this.is('async') || after.nl) return false;
    if (this.is('(', after) || this.is('<', after)) return true;
    return after.type === 'name' && this.is('=>', this.peek(2));
  }

  arrowFunction(noIn, consequent) {
    const key = `${this.tok.start}:${noIn}:${consequent}`;
    if (this.failedArrows.has(key) || !this.mayStartArrow()) return false;
    const angle = this.is('<');
    const parsed = this.attempt(() => {
      if (this.is('async') && !this.is('=>', this.peek())) this.next();
      let typed = false;
      if (this.at('name')) this.next();
      else typed = this.signature();
      if (!this.is('=>')) this.fail('expected "=>"');
      if (this.tok.nl) this.fail('expected "=>" on the same line');
      if (typed) this.moveParenthesis();
      this.next();
      if (this.is('{')) this.functionBody();
      else this.assignment(noIn);
      if (consequent && typed && !this.is(':')) this.fail('expected ":"');
    });
    if (!parsed) this.failedArrows.add(key);
    if (!parsed && angle) this.unsupported('The angle-bracket type assertion <T>x');
    return parsed;
  }

  moveParenthesis() {
    if (!lineBreak.test(this.source.slice(this.closing, this.prevEnd))) return;
    this.blank(this.closing, this.closing + 1);
    this.marks.push([this.prevEnd - 1, ')']);
  }

  conditional(noIn) {
    this.binaryExpression(noIn);
    if (!this.eat('?')) return;
    this.assignment(false, true);
    this.expect(':');
    this.assignment(noIn);
  }

  isBinary() {
    const { type, value } = this.tok;
    if (type === 'punct') return binary.has(value) || value === '>';
    return type === 'name' && ['instanceof', 'in', 'as', 'satisfies'].includes(value);
  }

  binaryExpression(noIn) {
    this.unary();
    for (;;) {
      const { value, type, nl } = this.tok;
      if ((value === 'as' || value === 'satisfies') && type === 'name' && !nl) {
        const start = this.tok.start;
        this.next();
        if (!this.eat('const')) this.type();
        this.blank(start);
      } else if (value === '>' && type === 'punct') {
        const state = this.save();
        if (this.compound() === 'assign') return this.restore(state);
        this.unary();
      } else if (
        (binary.has(value) && type === 'punct') ||
        this.is('instanceof') ||
        (!noIn && this.is('in'))
      ) {
        this.next();
        this.unary();
      } else return;
    }
  }

  unary() {
    const { value, type } = this.tok;
    const prefix = prefixes.has(value) && (type === 'punct' || type === 'name');
    if (prefix && (type === 'punct' || this.startsExpression(this.peek()))) {
      this.next();
      this.unary();
      return;
    }
    this.primary();
    this.postfix();
    if ((this.is('++') || this.is('--')) && !this.tok.nl) this.next();
  }

  startsExpression(token) {
    if (token.type === 'eof') return false;
    if (token.type === 'template' || token.type === 'head') return this.source[token.start] === '`';
    if (token.type !== 'punct')
      return !['in', 'of', 'instanceof', 'as', 'satisfies'].includes(token.value);
    return ['(', '[', '{', '!', '~', '+', '-', '++', '--', '/', '/=', '<', '...'].includes(
      token.value
    );
  }

  primary() {
    const { type, value } = this.tok;
    if (type === 'name') this.namedPrimary(value);
    else if (type === 'number' || type === 'string') this.next();
    else if (type === 'template' || type === 'head') this.template();
    else if (value === '(') this.parenthesized();
    else if (value === '[') this.arrayLiteral();
    else if (value === '{') this.objectLiteral();
    else if (value === '/' || value === '/=') {
      this.tok = this.lexer.regex(this.tok.start, this.tok.nl);
      this.next();
    } else if (value === '@') this.unsupported('A decorator');
    else this.fail();
  }

  namedPrimary(value) {
    const after = this.peek();
    if (value === 'function' || (value === 'async' && this.is('function', after) && !after.nl)) {
      this.eat('async');
      this.next();
      this.eat('*');
      if (this.at('name')) this.next();
      this.signature();
      this.functionBody();
    } else if (value === 'class') this.classDefinition();
    else if (value === 'new') this.newExpression();
    else if (value === 'import') {
      this.next();
      if (this.eat('.')) this.name();
      else if (!this.is('(')) this.fail();
    } else this.next();
  }

  newExpression() {
    this.next();
    if (this.eat('.')) return this.name();
    this.primary();
    this.postfix(true);
    if (this.is('(')) this.args();
  }

  template() {
    while (this.at('head')) {
      this.next();
      this.expression();
      if (!this.at('head') && !this.at('template')) this.fail('expected "}"');
    }
    this.next();
  }

  args() {
    this.expect('(');
    while (!this.is(')')) {
      this.eat('...');
      this.assignment();
      if (!this.is(')')) this.expect(',');
    }
    this.next();
  }

  arrayLiteral() {
    this.next();
    while (!this.is(']')) {
      if (!this.is(',')) {
        this.eat('...');
        this.assignment();
      }
      if (!this.is(']')) this.expect(',');
    }
    this.next();
  }

  objectLiteral() {
    this.expect('{');
    while (!this.is('}')) {
      if (this.eat('...')) this.assignment();
      else this.property();
      if (!this.is('}')) this.expect(',');
    }
    this.next();
  }

  property() {
    this.accessorKind();
    this.eat('*');
    this.propertyName();
    if (this.is('(') || this.is('<')) {
      this.signature();
      this.functionBody();
    } else if (this.eat(':') || this.eat('=')) this.assignment();
  }

  postfix(noCall = false) {
    for (;;) {
      if (this.is('.') || this.is('?.')) {
        const optional = this.is('?.');
        this.next();
        if (!optional || !['(', '[', '<'].includes(this.tok.value) || !this.at('punct'))
          this.name();
      } else if (this.is('[')) {
        this.next();
        this.expression();
        this.expect(']');
      } else if (this.is('(') && !noCall) this.args();
      else if ((this.at('template') || this.at('head')) && this.source[this.tok.start] === '`')
        this.template();
      else if (this.is('!') && !this.tok.nl) this.blankToken();
      else if (!this.is('<') || !this.typeArgumentsInExpression(noCall)) return;
    }
  }

  typeArgumentsInExpression(noCall) {
    const start = this.tok.start;
    const parsed = this.attempt(() => {
      this.typeArguments();
      const joined = this.tok.start === this.prevEnd && /^[>=]/.test(this.tok.value);
      if (joined || (!noCall && !this.canFollowTypeArguments())) this.fail();
    });
    if (parsed) this.blank(start);
    return parsed;
  }

  canFollowTypeArguments() {
    const { type, value, nl, start } = this.tok;
    if (value === '(' && type === 'punct') return true;
    if (type === 'template' || type === 'head') return this.source[start] === '`';
    if (type === 'punct' && ['<', '>', '+', '-'].includes(value)) return false;
    return nl || this.isBinary() || !this.startsExpression(this.tok);
  }

  typeArguments() {
    this.expect('<');
    do this.type();
    while (this.eat(','));
    this.expect('>');
  }

  type(noConditional = false) {
    if (this.is('<')) {
      this.typeParameters();
      return this.functionType();
    }
    if (this.is('new') || (this.is('abstract') && this.is('new', this.peek()))) {
      this.eat('abstract');
      this.next();
      this.typeParametersIfAny();
      return this.functionType();
    }
    if (this.is('(') && this.startsFunctionType()) return this.functionType();
    this.unionType(noConditional);
    if (!noConditional && this.is('extends') && !this.tok.nl) {
      this.next();
      this.type(true);
      this.expect('?');
      this.type();
      this.expect(':');
      this.type();
    }
  }

  startsFunctionType() {
    const state = this.save();
    try {
      this.next();
      if (this.is(')') || this.is('...')) return true;
      if (this.is('{') || this.is('[')) this.balanced();
      else this.name();
      if ([':', ',', '?', '='].includes(this.tok.value) && this.at('punct')) return true;
      return this.eat(')') && this.is('=>');
    } catch {
      return false;
    } finally {
      this.restore(state);
    }
  }

  functionType() {
    this.balanced();
    this.expect('=>');
    this.returnType();
  }

  unionType(noConditional) {
    if (this.is('|') || this.is('&')) this.next();
    this.typeOperator(noConditional);
    while (this.is('|') || this.is('&')) {
      this.next();
      this.typeOperator(noConditional);
    }
  }

  typeOperator(noConditional) {
    const after = this.peek();
    if (['keyof', 'unique', 'readonly'].includes(this.tok.value) && this.startsType(after)) {
      this.next();
      this.typeOperator(noConditional);
    } else if (this.is('infer') && after.type === 'name') {
      this.next();
      this.next();
      if (this.is('extends')) this.inferConstraint(noConditional);
    } else this.postfixType();
  }

  startsType(token) {
    if (token.type === 'name') return !this.is('extends', token) && !this.is('is', token);
    if (token.type !== 'punct') return token.type !== 'eof';
    return ['(', '[', '{', '<', '-'].includes(token.value);
  }

  inferConstraint(noConditional) {
    const state = this.save();
    this.next();
    this.type(true);
    if (!noConditional && this.is('?')) this.restore(state);
  }

  postfixType() {
    this.primaryType();
    while (this.is('[') && !this.tok.nl) {
      this.next();
      if (!this.is(']')) this.type();
      this.expect(']');
    }
  }

  primaryType() {
    const { type, value } = this.tok;
    if (type === 'punct' && value === '(') {
      this.next();
      this.type();
      this.expect(')');
    } else if (type === 'punct' && (value === '{' || value === '[')) this.balanced();
    else if (type === 'string' || type === 'number' || type === 'template') this.next();
    else if (type === 'head') this.templateType();
    else if (type === 'punct' && value === '-') {
      this.next();
      if (!this.at('number')) this.fail('expected a number');
      this.next();
    } else if (this.is('typeof')) {
      this.next();
      if (this.is('import')) this.importType();
      else this.entity();
    } else if (this.is('import')) this.importType();
    else if (type === 'name') this.entity();
    else this.fail('expected a type');
  }

  templateType() {
    while (this.at('head')) {
      this.next();
      this.type();
      if (!this.at('head') && !this.at('template')) this.fail('expected "}"');
    }
    this.next();
  }

  importType() {
    this.next();
    this.balanced();
    while (this.eat('.')) this.name();
    if (this.is('<')) this.typeArguments();
  }

  entity() {
    this.name();
    while (this.eat('.')) this.name();
    if (this.is('<') && !this.tok.nl) this.typeArguments();
  }

  balanced() {
    if (!this.at('punct') || !['(', '[', '{'].includes(this.tok.value))
      this.fail('expected a bracket');
    let depth = 0;
    do {
      if (this.at('eof')) this.fail();
      if (this.at('punct') && ['(', '[', '{'].includes(this.tok.value)) depth++;
      else if (this.at('punct') && [')', ']', '}'].includes(this.tok.value)) depth--;
      this.next();
    } while (depth > 0);
  }
}

function position(source, at) {
  const before = source.slice(0, at).split(/\r\n|[\n\r\u2028\u2029]/);
  return [before.length, before.at(-1).length + 1];
}

export function strip(source, file = 'input.ts') {
  const stripper = new Stripper(source);
  try {
    return stripper.program();
  } catch (thrown) {
    if (!(thrown instanceof Fail) && !(thrown instanceof Unsupported)) throw thrown;
    const error =
      thrown instanceof Fail && stripper.furthest?.cause > thrown.cause
        ? stripper.furthest
        : thrown;
    const [line, column] = position(source, error.cause);
    const message =
      error instanceof Fail ? `cannot strip TypeScript: ${error.message}` : error.message;
    throw new TypeScriptError(message, file, line, column);
  }
}
