// Deterministic synthetic datasets for the brain/worker demo. Everything here is fake and obviously so.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private r: () => number;
  constructor(seed: number) {
    this.r = mulberry32(seed);
  }
  next = () => this.r();
  int = (a: number, b: number) => a + Math.floor(this.r() * (b - a + 1));
  pick = <T>(xs: readonly T[]): T => xs[Math.floor(this.r() * xs.length)]!;
  weighted = <T>(xs: readonly (readonly [T, number])[]): T => {
    const total = xs.reduce((s, [, w]) => s + w, 0);
    let x = this.r() * total;
    for (const [v, w] of xs) if ((x -= w) < 0) return v;
    return xs[xs.length - 1]![0];
  };
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const date = (r: Rng, from: string, days: number) => new Date(Date.parse(from) + r.int(0, days) * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ inventory (bulky)

export interface InvRow {
  sku: string;
  name: string;
  category: string;
  warehouse: string;
  on_hand: number;
  reorder_level: number;
  unit_cost_usd: number;
  supplier: string;
  last_counted: string;
  bin: string;
  description: string;
}

export const WAREHOUSES: Record<string, string> = {
  "Dunmere North": "WH-01",
  "Ostrava Quay Annex": "WH-02",
  "Fennick Depot": "WH-03",
  "Velmora Yard": "WH-04",
  "Harrowgate Cross": "WH-05",
};
export const INV_CATEGORIES = ["fasteners", "bearings", "gaskets", "sensors", "cables", "valves"] as const;
export const REORDER_POLICY: Record<string, number> = { fasteners: 120, bearings: 45, gaskets: 80, sensors: 60, cables: 90, valves: 35 };
export const INV_TARGET = { warehouseName: "Fennick Depot", warehouse: "WH-03", category: "sensors", minCover: 60 };

const WORDS = ["anodised", "braided", "calibrated", "dual-seal", "extended", "flanged", "grade-B", "hardened", "inline", "low-profile", "modular", "nickel", "obsolete-rev", "paired", "quick-fit", "reinforced", "sealed", "threaded"];

function makeInventory(): InvRow[] {
  const r = new Rng(7001);
  const whCodes = Object.values(WAREHOUSES);
  const rows: InvRow[] = [];
  for (let i = 1; i <= 250; i++) {
    const forced = i % 14 === 0; // guarantees a sizeable target group (WH-03 / sensors)
    const category = forced ? INV_TARGET.category : r.pick(INV_CATEGORIES);
    const warehouse = forced ? INV_TARGET.warehouse : r.pick(whCodes);
    rows.push({
      sku: `SKU-${pad(i, 4)}`,
      name: `Synthetic ${category.slice(0, -1)} model ${pad(r.int(1, 999), 3)}`,
      category,
      warehouse,
      on_hand: r.int(0, 400),
      reorder_level: r.int(20, 150),
      unit_cost_usd: r.int(120, 98000) / 100,
      supplier: `Fakesupply Co ${r.int(1, 12)}`,
      last_counted: date(r, "2026-01-05", 120),
      bin: `${r.pick(["A", "B", "C", "D"])}-${pad(r.int(1, 40), 2)}-${r.int(1, 6)}`,
      description: `${r.pick(WORDS)} ${r.pick(WORDS)} ${category.slice(0, -1)} for test rigs, lot ${pad(r.int(1, 9999), 4)}`,
    });
  }
  // Make on_hand distinct inside the target group so the max is unambiguous.
  const seen = new Set<number>();
  for (const row of rows)
    if (row.warehouse === INV_TARGET.warehouse && row.category === INV_TARGET.category) {
      while (seen.has(row.on_hand)) row.on_hand++;
      seen.add(row.on_hand);
    }
  return rows;
}

// ------------------------------------------------------------------ service log (bulky)

export const SERVICES: Record<string, string> = { "payments-gateway": "SVC-4410", "auth-fabric": "SVC-5521", "ledger-sync": "SVC-6632" };
export const ERROR_CODES: Record<string, string> = {
  "E-4012": "upstream card processor timeout",
  "E-4031": "token signature mismatch",
  "E-5003": "connection pool exhausted",
  "E-5077": "schema version conflict",
  "E-5120": "downstream queue full",
};
export const LOG_TARGET = { service: "payments-gateway", id: "SVC-4410" };

function makeLog(serviceName: string, seed: number): string[] {
  const r = new Rng(seed);
  const lines: { ts: number; text: string; level: string; code?: string }[] = [];
  const t0 = Date.parse("2026-03-14T06:00:00Z");
  const routes = ["/v2/charge", "/v2/refund", "/v2/capture", "/v2/void", "/v2/status"];
  for (let i = 0; i < 640; i++) {
    const ts = t0 + i * 31000 + r.int(0, 20000);
    const level = r.weighted([["INFO", 80], ["WARN", 12], ["ERROR", 8]] as const);
    let code: string | undefined;
    if (level === "ERROR") code = r.weighted([["E-4012", 5], ["E-4031", 3], ["E-5003", 2], ["E-5077", 2], ["E-5120", 1]] as const);
    if (level === "WARN") code = `W-${r.int(100, 140)}`;
    lines.push({ ts, level, code, text: "" });
  }
  // Unambiguous top error code: bump the leader until it leads the runner-up by at least 3.
  const counts = () => {
    const c: Record<string, number> = {};
    for (const l of lines) if (l.level === "ERROR") c[l.code!] = (c[l.code!] ?? 0) + 1;
    return c;
  };
  for (;;) {
    const sorted = Object.entries(counts()).sort((a, b) => b[1] - a[1]);
    if (sorted[0]![1] - (sorted[1]?.[1] ?? 0) >= 3) break;
    const donor = lines.find((l) => l.level === "ERROR" && l.code !== sorted[0]![0])!;
    donor.code = sorted[0]![0];
  }
  return lines.map((l, i) => {
    const iso = new Date(l.ts).toISOString().replace(".000Z", "Z");
    const status = l.level === "INFO" ? 200 : l.level === "WARN" ? 429 : 502;
    const codePart = l.code ? ` code=${l.code}` : "";
    return `${iso} ${l.level} ${serviceName}${codePart} req=RQ-${pad(100000 + i * 7 + r.int(0, 6), 6)} route=${r.pick(routes)} status=${status} latency_ms=${l.level === "ERROR" ? r.int(1800, 6000) : r.int(40, 900)} node=n-${pad(r.int(1, 12), 2)}`;
  });
}

// ------------------------------------------------------------------ order history (bulky)

export interface HistOrder {
  order_id: string;
  date: string;
  status: "paid" | "shipped" | "refunded" | "cancelled";
  amount_usd: number;
  items_count: number;
  channel: string;
  ship_city: string;
  note: string;
}
export const ORDER_HISTORY_CUSTOMER = { name: "Zephyrine Testco", id: "CUST-5150" };

function makeOrderHistory(): HistOrder[] {
  const r = new Rng(9113);
  const used = new Set<number>();
  const rows: HistOrder[] = [];
  for (let i = 0; i < 300; i++) {
    let cents = r.int(500, 250000);
    while (used.has(cents)) cents++;
    used.add(cents);
    rows.push({
      order_id: `ORD-${100001 + i * 3 + r.int(0, 2)}`,
      date: date(r, "2025-10-01", 270),
      status: r.weighted([["paid", 50], ["shipped", 20], ["refunded", 17], ["cancelled", 13]] as const),
      amount_usd: cents / 100,
      items_count: r.int(1, 12),
      channel: r.pick(["web", "phone", "partner-portal", "kiosk"]),
      ship_city: r.pick(["Velmora Heights", "Ostrava Quay", "Dunmere", "Fennick", "Harrowgate", "Quillfen Bay"]),
      note: `${r.pick(WORDS)} ${r.pick(["pallet", "crate", "parcel", "bundle"])} ref ${pad(r.int(1, 99999), 5)}`,
    });
  }
  return rows;
}

// ------------------------------------------------------------------ transactions (bulky)

export interface Txn {
  txn_id: string;
  date: string;
  merchant: string;
  category: string;
  amount_usd: number;
  card_last4: string;
  memo: string;
}
export const TXN_CATEGORIES = ["groceries", "travel", "dining", "software", "utilities", "fuel"] as const;
export const TXN_TARGET = { holder: "Brindle Parkes", account: "ACC-77120", category: "travel", cap: 18000 };

function makeTxns(): Txn[] {
  const r = new Rng(31337);
  const used = new Set<number>();
  const rows: Txn[] = [];
  for (let i = 0; i < 320; i++) {
    const category = r.weighted([["groceries", 25], ["travel", 18], ["dining", 22], ["software", 12], ["utilities", 12], ["fuel", 11]] as const);
    let cents = r.int(400, 60000);
    while (used.has(cents)) cents++;
    used.add(cents);
    rows.push({
      txn_id: `TX-${pad(880000 + i * 5 + r.int(0, 4), 6)}`,
      date: date(r, "2026-01-01", 180),
      merchant: `${r.pick(["Fake", "Test", "Mock", "Demo"])}${r.pick(["air", "otel", "mart", "soft", "fuel", "cafe"])} ${r.int(1, 40)}`,
      category,
      amount_usd: cents / 100,
      card_last4: pad(r.int(0, 9999), 4),
      memo: `${r.pick(WORDS)} ${category} purchase batch ${pad(r.int(1, 9999), 4)}`,
    });
  }
  return rows;
}

// lazily built (cheap, deterministic)
let inv: InvRow[] | undefined;
let logs: Record<string, string[]> | undefined;
let hist: HistOrder[] | undefined;
let txns: Txn[] | undefined;
export const inventory = () => (inv ??= makeInventory());
export const serviceLog = (name: string) => ((logs ??= {})[name] ??= makeLog(name, 4410 + name.length));
export const orderHistory = () => (hist ??= makeOrderHistory());
export const transactions = () => (txns ??= makeTxns());
