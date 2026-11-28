import type { ToolDef } from "../types.js";
import { INV_TARGET, LOG_TARGET, ORDER_HISTORY_CUSTOMER, TXN_TARGET, inventory, orderHistory, serviceLog, transactions } from "./data.js";
import { BUDGETS, EMPLOYEES, FUEL_PRICE, ORDERS, PRODUCTS, REGISTRY, TICKETS, TIERS, VEHICLES, WEATHER_F, convertCurrency, convertTemperature, distanceKm, round2, shippingCost } from "./tools.js";
import { numEq, strEq } from "../tasks/helpers.js";

export type Call = (name: string, args: Record<string, unknown>) => any;

export interface DemoTask {
  id: string;
  kind: "chain" | "bulky";
  title: string;
  prompt: string;
  /** Tools offered to the model: the needed ones plus unrelated distractors. */
  toolNames: string[];
  schema: { name: string; schema: object };
  /** Gold answer computed directly from the fake data. */
  gold: Record<string, unknown>;
  /** Array fields whose order matters (default: order-insensitive). */
  orderedFields?: string[];
  /** Scripted perfect agent: reaches the answer only through tool calls. */
  perfect: (call: Call) => Record<string, unknown>;
  /** Rough count of sequential tool rounds (used only for the dry-run projection). */
  depth: number;
  /** Name of the large-payload tool, for bulky tasks. */
  bulkyTool?: string;
}

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const I = { type: "integer" } as const;
const B = { type: "boolean" } as const;
const SA = { type: "array", items: { type: "string" } } as const;
const schema = (name: string, props: Record<string, object>) => ({
  name,
  schema: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false },
});

const cents = (x: number) => Math.round(x * 100);

// ------------------------------------------------------------------ chain tasks

const c01: DemoTask = (() => {
  const refundable = Object.entries(ORDERS).filter(([, o]) => o.refundable);
  const totalEur = refundable.reduce((s, [, o]) => s + cents(convertCurrency(o.amount, o.currency, "EUR").converted as number), 0) / 100;
  return {
    id: "c01",
    kind: "chain",
    title: "refundable orders to EUR",
    prompt:
      "Orders PX-3101, PX-3102 and PX-3103 were placed in different currencies. Look up each order. For every order that the system marks as refundable, convert its amount to EUR with the FX tool (convert each order separately; the tool already rounds to 2 decimals) and add up the converted amounts. Answer as a JSON object with two fields: refundable_order_ids (array of the refundable order IDs, sorted ascending) and total_eur (the sum of the converted amounts, 2 decimal places).",
    toolNames: ["lookup_order", "convert_currency", "get_ticket", "get_vehicle"],
    schema: schema("refund_total", { refundable_order_ids: SA, total_eur: N }),
    gold: { refundable_order_ids: refundable.map(([id]) => id).sort(), total_eur: totalEur },
    orderedFields: ["refundable_order_ids"],
    depth: 2,
    perfect: (call) => {
      const ids: string[] = [];
      let sum = 0;
      for (const id of ["PX-3101", "PX-3102", "PX-3103"]) {
        const o = call("lookup_order", { order_id: id });
        if (!o.refundable) continue;
        ids.push(id);
        sum += cents(call("convert_currency", { amount: o.amount, from_currency: o.currency, to_currency: "EUR" }).converted);
      }
      return { refundable_order_ids: ids.sort(), total_eur: sum / 100 };
    },
  };
})();

const c02: DemoTask = (() => {
  const t = Object.entries(WEATHER_F).map(([city, w]) => ({ city, c: convertTemperature(w.temp_f, "C").value as number }));
  const [warm, cold] = [...t].sort((a, b) => b.c - a.c) as [(typeof t)[0], (typeof t)[0]];
  return {
    id: "c02",
    kind: "chain",
    title: "warmer of two cities",
    prompt:
      "Which is warmer right now, Quillfen Bay or Dorrowmere? The weather tool reports Fahrenheit, so convert both temperatures to Celsius with the conversion tool (it rounds to 1 decimal) before comparing. Answer as a JSON object with three fields: warmer_city (the city name), warmer_temp_c (its Celsius temperature) and difference_c (warmer minus colder Celsius temperature, 1 decimal place).",
    toolNames: ["get_weather_f", "convert_temperature", "get_distance_km", "get_fuel_price"],
    schema: schema("warmer_city", { warmer_city: S, warmer_temp_c: N, difference_c: N }),
    gold: { warmer_city: warm.city, warmer_temp_c: warm.c, difference_c: Math.round((warm.c - cold.c) * 10) / 10 },
    depth: 2,
    perfect: (call) => {
      const r = ["Quillfen Bay", "Dorrowmere"].map((city) => {
        const w = call("get_weather_f", { city });
        return { city, c: call("convert_temperature", { value: w.temp_f, to_scale: "C" }).value as number };
      });
      const [a, b] = r[0]!.c > r[1]!.c ? [r[0]!, r[1]!] : [r[1]!, r[0]!];
      return { warmer_city: a.city, warmer_temp_c: a.c, difference_c: Math.round((a.c - b.c) * 10) / 10 };
    },
  };
})();

const c03: DemoTask = (() => {
  const ids = ["E-2201", "E-2202"];
  const best = ids.map((id) => ({ id, e: EMPLOYEES[id]!, b: BUDGETS[EMPLOYEES[id]!.department]! })).sort((a, b) => b.b - a.b)[0]!;
  return {
    id: "c03",
    kind: "chain",
    title: "bigger-budget department, then manager",
    prompt:
      "Employees E-2201 and E-2202 work in different departments. Find out whose department has the larger annual budget, then find that employee's manager. Answer as a JSON object with four fields: employee_id (of the employee whose department has the larger budget), department (that department's name), budget_usd (that department's annual budget as a number) and manager_name (the full name of that employee's manager).",
    toolNames: ["get_employee", "get_department_budget", "get_ticket", "get_customer_tier"],
    schema: schema("budget_winner", { employee_id: S, department: S, budget_usd: N, manager_name: S }),
    gold: { employee_id: best.id, department: best.e.department, budget_usd: best.b, manager_name: EMPLOYEES[best.e.manager_id!]!.name },
    depth: 3,
    perfect: (call) => {
      const rows = ids.map((id) => {
        const e = call("get_employee", { employee_id: id });
        return { id, e, b: call("get_department_budget", { department: e.department }).budget_usd as number };
      });
      const w = rows.sort((a, b) => b.b - a.b)[0]!;
      return { employee_id: w.id, department: w.e.department, budget_usd: w.b, manager_name: call("get_employee", { employee_id: w.e.manager_id }).name };
    },
  };
})();

const c04: DemoTask = (() => {
  const skus = ["ZT-100", "ZT-200"];
  const tot = skus.map((sku) => ({ sku, t: round2(PRODUCTS[sku]!.price_usd + (shippingCost("Norvik", PRODUCTS[sku]!.weight_kg).cost_usd as number)) })).sort((a, b) => a.t - b.t);
  return {
    id: "c04",
    kind: "chain",
    title: "cheaper landed cost",
    prompt:
      "We can order either ZT-100 or ZT-200 for delivery to Norvik. For each SKU, the landed cost is its unit price in USD plus the shipping cost in USD of one unit to Norvik (use the product's weight with the shipping tool). Answer as a JSON object with three fields: cheaper_sku (the SKU with the lower landed cost), cheaper_total_usd (its landed cost, 2 decimals) and other_total_usd (the other SKU's landed cost, 2 decimals).",
    toolNames: ["get_product", "get_shipping_rate", "lookup_order", "get_fuel_price"],
    schema: schema("landed_cost", { cheaper_sku: S, cheaper_total_usd: N, other_total_usd: N }),
    gold: { cheaper_sku: tot[0]!.sku, cheaper_total_usd: tot[0]!.t, other_total_usd: tot[1]!.t },
    depth: 2,
    perfect: (call) => {
      const t = skus
        .map((sku) => {
          const p = call("get_product", { sku });
          return { sku, t: round2(p.price_usd + call("get_shipping_rate", { country: "Norvik", weight_kg: p.weight_kg }).cost_usd) };
        })
        .sort((a, b) => a.t - b.t);
      return { cheaper_sku: t[0]!.sku, cheaper_total_usd: t[0]!.t, other_total_usd: t[1]!.t };
    },
  };
})();

const c05: DemoTask = (() => {
  const legs: [string, string][] = [["Alder Point", "Brenmoor"], ["Brenmoor", "Cask Harbour"], ["Cask Harbour", "Dunwick Ridge"]];
  const km = legs.reduce((s, [a, b]) => s + (distanceKm(a, b).km as number), 0);
  const litres = (km * VEHICLES["VAN-07"]!.l_per_100km) / 100;
  return {
    id: "c05",
    kind: "chain",
    title: "trip fuel cost",
    prompt:
      "Plan a trip Alder Point -> Brenmoor -> Cask Harbour -> Dunwick Ridge (three legs) with vehicle VAN-07 in the country Kesland. Look up each leg's distance, the vehicle's consumption and the fuel price. Answer as a JSON object with three fields: total_km (sum of the three legs), litres (total_km x l_per_100km / 100, 1 decimal place) and fuel_cost_eur (litres x price per litre, rounded to 2 decimals).",
    toolNames: ["get_distance_km", "get_vehicle", "get_fuel_price", "get_weather_f", "get_product"],
    schema: schema("trip_cost", { total_km: N, litres: N, fuel_cost_eur: N }),
    gold: { total_km: km, litres: Math.round(litres * 10) / 10, fuel_cost_eur: round2(litres * FUEL_PRICE["Kesland"]!) },
    depth: 2,
    perfect: (call) => {
      const total = legs.reduce((s, [origin, destination]) => s + call("get_distance_km", { origin, destination }).km, 0);
      const l = (total * call("get_vehicle", { vehicle_id: "VAN-07" }).l_per_100km) / 100;
      return { total_km: total, litres: Math.round(l * 10) / 10, fuel_cost_eur: round2(l * call("get_fuel_price", { country: "Kesland" }).eur_per_litre) };
    },
  };
})();

const c06: DemoTask = (() => {
  const ids = Object.keys(TICKETS);
  const gold = ids.filter((id) => TIERS[TICKETS[id]!.customer_id]!.tier === "gold");
  return {
    id: "c06",
    kind: "chain",
    title: "gold-tier tickets and SLA hours",
    prompt:
      "Look at support tickets TK-901, TK-902 and TK-903. For each ticket find the customer's support tier. Answer as a JSON object with two fields: gold_ticket_ids (array of the ticket IDs whose customer is in the gold tier, sorted ascending) and total_sla_hours (the sum of the SLA hours of those gold-tier customers, one term per gold ticket).",
    toolNames: ["get_ticket", "get_customer_tier", "get_employee", "convert_currency"],
    schema: schema("gold_tickets", { gold_ticket_ids: SA, total_sla_hours: N }),
    gold: { gold_ticket_ids: gold.sort(), total_sla_hours: gold.reduce((s, id) => s + TIERS[TICKETS[id]!.customer_id]!.sla_hours, 0) },
    orderedFields: ["gold_ticket_ids"],
    depth: 2,
    perfect: (call) => {
      const out: string[] = [];
      let sla = 0;
      for (const id of ["TK-901", "TK-902", "TK-903"]) {
        const t = call("get_ticket", { ticket_id: id });
        const tier = call("get_customer_tier", { customer_id: t.customer_id });
        if (tier.tier === "gold") {
          out.push(id);
          sla += tier.sla_hours;
        }
      }
      return { gold_ticket_ids: out.sort(), total_sla_hours: sla };
    },
  };
})();

// ------------------------------------------------------------------ bulky tasks

const b01: DemoTask = (() => {
  const rows = inventory().filter((r) => r.warehouse === INV_TARGET.warehouse && r.category === INV_TARGET.category);
  const top = [...rows].sort((a, b) => b.on_hand - a.on_hand)[0]!;
  return {
    id: "b01",
    kind: "bulky",
    title: "low-stock sensors at one warehouse (inventory ~250 rows)",
    prompt:
      "Consider the sensors held at the warehouse named Fennick Depot. Resolve the warehouse name to its code, get the category's minimum cover policy, and list the inventory. Among the inventory rows with that warehouse code and category sensors, count how many are low (on_hand strictly below the category's min_cover_units), and find the SKU with the highest on_hand. Answer as a JSON object with three fields: low_stock_count (integer), top_on_hand_sku (the SKU with the highest on_hand among those rows) and group_size (how many rows are in that warehouse and category).",
    toolNames: ["get_warehouse", "get_reorder_policy", "list_inventory", "get_product", "get_shipping_rate"],
    schema: schema("low_stock", { low_stock_count: I, top_on_hand_sku: S, group_size: I }),
    gold: { low_stock_count: rows.filter((r) => r.on_hand < INV_TARGET.minCover).length, top_on_hand_sku: top.sku, group_size: rows.length },
    depth: 2,
    bulkyTool: "list_inventory",
    perfect: (call) => {
      const wh = call("get_warehouse", { name: "Fennick Depot" }).code;
      const min = call("get_reorder_policy", { category: "sensors" }).min_cover_units;
      const grp = (call("list_inventory", {}).rows as any[]).filter((r) => r.warehouse === wh && r.category === "sensors");
      return {
        low_stock_count: grp.filter((r) => r.on_hand < min).length,
        top_on_hand_sku: [...grp].sort((a, b) => b.on_hand - a.on_hand)[0].sku,
        group_size: grp.length,
      };
    },
  };
})();

const b02: DemoTask = (() => {
  const lines = serviceLog(LOG_TARGET.service).filter((l) => l.split(" ")[1] === "ERROR");
  const counts: Record<string, number> = {};
  for (const l of lines) {
    const code = /code=(E-\d+)/.exec(l)![1]!;
    counts[code] = (counts[code] ?? 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return {
    id: "b02",
    kind: "bulky",
    title: "error census of a service log (~640 lines)",
    prompt:
      "Investigate the service payments-gateway. Resolve its service ID, fetch its log, then count the lines whose level is ERROR (ignore INFO and WARN lines, including their W- codes). Among the ERROR lines only, find the most frequent error code (code=E-xxxx) and look up its description with the error-code tool. Answer as a JSON object with four fields: error_count (integer), top_error_code, top_error_code_count (integer) and top_error_description (as returned by the tool).",
    toolNames: ["get_service", "get_log", "lookup_error_code", "get_customer", "get_account"],
    schema: schema("log_census", { error_count: I, top_error_code: S, top_error_code_count: I, top_error_description: S }),
    gold: { error_count: lines.length, top_error_code: top[0], top_error_code_count: top[1], top_error_description: (REGISTRY.lookup_error_code!.impl({ code: top[0] }) as any).description },
    depth: 3,
    bulkyTool: "get_log",
    perfect: (call) => {
      const id = call("get_service", { name: "payments-gateway" }).service_id;
      const errs = (call("get_log", { service_id: id }).lines as string[]).filter((l) => l.split(" ")[1] === "ERROR");
      const c: Record<string, number> = {};
      for (const l of errs) c[/code=(E-\d+)/.exec(l)![1]!] = (c[/code=(E-\d+)/.exec(l)![1]!] ?? 0) + 1;
      const t = Object.entries(c).sort((a, b) => b[1] - a[1])[0]!;
      return { error_count: errs.length, top_error_code: t[0], top_error_code_count: t[1], top_error_description: call("lookup_error_code", { code: t[0] }).description };
    },
  };
})();

const b03: DemoTask = (() => {
  const ref = orderHistory().filter((o) => o.status === "refunded" && o.date >= "2026-01-01" && o.date <= "2026-03-31");
  const usdCents = ref.reduce((s, o) => s + cents(o.amount_usd), 0);
  return {
    id: "b03",
    kind: "bulky",
    title: "Q1 refunds in a long order history (~300 orders)",
    prompt:
      "For the customer Zephyrine Testco, resolve the customer ID and fetch the full order history. Consider only orders with status refunded and a date from 2026-01-01 to 2026-03-31 inclusive. Add up their amount_usd values exactly (cents matter), then convert that single USD total to EUR with the FX tool. Answer as a JSON object with three fields: refunded_count (integer), top3_order_ids (the three refunded orders with the largest amount_usd, largest first) and total_eur (the converted total, 2 decimals).",
    toolNames: ["get_customer", "get_order_history", "convert_currency", "get_account", "lookup_order"],
    schema: schema("q1_refunds", { refunded_count: I, top3_order_ids: SA, total_eur: N }),
    gold: {
      refunded_count: ref.length,
      top3_order_ids: [...ref].sort((a, b) => b.amount_usd - a.amount_usd).slice(0, 3).map((o) => o.order_id),
      total_eur: convertCurrency(usdCents / 100, "USD", "EUR").converted,
    },
    orderedFields: ["top3_order_ids"],
    depth: 3,
    bulkyTool: "get_order_history",
    perfect: (call) => {
      const id = call("get_customer", { name: "Zephyrine Testco" }).customer_id;
      const r = (call("get_order_history", { customer_id: id }).orders as any[]).filter((o) => o.status === "refunded" && o.date >= "2026-01-01" && o.date <= "2026-03-31");
      const total = r.reduce((s, o) => s + cents(o.amount_usd), 0) / 100;
      return {
        refunded_count: r.length,
        top3_order_ids: [...r].sort((a, b) => b.amount_usd - a.amount_usd).slice(0, 3).map((o) => o.order_id),
        total_eur: call("convert_currency", { amount: total, from_currency: "USD", to_currency: "EUR" }).converted,
      };
    },
  };
})();

const b04: DemoTask = (() => {
  const tr = transactions().filter((t) => t.category === TXN_TARGET.category);
  const total = tr.reduce((s, t) => s + cents(t.amount_usd), 0) / 100;
  return {
    id: "b04",
    kind: "bulky",
    title: "travel spend vs cap in a transaction list (~320 rows)",
    prompt:
      "For the account holder Brindle Parkes, resolve the account ID, list all transactions, and look up the spending cap for the category travel. Considering only transactions with category travel, answer as a JSON object with four fields: travel_count (integer), travel_total_usd (sum of amount_usd, 2 decimals), largest_travel_txn_id (the txn_id with the largest amount_usd) and over_cap (true if the travel total is strictly greater than the cap, else false).",
    toolNames: ["get_account", "list_transactions", "get_category_budget", "get_customer", "convert_currency"],
    schema: schema("travel_spend", { travel_count: I, travel_total_usd: N, largest_travel_txn_id: S, over_cap: B }),
    gold: {
      travel_count: tr.length,
      travel_total_usd: total,
      largest_travel_txn_id: [...tr].sort((a, b) => b.amount_usd - a.amount_usd)[0]!.txn_id,
      over_cap: total > TXN_TARGET.cap,
    },
    depth: 3,
    bulkyTool: "list_transactions",
    perfect: (call) => {
      const id = call("get_account", { holder: "Brindle Parkes" }).account_id;
      const cap = call("get_category_budget", { category: "travel" }).cap_usd;
      const t = (call("list_transactions", { account_id: id }).transactions as any[]).filter((x) => x.category === "travel");
      const sum = t.reduce((s, x) => s + cents(x.amount_usd), 0) / 100;
      return { travel_count: t.length, travel_total_usd: sum, largest_travel_txn_id: [...t].sort((a, b) => b.amount_usd - a.amount_usd)[0].txn_id, over_cap: sum > cap };
    },
  };
})();

export const DEMO_TASKS: DemoTask[] = [c01, c02, c03, c04, c05, c06, b01, b02, b03, b04];

// ------------------------------------------------------------------ helpers

export const demoToolDefs = (t: DemoTask): ToolDef[] => t.toolNames.map((n) => REGISTRY[n]!.def);

/** Executes a tool by name; never throws. */
export const makeExecutor = (onCall?: (name: string, args: unknown, out: unknown) => void) => (name: string, args: unknown): unknown => {
  const spec = REGISTRY[name];
  const out = spec ? spec.impl(args ?? {}) : { error: `unknown tool ${name}` };
  onCall?.(name, args, out);
  return out;
};

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

function fieldOk(gold: unknown, actual: unknown, ordered: boolean): boolean {
  if (typeof gold === "number") return typeof actual === "number" && numEq(actual, gold, 0.0051);
  if (typeof gold === "string") return strEq(actual, gold);
  if (typeof gold === "boolean") return actual === gold;
  if (Array.isArray(gold)) {
    if (!Array.isArray(actual) || actual.length !== gold.length) return false;
    const g = gold.map(norm);
    const a = actual.map(norm);
    if (ordered) return g.every((x, i) => x === a[i]);
    return [...g].sort().join("\u0000") === [...a].sort().join("\u0000");
  }
  return false;
}

/** Field-level check against the gold answer. */
export function checkFields(task: Pick<DemoTask, "gold" | "orderedFields">, answer: unknown): { correct: boolean; fieldScore: number; perField: Record<string, boolean> } {
  const keys = Object.keys(task.gold);
  const perField: Record<string, boolean> = {};
  const obj = answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
  for (const k of keys) perField[k] = fieldOk(task.gold[k], obj[k], task.orderedFields?.includes(k) ?? false);
  const n = keys.filter((k) => perField[k]).length;
  return { correct: n === keys.length, fieldScore: keys.length ? n / keys.length : 0, perField };
}

/** ~3.5 chars per token for JSON-ish text (rough estimate, no tokenizer). */
export const estTokens = (s: string) => Math.ceil(s.length / 3.5);
