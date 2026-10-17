/**
 * Tool contracts. Each feature declares its tools here-style in `spec.ts`;
 * the bridge lists them to MCP clients and validates arguments, the
 * extension uses them for timeouts and per-tab exclusivity.
 */

export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null' | Array<'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'>;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  anyOf?: JsonSchema[];
}

export interface ObjectSchema extends JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchema>;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: ObjectSchema;
  annotations?: ToolAnnotations;
  /** Time budget enforced by the extension; a numeric `timeoutMs` argument may extend it up to `maxTimeoutMs`. */
  timeoutMs?: number;
  maxTimeoutMs?: number;
  /** Tools that change page state run one at a time per tab. */
  exclusive?: boolean;
  /** Tools that do not operate on a tab (no target-tab resolution). */
  noTab?: boolean;
}

// Small schema builders keep spec files readable.

export function obj(properties: Record<string, JsonSchema>, required: string[] = []): ObjectSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra });
export const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'number', description, ...extra });
export const int = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'integer', description, ...extra });
export const bool = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'boolean', description, ...extra });
export const oneOf = (values: string[], description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', enum: values, description, ...extra });
export const arr = (items: JsonSchema, description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'array', items, description, ...extra });

/** Present on every tab-scoped tool. */
export const tabIdParam: JsonSchema = int('Tab to act on. Defaults to the session target tab (see tab_select).');
export const timeoutParam: JsonSchema = int('Maximum time to wait, in milliseconds.');
export const refParam: JsonSchema = str('Element ref from page_snapshot or find, e.g. "e12".');
export const savePathParam: JsonSchema = str('Absolute file path to save to. Defaults to a file in the kyte-webmcp output folder.');

export function defineTools(...specs: ToolSpec[]): ToolSpec[] {
  return specs;
}
