// A dependency-free validator for the JSON Schema subset used by the files in
// schemas/. It reports every failure as a structured diagnostic so the same
// schema drives runtime validation, provider structured output, and docs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "./diagnostics.mjs";

export type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  not?: JsonSchema;
  description?: string;
  [key: string]: unknown;
};

const SCHEMA_DIR_CANDIDATES = [
  // scripts/lib -> <root>/schemas, and dist/runtime/scripts/lib -> dist/runtime/schemas
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas"),
];

export function loadSchema(name: string): JsonSchema {
  for (const directory of SCHEMA_DIR_CANDIDATES) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as JsonSchema;
  }
  throw new Error(`Schema '${name}' was not found next to the runtime scripts.`);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function childPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? base
      ? `${base}.${key}`
      : key
    : `${base}[${JSON.stringify(key)}]`;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  const target = match ? root.$defs?.[match[1]] : undefined;
  if (!target) throw new Error(`Unsupported schema reference '${ref}'.`);
  return target;
}

function describe(schema: JsonSchema): string {
  return typeof schema.description === "string" ? ` ${schema.description}` : "";
}

/** Validate `value`; an empty list means it conforms. */
export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  root: JsonSchema = schema,
  at = "",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const add = (message: string, hint?: string, where = at): void => {
    diagnostics.push({ code: "schema", path: where || "$", message, ...(hint ? { hint } : {}) });
  };
  if (schema.$ref) return validateJsonSchema(resolveRef(root, schema.$ref), value, root, at);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      add(`Expected ${types.join(" or ")}, received ${typeOf(value)}.${describe(schema)}`);
      return diagnostics;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    add(`Expected ${JSON.stringify(schema.const)}.`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    add(`Expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}.`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      add(`Must contain at least ${schema.minLength} character(s).${describe(schema)}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      add(
        `Must contain at most ${schema.maxLength} characters; received ${value.length}.`,
        "Shorten it.",
      );
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      add(`Does not match the required format.${describe(schema)}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      add(`Must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum)
      add(`Must be at most ${schema.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      add(`Must contain at least ${schema.minItems} item(s).${describe(schema)}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      add(
        `Must contain at most ${schema.maxItems} item(s); received ${value.length}.`,
        "Keep only the most important entries.",
      );
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) add("Items must be unique.");
    }
    if (schema.items) {
      value.forEach((item, index) =>
        diagnostics.push(
          ...validateJsonSchema(schema.items as JsonSchema, item, root, childPath(at, index)),
        ),
      );
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (!(key in object)) add(`Missing required field '${key}'.`, undefined, childPath(at, key));
    }
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) {
        diagnostics.push(...validateJsonSchema(property, item, root, childPath(at, key)));
      } else if (schema.additionalProperties === false) {
        add(
          `Unknown field '${key}'.`,
          "Remove it; only documented fields are accepted.",
          childPath(at, key),
        );
      } else if (typeof schema.additionalProperties === "object") {
        diagnostics.push(
          ...validateJsonSchema(schema.additionalProperties, item, root, childPath(at, key)),
        );
      }
    }
  }
  if (schema.anyOf) {
    const branches = schema.anyOf.map((branch) => validateJsonSchema(branch, value, root, at));
    if (!branches.some((branch) => branch.length === 0)) {
      const best = branches.reduce((left, right) => (right.length < left.length ? right : left));
      if (best.length) diagnostics.push(...best);
      else add(`Does not match any allowed form.${describe(schema)}`);
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (branch) => validateJsonSchema(branch, value, root, at).length === 0,
    ).length;
    if (matches !== 1) add(`Must match exactly one allowed form.${describe(schema)}`);
  }
  if (schema.not && validateJsonSchema(schema.not, value, root, at).length === 0) {
    add(`Uses a forbidden combination of fields.${describe(schema)}`);
  }
  return diagnostics;
}

const STRICT_UNSUPPORTED = new Set([
  "$schema",
  "$id",
  "$comment",
  "minLength",
  "maxLength",
  "uniqueItems",
  "not",
  "default",
  "examples",
]);

/**
 * Derive the variant accepted by strict structured-output providers: every
 * property is required (optional ones become nullable), objects are closed,
 * and keywords those providers reject are dropped. Null values are removed
 * again by `stripNulls` before the canonical validator runs.
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const convert = (node: JsonSchema): JsonSchema => {
    const output: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (STRICT_UNSUPPORTED.has(key)) continue;
      if (key === "oneOf") output.anyOf = (value as JsonSchema[]).map(convert);
      else if (key === "anyOf") output.anyOf = (value as JsonSchema[]).map(convert);
      else if (key === "items") output.items = convert(value as JsonSchema);
      else if (key === "$defs") {
        output.$defs = Object.fromEntries(
          Object.entries(value as Record<string, JsonSchema>).map(([name, def]) => [
            name,
            convert(def),
          ]),
        );
      } else if (key !== "properties" && key !== "required" && key !== "additionalProperties") {
        output[key] = value;
      }
    }
    if (node.properties) {
      const required = new Set(node.required || []);
      output.properties = Object.fromEntries(
        Object.entries(node.properties).map(([name, property]) => {
          const converted = convert(property);
          return [name, required.has(name) ? converted : { anyOf: [converted, { type: "null" }] }];
        }),
      );
      output.required = Object.keys(node.properties);
      output.additionalProperties = false;
      // Requirement-only branches cannot be expressed once every field is required.
      if (output.anyOf?.every((branch) => !branch.type && !branch.$ref)) delete output.anyOf;
    }
    return output;
  };
  return convert(schema);
}

/** Remove null-valued object fields recursively (strict providers emit them for omitted fields). */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, stripNulls(item)]),
  );
}
