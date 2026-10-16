import type { JsonSchema } from './tool-spec.ts';

/**
 * Validates tool arguments against the subset of JSON Schema the specs use.
 * Returns a human-readable error for the agent, or null when valid.
 */
export function validateArgs(schema: JsonSchema, value: unknown): string | null {
  const errors: string[] = [];
  check(schema, value, 'args', errors);
  return errors.length ? errors.slice(0, 5).join('; ') : null;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => {
      const sub: string[] = [];
      check(s, value, path, sub);
      return sub.length === 0;
    });
    if (!ok) errors.push(`${path} does not match any allowed shape`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${path} must be ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => check(schema.items!, item, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object' && (schema.properties || schema.required)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    for (const [key, v] of Object.entries(record)) {
      const prop = schema.properties?.[key];
      if (prop) {
        if (v !== undefined) check(prop, v, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not a known parameter`);
      }
    }
  }
}
