import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { TASKS } from "../src/tasks/index.js";
import { argsMatch } from "../src/session.js";

const ajv = new Ajv({ strict: false });

describe("tasks", () => {
  it("has 15 tasks with 2 tools each", () => {
    expect(TASKS).toHaveLength(15);
    for (const t of TASKS) expect(t.tools).toHaveLength(2);
  });
  for (const t of TASKS) {
    it(`${t.id} ${t.domain}: gold answer passes schema + checkAnswer`, () => {
      const out: any = t.impl[t.expectedTool]!(t.expectedArgs);
      expect(out.error).toBeUndefined();
      const gold = t.goldAnswer(out);
      expect(ajv.validate(t.schema.schema, gold)).toBe(true);
      expect(t.checkAnswer(gold)).toBe(true);
      expect(argsMatch(t.expectedArgs, t.expectedArgs)).toBe(true);
    });
    it(`${t.id}: wrong args return not found, wrong answer fails`, () => {
      const bad = Object.fromEntries(Object.keys(t.expectedArgs).map((k) => [k, "zzz-nope"]));
      expect(t.impl[t.expectedTool]!(bad)).toEqual({ error: "not found" });
      expect(t.impl[t.expectedTool]!(undefined)).toEqual({ error: "not found" });
      expect(t.checkAnswer({})).toBe(false);
      const props = (t.schema.schema as any).properties;
      expect((t.schema.schema as any).additionalProperties).toBe(false);
      expect(Object.keys(props).length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(props).length).toBeLessThanOrEqual(5);
    });
  }
});
