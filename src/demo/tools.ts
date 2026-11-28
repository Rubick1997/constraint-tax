import type { ToolDef } from "../types.js";
import { tool } from "../tasks/helpers.js";
import { ERROR_CODES, REORDER_POLICY, SERVICES, WAREHOUSES, TXN_TARGET, ORDER_HISTORY_CUSTOMER, inventory, orderHistory, serviceLog, transactions } from "./data.js";

export interface ToolSpec {
  def: ToolDef;
  impl: (args: any) => unknown;
}

const NOT_FOUND = { error: "not found" };
export const norm = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
export const round2 = (x: number) => round(x, 2);

function table<T>(rows: Record<string, T>, arg: string): (a: any) => unknown {
  const t = new Map(Object.entries(rows).map(([k, v]) => [norm(k), v]));
  return (a) => t.get(norm(a?.[arg])) ?? NOT_FOUND;
}

// ------------------------------------------------------------------ fixed fake data used by the chain tasks

export const FX: Record<string, number> = { "USD>EUR": 0.9137, "GBP>EUR": 1.1642, "JPY>EUR": 0.00612, "EUR>USD": 1.0944 };
export const convertCurrency = (amount: number, from: string, to: string): any => {
  const rate = FX[`${norm(from)}>${norm(to)}`];
  return rate === undefined || !Number.isFinite(amount) ? NOT_FOUND : { converted: round2(amount * rate), currency: norm(to), rate };
};

export const ORDERS: Record<string, { status: string; amount: number; currency: string; refundable: boolean }> = {
  "PX-3101": { status: "delivered", amount: 120.5, currency: "USD", refundable: true },
  "PX-3102": { status: "in_transit", amount: 89, currency: "GBP", refundable: false },
  "PX-3103": { status: "delivered", amount: 15400, currency: "JPY", refundable: true },
};
export const WEATHER_F: Record<string, { condition: string; temp_f: number }> = {
  "Quillfen Bay": { condition: "clear", temp_f: 74.3 },
  Dorrowmere: { condition: "overcast", temp_f: 68.9 },
};
export const convertTemperature = (value: number, to: string): any =>
  !Number.isFinite(value) ? NOT_FOUND : norm(to) === "C" ? { value: round((value - 32) * (5 / 9), 1), scale: "C" } : norm(to) === "F" ? { value: round(value * 1.8 + 32, 1), scale: "F" } : NOT_FOUND;
export const EMPLOYEES: Record<string, { name: string; department: string; manager_id: string | null }> = {
  "E-2201": { name: "Ilsabet Voss", department: "Procurement", manager_id: "E-1100" },
  "E-2202": { name: "Torvald Penn", department: "Logistics", manager_id: "E-1200" },
  "E-1100": { name: "Orla Fenwick", department: "Procurement", manager_id: null },
  "E-1200": { name: "Hadrian Quell", department: "Logistics", manager_id: null },
};
export const BUDGETS: Record<string, number> = { Procurement: 410000, Logistics: 655000, Facilities: 233000 };
export const PRODUCTS: Record<string, { name: string; price_usd: number; weight_kg: number }> = {
  "ZT-100": { name: "Test pump head", price_usd: 48, weight_kg: 2.5 },
  "ZT-200": { name: "Test pump housing", price_usd: 41, weight_kg: 6 },
};
export const SHIPPING: Record<string, { base: number; per_kg: number }> = { Norvik: { base: 6.5, per_kg: 2.4 }, Pellam: { base: 9, per_kg: 1.9 } };
export const shippingCost = (country: string, kg: number): any => {
  const s = SHIPPING[Object.keys(SHIPPING).find((k) => norm(k) === norm(country)) ?? ""];
  return s && Number.isFinite(kg) ? { cost_usd: round2(s.base + s.per_kg * kg) } : NOT_FOUND;
};
export const DISTANCES: Record<string, number> = { "Alder Point|Brenmoor": 142, "Brenmoor|Cask Harbour": 98, "Cask Harbour|Dunwick Ridge": 240, "Alder Point|Dunwick Ridge": 401 };
export const distanceKm = (a: string, b: string): any => {
  const hit = Object.entries(DISTANCES).find(([k]) => {
    const [x, y] = k.split("|") as [string, string];
    return (norm(x) === norm(a) && norm(y) === norm(b)) || (norm(x) === norm(b) && norm(y) === norm(a));
  });
  return hit ? { km: hit[1] } : NOT_FOUND;
};
export const VEHICLES: Record<string, { type: string; l_per_100km: number }> = { "VAN-07": { type: "van", l_per_100km: 7.5 }, "TRK-02": { type: "truck", l_per_100km: 24 } };
export const FUEL_PRICE: Record<string, number> = { Kesland: 1.85, Tarvia: 1.97 };
export const TICKETS: Record<string, { customer_id: string; severity: string; subject: string }> = {
  "TK-901": { customer_id: "C-17", severity: "high", subject: "label printer offline" },
  "TK-902": { customer_id: "C-22", severity: "low", subject: "invoice copy request" },
  "TK-903": { customer_id: "C-31", severity: "medium", subject: "portal login loop" },
};
export const TIERS: Record<string, { tier: string; sla_hours: number }> = {
  "C-17": { tier: "gold", sla_hours: 4 },
  "C-22": { tier: "silver", sla_hours: 12 },
  "C-31": { tier: "gold", sla_hours: 6 },
};
export const CATEGORY_BUDGET: Record<string, number> = { travel: TXN_TARGET.cap, dining: 2100, software: 3300 };

const S = (description: string) => ({ type: "string" as const, description });
const N = (description: string) => ({ type: "number" as const, description });

export const REGISTRY: Record<string, ToolSpec> = {
  lookup_order: {
    def: tool("lookup_order", "Look up an order: status, amount, currency and whether it is refundable.", { order_id: S("Order ID, e.g. PX-3101") }),
    impl: table(ORDERS, "order_id") as any,
  },
  convert_currency: {
    def: tool("convert_currency", "Convert an amount between currencies at the fixed company rate; the result is rounded to 2 decimals.", {
      amount: N("Amount to convert"),
      from_currency: S("ISO code, e.g. USD"),
      to_currency: S("ISO code, e.g. EUR"),
    }),
    impl: (a) => convertCurrency(Number(a?.amount), a?.from_currency, a?.to_currency),
  },
  get_weather_f: {
    def: tool("get_weather_f", "Current weather for a city; the temperature is reported in Fahrenheit.", { city: S("City name") }),
    impl: table(WEATHER_F, "city"),
  },
  convert_temperature: {
    def: tool("convert_temperature", "Convert a temperature to the target scale (C or F), rounded to 1 decimal.", { value: N("Temperature value"), to_scale: S("Target scale: C or F") }),
    impl: (a) => convertTemperature(Number(a?.value), a?.to_scale),
  },
  get_employee: {
    def: tool("get_employee", "Look up an employee: name, department and manager ID.", { employee_id: S("Employee ID, e.g. E-2201") }),
    impl: table(EMPLOYEES, "employee_id"),
  },
  get_department_budget: {
    def: tool("get_department_budget", "Annual budget (USD) of a department.", { department: S("Department name") }),
    impl: (a) => {
      const k = Object.keys(BUDGETS).find((x) => norm(x) === norm(a?.department));
      return k ? { department: k, budget_usd: BUDGETS[k] } : NOT_FOUND;
    },
  },
  get_product: {
    def: tool("get_product", "Look up a product: price in USD and shipping weight in kg.", { sku: S("Product SKU, e.g. ZT-100") }),
    impl: table(PRODUCTS, "sku"),
  },
  get_shipping_rate: {
    def: tool("get_shipping_rate", "Shipping cost in USD to a destination country for a parcel weight.", { country: S("Destination country"), weight_kg: N("Parcel weight in kg") }),
    impl: (a) => shippingCost(a?.country, Number(a?.weight_kg)),
  },
  get_distance_km: {
    def: tool("get_distance_km", "Road distance in km between two named places (one leg).", { origin: S("Origin place"), destination: S("Destination place") }),
    impl: (a) => distanceKm(a?.origin, a?.destination),
  },
  get_vehicle: {
    def: tool("get_vehicle", "Look up a vehicle's fuel consumption in litres per 100 km.", { vehicle_id: S("Vehicle ID, e.g. VAN-07") }),
    impl: table(VEHICLES, "vehicle_id"),
  },
  get_fuel_price: {
    def: tool("get_fuel_price", "Fuel price in EUR per litre for a country.", { country: S("Country name") }),
    impl: (a) => {
      const k = Object.keys(FUEL_PRICE).find((x) => norm(x) === norm(a?.country));
      return k ? { country: k, eur_per_litre: FUEL_PRICE[k] } : NOT_FOUND;
    },
  },
  get_ticket: {
    def: tool("get_ticket", "Look up a support ticket: customer ID, severity and subject.", { ticket_id: S("Ticket ID, e.g. TK-901") }),
    impl: table(TICKETS, "ticket_id"),
  },
  get_customer_tier: {
    def: tool("get_customer_tier", "Look up a customer's support tier and SLA response hours.", { customer_id: S("Customer ID, e.g. C-17") }),
    impl: table(TIERS, "customer_id"),
  },
  // ---- bulky
  get_warehouse: {
    def: tool("get_warehouse", "Resolve a warehouse name to its code.", { name: S("Warehouse name") }),
    impl: (a) => {
      const k = Object.keys(WAREHOUSES).find((x) => norm(x) === norm(a?.name));
      return k ? { name: k, code: WAREHOUSES[k] } : NOT_FOUND;
    },
  },
  list_inventory: {
    def: tool("list_inventory", "List every inventory row across all warehouses (large). Each row has sku, name, category, warehouse code, on_hand, reorder_level, unit_cost_usd, supplier, last_counted, bin, description.", {}),
    impl: () => ({ row_count: inventory().length, rows: inventory() }),
  },
  get_reorder_policy: {
    def: tool("get_reorder_policy", "Minimum cover (units) policy for a category: an item is low when on_hand is strictly below min_cover_units.", { category: S("Item category") }),
    impl: (a) => {
      const k = Object.keys(REORDER_POLICY).find((x) => norm(x) === norm(a?.category));
      return k ? { category: k, min_cover_units: REORDER_POLICY[k] } : NOT_FOUND;
    },
  },
  get_service: {
    def: tool("get_service", "Resolve a service name to its service ID.", { name: S("Service name") }),
    impl: (a) => {
      const k = Object.keys(SERVICES).find((x) => norm(x) === norm(a?.name));
      return k ? { name: k, service_id: SERVICES[k] } : NOT_FOUND;
    },
  },
  get_log: {
    def: tool("get_log", "Fetch the full recent log of a service by service ID (large). One text line per event with level INFO, WARN or ERROR.", { service_id: S("Service ID, e.g. SVC-4410") }),
    impl: (a) => {
      const name = Object.keys(SERVICES).find((x) => norm(SERVICES[x]!) === norm(a?.service_id));
      return name ? { service_id: SERVICES[name], line_count: serviceLog(name).length, lines: serviceLog(name) } : NOT_FOUND;
    },
  },
  lookup_error_code: {
    def: tool("lookup_error_code", "Describe an error code such as E-4012.", { code: S("Error code") }),
    impl: (a) => {
      const k = Object.keys(ERROR_CODES).find((x) => norm(x) === norm(a?.code));
      return k ? { code: k, description: ERROR_CODES[k] } : NOT_FOUND;
    },
  },
  get_customer: {
    def: tool("get_customer", "Resolve a customer name to its customer ID.", { name: S("Customer name") }),
    impl: (a) => (norm(a?.name) === norm(ORDER_HISTORY_CUSTOMER.name) ? { name: ORDER_HISTORY_CUSTOMER.name, customer_id: ORDER_HISTORY_CUSTOMER.id } : NOT_FOUND),
  },
  get_order_history: {
    def: tool("get_order_history", "Full order history of a customer by customer ID (large). Each order has order_id, date (YYYY-MM-DD), status (paid, shipped, refunded, cancelled), amount_usd, items_count, channel, ship_city, note.", { customer_id: S("Customer ID, e.g. CUST-5150") }),
    impl: (a) => (norm(a?.customer_id) === norm(ORDER_HISTORY_CUSTOMER.id) ? { customer_id: ORDER_HISTORY_CUSTOMER.id, order_count: orderHistory().length, orders: orderHistory() } : NOT_FOUND),
  },
  get_account: {
    def: tool("get_account", "Resolve an account holder name to the account ID.", { holder: S("Account holder name") }),
    impl: (a) => (norm(a?.holder) === norm(TXN_TARGET.holder) ? { holder: TXN_TARGET.holder, account_id: TXN_TARGET.account } : NOT_FOUND),
  },
  list_transactions: {
    def: tool("list_transactions", "List every transaction of an account (large). Each row has txn_id, date, merchant, category, amount_usd, card_last4, memo.", { account_id: S("Account ID, e.g. ACC-77120") }),
    impl: (a) => (norm(a?.account_id) === norm(TXN_TARGET.account) ? { account_id: TXN_TARGET.account, txn_count: transactions().length, transactions: transactions() } : NOT_FOUND),
  },
  get_category_budget: {
    def: tool("get_category_budget", "Spending cap (USD) for a spending category over the whole period.", { category: S("Spending category") }),
    impl: (a) => {
      const k = Object.keys(CATEGORY_BUDGET).find((x) => norm(x) === norm(a?.category));
      return k ? { category: k, cap_usd: CATEGORY_BUDGET[k] } : NOT_FOUND;
    },
  },
};
