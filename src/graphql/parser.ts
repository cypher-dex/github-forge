// A GraphQL document parser for executable documents: operations, variables, fields, aliases, arguments,
// directives, inline fragments and named fragments.

export type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum'; value: string | number | boolean | null }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

export interface Directive {
  name: string;
  args: Map<string, Value>;
}

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  directives: Directive[];
  selections: Selection[] | null;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: Directive[];
  selections: Selection[];
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
  directives: Directive[];
}

export type Selection = FieldNode | InlineFragmentNode | SpreadNode;

export interface VariableDefinition {
  name: string;
  type: string;
  defaultValue: Value | null;
}

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDefinition[];
  selections: Selection[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

export class GraphQLSyntaxError extends Error {}

type Token = { kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof'; text: string };

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      at += 1;
    } else if (ch === '#') {
      while (at < source.length && source[at] !== '\n' && source[at] !== '\r') at += 1;
    } else if (ch === '.' && source.startsWith('...', at)) {
      tokens.push({ kind: 'punct', text: '...' });
      at += 3;
    } else if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', text: ch });
      at += 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const start = at;
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at]!)) at += 1;
      tokens.push({ kind: 'name', text: source.slice(start, at) });
    } else if (/[-0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(at));
      if (match === null) throw new GraphQLSyntaxError(`Syntax Error: Invalid number at ${at}`);
      tokens.push({ kind: match[1] !== undefined || match[2] !== undefined ? 'float' : 'int', text: match[0] });
      at += match[0].length;
    } else if (source.startsWith('"""', at)) {
      const end = source.indexOf('"""', at + 3);
      if (end < 0) throw new GraphQLSyntaxError('Syntax Error: Unterminated block string');
      tokens.push({ kind: 'string', text: blockString(source.slice(at + 3, end).replace(/\\"""/g, '"""')) });
      at = end + 3;
    } else if (ch === '"') {
      let text = '';
      at += 1;
      for (;;) {
        if (at >= source.length || source[at] === '\n') throw new GraphQLSyntaxError('Syntax Error: Unterminated string');
        const c = source[at]!;
        if (c === '"') {
          at += 1;
          break;
        }
        if (c === '\\') {
          const next = source[at + 1];
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (next === 'u') {
            text += String.fromCharCode(parseInt(source.slice(at + 2, at + 6), 16));
            at += 6;
          } else if (next !== undefined && escapes[next] !== undefined) {
            text += escapes[next];
            at += 2;
          } else {
            throw new GraphQLSyntaxError('Syntax Error: Invalid escape');
          }
          continue;
        }
        text += c;
        at += 1;
      }
      tokens.push({ kind: 'string', text });
    } else {
      throw new GraphQLSyntaxError(`Syntax Error: Unexpected character "${ch}"`);
    }
  }
  tokens.push({ kind: 'eof', text: '' });
  return tokens;
}

/** Block strings drop their common indentation and blank first/last lines. */
function blockString(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let indent = Number.POSITIVE_INFINITY;
  for (const line of lines.slice(1)) {
    const lead = line.length - line.trimStart().length;
    if (lead < line.length) indent = Math.min(indent, lead);
  }
  const out = lines.map((line, index) => (index === 0 || indent === Number.POSITIVE_INFINITY ? line : line.slice(indent)));
  while (out.length > 0 && out[0]!.trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out.join('\n');
}

class Parser {
  private readonly tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private next(): Token {
    const token = this.tokens[this.at]!;
    if (token.kind !== 'eof') this.at += 1;
    return token;
  }

  private is(text: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.text === text;
  }

  private expect(text: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.text !== text) {
      throw new GraphQLSyntaxError(`Syntax Error: Expected "${text}", found ${token.kind === 'eof' ? '<EOF>' : `"${token.text}"`}`);
    }
  }

  private name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`Syntax Error: Expected Name, found ${token.kind === 'eof' ? '<EOF>' : `"${token.text}"`}`);
    return token.text;
  }

  document(): DocumentNode {
    const document: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      if (this.is('{')) {
        document.operations.push({ operation: 'query', name: null, variables: [], selections: this.selectionSet() });
        continue;
      }
      const keyword = this.name();
      if (keyword === 'fragment') {
        const name = this.name();
        if (this.name() !== 'on') throw new GraphQLSyntaxError('Syntax Error: Expected "on"');
        const typeCondition = this.name();
        this.directives();
        document.fragments.set(name, { name, typeCondition, selections: this.selectionSet() });
      } else if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        const name = this.peek().kind === 'name' ? this.name() : null;
        const variables = this.is('(') ? this.variableDefinitions() : [];
        this.directives();
        document.operations.push({ operation: keyword, name, variables, selections: this.selectionSet() });
      } else {
        throw new GraphQLSyntaxError(`Syntax Error: Unexpected Name "${keyword}"`);
      }
    }
    return document;
  }

  private variableDefinitions(): VariableDefinition[] {
    const out: VariableDefinition[] = [];
    this.expect('(');
    while (!this.is(')')) {
      this.expect('$');
      const name = this.name();
      this.expect(':');
      const type = this.typeRef();
      let defaultValue: Value | null = null;
      if (this.is('=')) {
        this.next();
        defaultValue = this.value(true);
      }
      this.directives();
      out.push({ name, type, defaultValue });
    }
    this.expect(')');
    return out;
  }

  private typeRef(): string {
    let type: string;
    if (this.is('[')) {
      this.next();
      type = `[${this.typeRef()}]`;
      this.expect(']');
    } else {
      type = this.name();
    }
    if (this.is('!')) {
      this.next();
      type += '!';
    }
    return type;
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Syntax Error: Expected Name, found <EOF>');
      out.push(this.selection());
    }
    this.expect('}');
    if (out.length === 0) throw new GraphQLSyntaxError('Syntax Error: Expected Name, found "}"');
    return out;
  }

  private selection(): Selection {
    if (this.is('...')) {
      this.next();
      if (this.peek().kind === 'name' && this.peek().text !== 'on') {
        const name = this.name();
        return { kind: 'spread', name, directives: this.directives() };
      }
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().text === 'on') {
        this.next();
        typeCondition = this.name();
      }
      const directives = this.directives();
      return { kind: 'inline', typeCondition, directives, selections: this.selectionSet() };
    }
    let name = this.name();
    let alias: string | null = null;
    if (this.is(':')) {
      this.next();
      alias = name;
      name = this.name();
    }
    const args = this.is('(') ? this.arguments(false) : new Map<string, Value>();
    const directives = this.directives();
    const selections = this.is('{') ? this.selectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selections };
  }

  private arguments(isConst: boolean): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expect('(');
    while (!this.is(')')) {
      const name = this.name();
      this.expect(':');
      args.set(name, this.value(isConst));
    }
    this.expect(')');
    return args;
  }

  private directives(): Directive[] {
    const out: Directive[] = [];
    while (this.is('@')) {
      this.next();
      const name = this.name();
      out.push({ name, args: this.is('(') ? this.arguments(false) : new Map() });
    }
    return out;
  }

  private value(isConst: boolean): Value {
    const token = this.peek();
    if (token.kind === 'punct') {
      if (token.text === '$' && !isConst) {
        this.next();
        return { kind: 'variable', name: this.name() };
      }
      if (token.text === '[') {
        this.next();
        const items: Value[] = [];
        while (!this.is(']')) items.push(this.value(isConst));
        this.next();
        return { kind: 'list', items };
      }
      if (token.text === '{') {
        this.next();
        const fields: Array<[string, Value]> = [];
        while (!this.is('}')) {
          const name = this.name();
          this.expect(':');
          fields.push([name, this.value(isConst)]);
        }
        this.next();
        return { kind: 'object', fields };
      }
      throw new GraphQLSyntaxError(`Syntax Error: Unexpected "${token.text}"`);
    }
    this.next();
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.text, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.text) };
    if (token.kind === 'string') return { kind: 'string', value: token.text };
    if (token.kind === 'name') {
      if (token.text === 'true' || token.text === 'false') return { kind: 'boolean', value: token.text === 'true' };
      if (token.text === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.text };
    }
    throw new GraphQLSyntaxError('Syntax Error: Unexpected <EOF>');
  }
}

export function parseDocument(source: string): DocumentNode {
  return new Parser(source).document();
}
