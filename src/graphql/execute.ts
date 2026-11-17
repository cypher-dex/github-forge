// A small GraphQL executor: static validation of field names, variable coercion, resolver dispatch,
// abstract types by __typename, and the introspection types built from the same schema table.

import { GraphQLSyntaxError, parseDocument } from './parser.ts';
import type { DocumentNode, FieldNode, Selection, Value } from './parser.ts';

export type Args = Record<string, unknown>;

/**
 * A field resolver. The parent is `never` so each type's resolvers can name their own parent shape; the
 * executor calls them through `invoke`, the one place that erases it.
 */
export type Resolver<C> = (parent: never, args: Args, ctx: C) => unknown;

function invoke<C>(resolver: Resolver<C>, parent: unknown, args: Args, ctx: C): unknown {
  // The schema pairs each resolver with the parent values its type produces, so the erased call is sound.
  const call = resolver as unknown as (parent: unknown, args: Args, ctx: C) => unknown;
  return call(parent, args, ctx);
}

export interface FieldDef<C> {
  type: string;
  args?: Record<string, string>;
  description?: string;
  resolve?: Resolver<C>;
}

export interface TypeDef<C> {
  kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  description?: string;
  fields?: Record<string, FieldDef<C>>;
  interfaces?: string[];
  possibleTypes?: string[];
  values?: string[];
  inputFields?: Record<string, string>;
}

export type Schema<C> = Record<string, TypeDef<C>>;

export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
  type?: string;
}

export interface ExecutionResult {
  data?: Record<string, unknown> | null;
  errors?: GraphQLError[];
}

/** An error a resolver throws to report a GraphQL-level failure (the field becomes null). */
export class FieldError extends Error {
  type: string;

  constructor(message: string, type = 'UNPROCESSABLE') {
    super(message);
    this.type = type;
  }
}

function named(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

// ---------------------------------------------------------------- introspection

const SCALARS = ['String', 'Int', 'Float', 'Boolean', 'ID'];

/** The introspection types, merged into every schema this module executes. */
function introspectionTypes<C>(): Schema<C> {
  const typeRef = (schema: Schema<C>, type: string): Record<string, unknown> => {
    if (type.endsWith('!')) return { __typename: '__Type', kind: 'NON_NULL', name: null, ofType: typeRef(schema, type.slice(0, -1)) };
    if (type.startsWith('[')) return { __typename: '__Type', kind: 'LIST', name: null, ofType: typeRef(schema, type.slice(1, -1)) };
    return namedType(schema, type);
  };
  const inputValue = (schema: Schema<C>, name: string, type: string): Record<string, unknown> => ({
    __typename: '__InputValue', name, description: null, type: typeRef(schema, type), defaultValue: null, isDeprecated: false, deprecationReason: null,
  });
  const built = new WeakMap<Schema<C>, Map<string, Record<string, unknown>>>();
  /** One __Type per named type, cached before its fields are filled so cyclic references resolve. */
  const namedType = (schema: Schema<C>, name: string): Record<string, unknown> => {
    let cache = built.get(schema);
    if (cache === undefined) {
      cache = new Map();
      built.set(schema, cache);
    }
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const def = schema[name];
    const kind = def?.kind ?? 'SCALAR';
    const type: Record<string, unknown> = { __typename: '__Type', kind, name, description: def?.description ?? null, specifiedByURL: null, ofType: null };
    cache.set(name, type);
    type.fields = def?.fields === undefined || (kind !== 'OBJECT' && kind !== 'INTERFACE')
      ? null
      : Object.entries(def.fields).filter(([field]) => !field.startsWith('__')).map(([field, spec]) => ({
        __typename: '__Field',
        name: field,
        description: spec.description ?? null,
        args: Object.entries(spec.args ?? {}).map(([arg, argType]) => inputValue(schema, arg, argType)),
        type: typeRef(schema, spec.type),
        isDeprecated: false,
        deprecationReason: null,
      }));
    type.interfaces = kind === 'OBJECT' ? (def?.interfaces ?? []).map((iface) => namedType(schema, iface)) : null;
    type.possibleTypes = kind === 'INTERFACE' || kind === 'UNION' ? (def?.possibleTypes ?? []).map((possible) => namedType(schema, possible)) : null;
    type.enumValues = kind === 'ENUM' ? (def?.values ?? []).map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null })) : null;
    type.inputFields = kind === 'INPUT_OBJECT' ? Object.entries(def?.inputFields ?? {}).map(([field, fieldType]) => inputValue(schema, field, fieldType)) : null;
    return type;
  };
  return {
    __Schema: {
      kind: 'OBJECT',
      fields: {
        description: { type: 'String' },
        types: { type: '[__Type!]!' },
        queryType: { type: '__Type!' },
        mutationType: { type: '__Type' },
        subscriptionType: { type: '__Type' },
        directives: { type: '[__Directive!]!' },
      },
    },
    __Type: {
      kind: 'OBJECT',
      fields: {
        kind: { type: '__TypeKind!' },
        name: { type: 'String' },
        description: { type: 'String' },
        specifiedByURL: { type: 'String' },
        fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' } },
        interfaces: { type: '[__Type!]' },
        possibleTypes: { type: '[__Type!]' },
        enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' } },
        inputFields: { type: '[__InputValue!]', args: { includeDeprecated: 'Boolean' } },
        ofType: { type: '__Type' },
        isOneOf: { type: 'Boolean', resolve: () => false },
      },
    },
    __Field: {
      kind: 'OBJECT',
      fields: {
        name: { type: 'String!' },
        description: { type: 'String' },
        args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' } },
        type: { type: '__Type!' },
        isDeprecated: { type: 'Boolean!' },
        deprecationReason: { type: 'String' },
      },
    },
    __InputValue: {
      kind: 'OBJECT',
      fields: {
        name: { type: 'String!' },
        description: { type: 'String' },
        type: { type: '__Type!' },
        defaultValue: { type: 'String' },
        isDeprecated: { type: 'Boolean!' },
        deprecationReason: { type: 'String' },
      },
    },
    __EnumValue: {
      kind: 'OBJECT',
      fields: {
        name: { type: 'String!' },
        description: { type: 'String' },
        isDeprecated: { type: 'Boolean!' },
        deprecationReason: { type: 'String' },
      },
    },
    __Directive: {
      kind: 'OBJECT',
      fields: {
        name: { type: 'String!' },
        description: { type: 'String' },
        locations: { type: '[String!]!' },
        args: { type: '[__InputValue!]!' },
        isRepeatable: { type: 'Boolean!' },
      },
    },
    __TypeKind: { kind: 'ENUM', values: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
    __introspect: {
      kind: 'SCALAR',
      fields: {
        type: {
          type: '__Type',
          resolve: (schema: Schema<C>, args: Args) => {
            const name = typeof args.name === 'string' ? args.name : '';
            return schema[name] !== undefined || SCALARS.includes(name) ? namedType(schema, name) : null;
          },
        },
        schema: {
          type: '__Schema!',
          resolve: (schema: Schema<C>) => ({
            __typename: '__Schema',
            description: null,
            types: [...SCALARS, ...Object.keys(schema).filter((name) => name !== '__introspect')].map((name) => namedType(schema, name)),
            queryType: namedType(schema, 'Query'),
            mutationType: schema.Mutation === undefined ? null : namedType(schema, 'Mutation'),
            subscriptionType: null,
            directives: [
              { __typename: '__Directive', name: 'include', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [inputValue(schema, 'if', 'Boolean!')], isRepeatable: false },
              { __typename: '__Directive', name: 'skip', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [inputValue(schema, 'if', 'Boolean!')], isRepeatable: false },
            ],
          }),
        },
      },
    },
  };
}

// ---------------------------------------------------------------- execution

export class Executor<C> {
  private readonly schema: Schema<C>;

  constructor(schema: Schema<C>) {
    this.schema = { ...schema, ...introspectionTypes<C>() };
  }

  run(source: unknown, operationName: unknown, variables: unknown, ctx: C): ExecutionResult {
    if (typeof source !== 'string' || source.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
    let document: DocumentNode;
    try {
      document = parseDocument(source);
    } catch (err) {
      if (err instanceof GraphQLSyntaxError) return { errors: [{ message: err.message, type: 'SYNTAX_ERROR' }] };
      throw err;
    }
    const operations = document.operations;
    const operation = typeof operationName === 'string' && operationName !== ''
      ? operations.find((candidate) => candidate.name === operationName)
      : operations.length === 1 ? operations[0] : undefined;
    if (operation === undefined) {
      return { errors: [{ message: operations.length === 0 ? 'No operations in the document' : `Unknown operation named "${String(operationName)}".` }] };
    }
    const rootType = operation.operation === 'mutation' ? 'Mutation' : operation.operation === 'subscription' ? 'Subscription' : 'Query';
    if (this.schema[rootType] === undefined) return { errors: [{ message: `Schema is not configured for ${operation.operation}s` }] };
    const errors: GraphQLError[] = [];
    this.validate(document, rootType, operation.selections, errors, []);
    if (errors.length > 0) return { errors };
    const given = typeof variables === 'object' && variables !== null && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
    const vars: Record<string, unknown> = {};
    for (const definition of operation.variables) {
      if (definition.name in given && given[definition.name] !== undefined) vars[definition.name] = given[definition.name];
      else if (definition.defaultValue !== null) vars[definition.name] = this.literal(definition.defaultValue, {});
      else if (definition.type.endsWith('!')) errors.push({ message: `Variable $${definition.name} of type ${definition.type} was provided invalid value`, extensions: { code: 'variableMismatch' } });
    }
    if (errors.length > 0) return { errors };
    const state = { document, vars, ctx, errors: [] as GraphQLError[] };
    const data = this.selectObject(state, rootType, null, operation.selections, []);
    return state.errors.length > 0 ? { data, errors: state.errors } : { data };
  }

  /** Every field must exist on the type it is selected from (GitHub rejects the whole document otherwise). */
  private validate(document: DocumentNode, typeName: string, selections: Selection[], errors: GraphQLError[], seen: string[]): void {
    const type = this.schema[typeName];
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = document.fragments.get(selection.name);
        if (fragment === undefined) {
          errors.push({ message: `Fragment ${selection.name} was used, but not defined` });
          continue;
        }
        if (seen.includes(selection.name)) continue;
        this.validate(document, fragment.typeCondition, fragment.selections, errors, [...seen, selection.name]);
        continue;
      }
      if (selection.kind === 'inline') {
        const condition = selection.typeCondition ?? typeName;
        if (this.schema[condition] === undefined) errors.push({ message: `No such type ${condition}, so it can't be a fragment condition` });
        else this.validate(document, condition, selection.selections, errors, seen);
        continue;
      }
      if (selection.name === '__typename') continue;
      const field = type?.fields?.[selection.name] ?? (typeName === 'Query' ? this.introspectionField(selection.name) : undefined);
      if (field === undefined) {
        errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'`, path: [typeName, selection.name], extensions: { code: 'undefinedField', typeName, fieldName: selection.name } });
        continue;
      }
      const target = named(field.type);
      const targetDef = this.schema[target];
      const composite = targetDef !== undefined && (targetDef.kind === 'OBJECT' || targetDef.kind === 'INTERFACE' || targetDef.kind === 'UNION');
      if (composite && selection.selections === null) {
        errors.push({ message: `Field must have selections (field '${selection.name}' returns ${target} but has no selections. Did you mean '${selection.name} { ... }'?)` });
      } else if (!composite && selection.selections !== null) {
        errors.push({ message: `Selections can't be made on scalars (field '${selection.name}' returns ${target} but has selections [${selection.selections.map((child) => (child.kind === 'field' ? child.name : '...')).join(', ')}])` });
      } else if (composite && selection.selections !== null) {
        this.validate(document, target, selection.selections, errors, seen);
      }
    }
  }

  private introspectionField(name: string): FieldDef<C> | undefined {
    if (name === '__type') return { type: '__Type', args: { name: 'String!' } };
    if (name === '__schema') return { type: '__Schema!' };
    return undefined;
  }

  private literal(value: Value, vars: Record<string, unknown>): unknown {
    switch (value.kind) {
      case 'variable':
        return vars[value.name] ?? null;
      case 'list':
        return value.items.map((item) => this.literal(item, vars));
      case 'object':
        return Object.fromEntries(value.fields.map(([name, item]) => [name, this.literal(item, vars)]));
      default:
        return value.value;
    }
  }

  private included(directives: FieldNode['directives'], vars: Record<string, unknown>): boolean {
    for (const directive of directives) {
      const condition = directive.args.get('if');
      const flag = condition === undefined ? true : this.literal(condition, vars) === true;
      if (directive.name === 'skip' && flag) return false;
      if (directive.name === 'include' && !flag) return false;
    }
    return true;
  }

  /** Fields of a selection set for a concrete type, fragments expanded, grouped by response key. */
  private collect(state: { document: DocumentNode; vars: Record<string, unknown> }, typeName: string, selections: Selection[], into: Map<string, FieldNode[]>): void {
    for (const selection of selections) {
      if (!this.included(selection.directives, state.vars)) continue;
      if (selection.kind === 'field') {
        const key = selection.alias ?? selection.name;
        const list = into.get(key);
        if (list === undefined) into.set(key, [selection]);
        else list.push(selection);
        continue;
      }
      const fragment = selection.kind === 'spread' ? state.document.fragments.get(selection.name) : null;
      const condition = selection.kind === 'spread' ? (fragment?.typeCondition ?? null) : selection.typeCondition;
      if (condition !== null && !this.applies(condition, typeName)) continue;
      this.collect(state, typeName, selection.kind === 'spread' ? (fragment?.selections ?? []) : selection.selections, into);
    }
  }

  private applies(condition: string, typeName: string): boolean {
    if (condition === typeName) return true;
    const def = this.schema[condition];
    return def !== undefined && (def.possibleTypes ?? []).includes(typeName);
  }

  private selectObject(
    state: { document: DocumentNode; vars: Record<string, unknown>; ctx: C; errors: GraphQLError[] },
    typeName: string,
    parent: unknown,
    selections: Selection[],
    path: Array<string | number>,
  ): Record<string, unknown> {
    const fields = new Map<string, FieldNode[]>();
    this.collect(state, typeName, selections, fields);
    const out: Record<string, unknown> = {};
    const def = this.schema[typeName];
    for (const [key, nodes] of fields) {
      const node = nodes[0]!;
      const subSelections = nodes.flatMap((candidate) => candidate.selections ?? []);
      if (node.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      const args: Args = {};
      for (const [name, value] of node.args) args[name] = this.literal(value, state.vars);
      let spec = def?.fields?.[node.name];
      let resolver: Resolver<C> | undefined = spec?.resolve;
      let source = parent;
      if (typeName === 'Query' && (node.name === '__type' || node.name === '__schema')) {
        const meta = this.schema.__introspect!.fields![node.name === '__type' ? 'type' : 'schema']!;
        spec = meta;
        resolver = meta.resolve;
        source = this.schema;
      }
      if (spec === undefined) continue;
      let value: unknown;
      try {
        value = resolver === undefined ? (parent as Record<string, unknown> | null)?.[node.name] : invoke(resolver, source, args, state.ctx);
      } catch (err) {
        if (!(err instanceof FieldError)) throw err;
        state.errors.push({ message: err.message, path: [...path, key], type: err.type, locations: [{ line: 1, column: 1 }] });
        out[key] = null;
        continue;
      }
      out[key] = this.complete(state, spec.type, value, subSelections, [...path, key]);
    }
    return out;
  }

  private complete(
    state: { document: DocumentNode; vars: Record<string, unknown>; ctx: C; errors: GraphQLError[] },
    type: string,
    value: unknown,
    selections: Selection[],
    path: Array<string | number>,
  ): unknown {
    if (value === null || value === undefined) return null;
    const inner = type.endsWith('!') ? type.slice(0, -1) : type;
    if (inner.startsWith('[')) {
      const itemType = inner.slice(1, -1);
      return (value as unknown[]).map((item, index) => this.complete(state, itemType, item, selections, [...path, index]));
    }
    const def = this.schema[inner];
    if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
    let concrete = inner;
    if (def.kind === 'INTERFACE' || def.kind === 'UNION') {
      concrete = (value as { __typename?: string }).__typename ?? inner;
    }
    return this.selectObject(state, concrete, value, selections, path);
  }
}
