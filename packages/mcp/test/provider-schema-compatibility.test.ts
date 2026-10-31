import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claimsSchema } from './agent-evaluation.js';
import { wireActionSchema, checkedWireActionSchema } from './provider-wire-contract.js';
import { assertStructuredOutputSchema } from './provider-schema-compatibility.js';
const closed = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
describe('offline Structured Outputs subset', () => {
  it('validates the exact generated Zod wire schema including UUID, numeric and nested nullable/anyOf constraints', () => {
    const schema = z.toJSONSchema(wireActionSchema);
    expect(checkedWireActionSchema()).toEqual(schema);
    expect(() => assertStructuredOutputSchema(schema)).not.toThrow();
    const text = JSON.stringify(schema);
    expect(text).toContain('"anyOf"');
    expect(text).toContain('"format":"uuid"');
    expect(text).toContain('"minimum":0');
    expect(text).toContain('"maximum":100');
    expect(
      claimsSchema.shape.projectIds.safeParse([
        '11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111',
      ]).success,
    ).toBe(false);
  });
  it('supports local definitions and recursive references without fetching anything', () => {
    expect(() =>
      assertStructuredOutputSchema({
        ...closed({ value: { $ref: '#/$defs/value' } }),
        $defs: {
          value: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0, maximum: 100 }] },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertStructuredOutputSchema(closed({ children: { type: 'array', items: { $ref: '#' } } })),
    ).not.toThrow();
  });
  it.each([
    { anyOf: [closed({})] },
    { type: 'array', items: { type: 'string' } },
    { ...closed({ x: { type: 'string' } }), required: [] },
    { ...closed({ x: { type: 'string' } }), required: ['x', 'x'] },
    { ...closed({}), additionalProperties: true },
    closed({ x: { type: 'object', properties: {}, required: [] } }),
    closed({ x: { type: 'string', format: 'private-format' } }),
    closed({ x: { type: 'string', pattern: '[' } }),
    closed({ x: { $ref: 'https://example.test/schema' } }),
    closed({ x: { $ref: '#/$defs/missing' } }),
    { ...closed({}), $defs: { unused: { type: 'string', unsupported: true } } },
    closed({ x: { type: 'number', minimum: 10, maximum: 1 } }),
    closed({ x: { type: 'number', minimum: Infinity } }),
    closed({ x: { type: 'number', multipleOf: 0 } }),
    closed({ x: { type: 'array', minItems: -1, items: { type: 'string' } } }),
    closed({
      x: { anyOf: [{ type: 'string' }, { type: 'object', properties: {}, required: [] }] },
    }),
  ])('rejects an incompatible schema (%#)', (schema) => {
    expect(() => assertStructuredOutputSchema(schema)).toThrow('provider_configuration');
  });
  it.each([
    'allOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'dependentRequired',
    'dependentSchemas',
    'patternProperties',
    'uniqueItems',
    'default',
  ])('rejects unsupported %s', (keyword) => {
    expect(() => assertStructuredOutputSchema({ ...closed({}), [keyword]: true })).toThrow(
      'provider_configuration',
    );
  });
});
