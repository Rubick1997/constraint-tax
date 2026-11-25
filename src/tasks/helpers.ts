import type { ToolDef } from "../types.js";

export const SYSTEM =
  "You are an operations assistant at a fictional company. Always use the provided tools to look up facts; never guess values. When you have what you need, reply with a single JSON object and nothing else.";

type Prop = { type: "string" | "number" | "integer"; description: string };

export function tool(name: string, description: string, props: Record<string, Prop>): ToolDef {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false },
    },
  };
}

export function schema(name: string, props: Record<string, object>) {
  return {
    name,
    schema: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false },
  };
}

export const NOT_FOUND = { error: "not found" };

/** Table lookup tool impl: normalises the key (trim, uppercase, strip spaces) and never throws. */
export function tableImpl<T extends object>(argName: string, table: Record<string, T>) {
  const norm = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const t = Object.fromEntries(Object.entries(table).map(([k, v]) => [norm(k), v]));
  return (args: any): unknown => {
    const hit = t[norm(args?.[argName])];
    return hit ?? NOT_FOUND;
  };
}

export const strEq = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.toLowerCase();
export const numEq = (a: unknown, b: number, tol = 1e-6) => typeof a === "number" && Math.abs(a - b) <= tol;
export const distractor = (name: string) => (_args: any) => ({ error: "not found", note: `${name}: no data` });
