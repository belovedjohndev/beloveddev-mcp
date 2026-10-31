import { AgentFailure } from './agent-evaluation.js';

/** Reviewed base-model subset only; not a general JSON Schema or API-acceptance validator. */
export function assertStructuredOutputSchema(input: unknown): void {
  const fail = (): never => {
    throw new AgentFailure('provider_configuration');
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  };
  const root = object(input);
  const scalar = (value: unknown) =>
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
  const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const formats = new Set([
    'date-time',
    'time',
    'date',
    'duration',
    'email',
    'hostname',
    'ipv4',
    'ipv6',
    'uuid',
  ]);
  const seen = new Set<object>();
  let properties = 0,
    enums = 0,
    characters = 0,
    nodes = 0;
  const addText = (text: string) => {
    characters += text.length;
    if (characters > 120000) fail();
  };
  const resolve = (ref: string): unknown => {
    if (ref === '#') return root;
    if (!ref.startsWith('#/')) return fail();
    let value: unknown = root;
    for (const raw of ref.slice(2).split('/')) {
      if (/~(?![01])/.test(raw)) return fail();
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return fail();
      value = Reflect.get(value, key);
    }
    return value;
  };
  const visit = (value: unknown, depth: number, top = false): void => {
    const node = object(value);
    if (seen.has(node)) return;
    if (++nodes > 10000 || depth > 10) fail();
    seen.add(node);
    const base = [
      '$schema',
      '$defs',
      '$ref',
      'type',
      'title',
      'description',
      'enum',
      'const',
      'anyOf',
    ];
    const declared = Array.isArray(node['type']) ? node['type'] : [node['type']];
    if (
      declared.some((t) => t !== undefined && (typeof t !== 'string' || !types.has(t))) ||
      new Set(declared).size !== declared.length
    )
      fail();
    if (
      top &&
      (node['type'] !== 'object' || node['anyOf'] !== undefined || node['$ref'] !== undefined)
    )
      fail();
    const allowed = new Set([
      ...base,
      ...(declared.includes('object') ? ['properties', 'required', 'additionalProperties'] : []),
      ...(declared.includes('array') ? ['items', 'minItems', 'maxItems'] : []),
      ...(declared.includes('string') ? ['pattern', 'format', 'minLength', 'maxLength'] : []),
      ...(declared.includes('number') || declared.includes('integer')
        ? ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']
        : []),
    ]);
    if (Object.keys(node).some((key) => !allowed.has(key))) fail();
    for (const key of ['title', 'description'])
      if (node[key] !== undefined && typeof node[key] !== 'string') fail();
    if (
      node['$schema'] !== undefined &&
      (!top || node['$schema'] !== 'https://json-schema.org/draft/2020-12/schema')
    )
      fail();
    if (node['$defs'] !== undefined)
      for (const [key, definition] of Object.entries(object(node['$defs']))) {
        addText(key);
        visit(definition, depth);
      }
    if (node['$ref'] !== undefined) {
      if (
        typeof node['$ref'] !== 'string' ||
        Object.keys(node).some((k) => !['$ref', 'description', 'title'].includes(k))
      )
        fail();
      visit(resolve(node['$ref'] as string), depth);
      return;
    }
    if (node['anyOf'] !== undefined) {
      if (!Array.isArray(node['anyOf']) || !node['anyOf'].length) fail();
      for (const variant of node['anyOf'] as unknown[]) visit(variant, depth + 1);
    } else if (node['type'] === undefined) fail();
    if (node['enum'] !== undefined) {
      if (!Array.isArray(node['enum']) || !node['enum'].length || !node['enum'].every(scalar))
        fail();
      const values = node['enum'] as (string | number | boolean | null)[];
      enums += values.length;
      if (enums > 1000 || new Set(values).size !== values.length) fail();
      const text = values.filter((v) => typeof v === 'string').join('');
      if (values.length > 250 && text.length > 15000) fail();
      addText(text);
    }
    if (node['const'] !== undefined) {
      if (!scalar(node['const'])) fail();
      if (typeof node['const'] === 'string') addText(node['const']);
    }
    if (declared.includes('object')) {
      const fields = object(node['properties']);
      const required = node['required'];
      if (
        node['additionalProperties'] !== false ||
        !Array.isArray(required) ||
        required.some((k) => typeof k !== 'string') ||
        new Set(required).size !== required.length ||
        required.length !== Object.keys(fields).length ||
        Object.keys(fields).some((k) => !required.includes(k))
      )
        fail();
      properties += Object.keys(fields).length;
      if (properties > 5000) fail();
      for (const [key, child] of Object.entries(fields)) {
        addText(key);
        visit(child, depth + 1);
      }
    }
    if (declared.includes('array')) visit(node['items'], depth + 1);
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'])
      if (
        node[key] !== undefined &&
        (!Number.isSafeInteger(node[key]) || (node[key] as number) < 0)
      )
        fail();
    for (const [min, max] of [
      ['minItems', 'maxItems'],
      ['minLength', 'maxLength'],
      ['minimum', 'maximum'],
    ] as const)
      if (typeof node[min] === 'number' && typeof node[max] === 'number' && node[min] > node[max])
        fail();
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
      if (
        node[key] !== undefined &&
        (typeof node[key] !== 'number' ||
          !Number.isFinite(node[key]) ||
          (key === 'multipleOf' && node[key] <= 0))
      )
        fail();
    if (
      node['format'] !== undefined &&
      (typeof node['format'] !== 'string' || !formats.has(node['format']))
    )
      fail();
    if (node['pattern'] !== undefined) {
      if (typeof node['pattern'] !== 'string') fail();
      try {
        new RegExp(node['pattern'] as string);
      } catch {
        fail();
      }
    }
  };
  visit(root, 0, true);
}
