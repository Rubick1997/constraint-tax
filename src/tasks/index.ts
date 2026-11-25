import type { Task } from "../types.js";
import { NOT_FOUND, SYSTEM, distractor, numEq, schema, strEq, tableImpl, tool } from "./helpers.js";

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const I = { type: "integer" } as const;
const B = { type: "boolean" } as const;

export const TASKS: Task[] = [
  {
    id: "t01",
    domain: "order-lookup",
    system: SYSTEM,
    user: "Where is order QX-48213? Answer as a JSON object with three fields: status (the order's status code exactly as the system reports it), tracking_number (the carrier tracking number), and eta_days (whole days until the delivery estimate).",
    tools: [
      tool("get_order_status", "Look up the current status, tracking number and delivery estimate of an order.", {
        order_id: { type: "string", description: "Order ID, e.g. AB-12345" },
      }),
      tool("get_invoice", "Look up the invoice total for an order.", {
        order_id: { type: "string", description: "Order ID, e.g. AB-12345" },
      }),
    ],
    impl: {
      get_order_status: tableImpl("order_id", {
        "QX-48213": { status: "held_at_customs", tracking_number: "ZK8-55107-T", eta_days: 6 },
        "QX-10077": { status: "delivered", tracking_number: "ZK8-20031-A", eta_days: 0 },
      }),
      get_invoice: distractor("get_invoice"),
    },
    expectedTool: "get_order_status",
    expectedArgs: { order_id: "QX-48213" },
    schema: schema("order_status", { status: S, tracking_number: S, eta_days: I }),
    checkAnswer: (a) => strEq(a.status, "held_at_customs") && strEq(a.tracking_number, "ZK8-55107-T") && numEq(a.eta_days, 6),
    goldAnswer: (o) => ({ status: o.status, tracking_number: o.tracking_number, eta_days: o.eta_days }),
  },
  {
    id: "t02",
    domain: "unit-conversion",
    system: SYSTEM,
    user: "Convert 42 zorbits to meters. The zorbit is a made-up unit, so use the tool for the conversion. Answer as a JSON object with two fields: original_value (the number of zorbits given) and meters (the length in meters).",
    tools: [
      tool("convert_zorbit", "Convert a length in zorbits (a company-internal unit) to meters.", {
        value: { type: "number", description: "Length in zorbits" },
      }),
      tool("convert_temperature", "Convert a temperature between Celsius and Fahrenheit.", {
        value: { type: "number", description: "Temperature value" },
        to_scale: { type: "string", description: "Target scale: C or F" },
      }),
    ],
    impl: {
      convert_zorbit: (a) => (typeof a?.value === "number" ? { meters: Math.round(a.value * 1.8734 * 1e4) / 1e4, factor: 1.8734 } : NOT_FOUND),
      convert_temperature: distractor("convert_temperature"),
    },
    expectedTool: "convert_zorbit",
    expectedArgs: { value: 42 },
    schema: schema("zorbit_conversion", { original_value: N, meters: N }),
    checkAnswer: (a) => numEq(a.original_value, 42) && numEq(a.meters, 78.6828, 0.01),
    goldAnswer: (o) => ({ original_value: 42, meters: o.meters }),
  },
  {
    id: "t03",
    domain: "weather",
    system: SYSTEM,
    user: "What is the weather in Velmora Heights right now? Answer as a JSON object with three fields: condition (a short lowercase word for the sky/precipitation as reported), temp_c (temperature in Celsius) and wind_kph (wind speed in km/h).",
    tools: [
      tool("get_weather", "Get current weather conditions for a city.", { city: { type: "string", description: "City name" } }),
      tool("get_air_quality", "Get the current air quality index for a city.", { city: { type: "string", description: "City name" } }),
    ],
    impl: {
      get_weather: tableImpl("city", { "Velmora Heights": { condition: "sleet", temp_c: 13.4, wind_kph: 27 }, "Ostrava Quay": { condition: "fog", temp_c: 4.1, wind_kph: 6 } }),
      get_air_quality: distractor("get_air_quality"),
    },
    expectedTool: "get_weather",
    expectedArgs: { city: "Velmora Heights" },
    schema: schema("weather_report", { condition: S, temp_c: N, wind_kph: N }),
    checkAnswer: (a) => strEq(a.condition, "sleet") && numEq(a.temp_c, 13.4) && numEq(a.wind_kph, 27),
    goldAnswer: (o) => ({ condition: o.condition, temp_c: o.temp_c, wind_kph: o.wind_kph }),
  },
  {
    id: "t04",
    domain: "inventory",
    system: SYSTEM,
    user: "Check stock for SKU BX-7731-QZ. Answer as a JSON object with three fields: on_hand (units in stock, integer), warehouse (the warehouse code holding it) and reorder_flag (true or false, whether a reorder has been flagged).",
    tools: [
      tool("check_stock", "Check current stock level, warehouse and reorder flag for a SKU.", { sku: { type: "string", description: "SKU code" } }),
      tool("get_supplier_info", "Get the supplier name and lead time for a SKU.", { sku: { type: "string", description: "SKU code" } }),
    ],
    impl: {
      check_stock: tableImpl("sku", { "BX-7731-QZ": { on_hand: 148, warehouse: "Dunmere-3", reorder_flag: true }, "BX-1200-AA": { on_hand: 9, warehouse: "Dunmere-1", reorder_flag: false } }),
      get_supplier_info: distractor("get_supplier_info"),
    },
    expectedTool: "check_stock",
    expectedArgs: { sku: "BX-7731-QZ" },
    schema: schema("stock_report", { on_hand: I, warehouse: S, reorder_flag: B }),
    checkAnswer: (a) => numEq(a.on_hand, 148) && strEq(a.warehouse, "Dunmere-3") && a.reorder_flag === true,
    goldAnswer: (o) => ({ on_hand: o.on_hand, warehouse: o.warehouse, reorder_flag: o.reorder_flag }),
  },
  {
    id: "t05",
    domain: "exchange-rate",
    system: SYSTEM,
    user: "Convert 250 KRV (Karvian rupel) to TLM (Tolmar mark) at the current rate. Answer as a JSON object with two fields: rate (units of TLM per 1 KRV) and converted_amount (the TLM amount for 250 KRV).",
    tools: [
      tool("get_exchange_rate", "Get the current exchange rate between two currencies.", {
        base: { type: "string", description: "Base currency code" },
        quote: { type: "string", description: "Quote currency code" },
      }),
      tool("get_rate_history", "Get the 30-day average exchange rate between two currencies.", {
        base: { type: "string", description: "Base currency code" },
        quote: { type: "string", description: "Quote currency code" },
      }),
    ],
    impl: {
      get_exchange_rate: (a) => (String(a?.base).trim().toUpperCase() === "KRV" && String(a?.quote).trim().toUpperCase() === "TLM" ? { rate: 3.8271, as_of: "2026-11-24" } : NOT_FOUND),
      get_rate_history: distractor("get_rate_history"),
    },
    expectedTool: "get_exchange_rate",
    expectedArgs: { base: "KRV", quote: "TLM" },
    schema: schema("conversion", { rate: N, converted_amount: N }),
    checkAnswer: (a) => numEq(a.rate, 3.8271, 1e-4) && numEq(a.converted_amount, 956.775, 0.01),
    goldAnswer: (o) => ({ rate: o.rate, converted_amount: Math.round(o.rate * 250 * 1e3) / 1e3 }),
  },
  {
    id: "t06",
    domain: "shipping-quote",
    system: SYSTEM,
    user: "Get a shipping quote for a 12.5 kg parcel from Port Halvard to Lindqvist Bay. Answer as a JSON object with three fields: price_usd (the quoted price), carrier (carrier name) and transit_days (whole days in transit).",
    tools: [
      tool("get_shipping_quote", "Get a shipping quote for a parcel between two cities.", {
        origin_city: { type: "string", description: "Origin city" },
        dest_city: { type: "string", description: "Destination city" },
        weight_kg: { type: "number", description: "Parcel weight in kg" },
      }),
      tool("get_customs_fee", "Estimate customs fees for a parcel between two countries.", {
        origin_country: { type: "string", description: "Origin country" },
        dest_country: { type: "string", description: "Destination country" },
      }),
    ],
    impl: {
      get_shipping_quote: (a) =>
        String(a?.origin_city).trim().toLowerCase() === "port halvard" && String(a?.dest_city).trim().toLowerCase() === "lindqvist bay" && typeof a?.weight_kg === "number"
          ? { price_usd: Math.round((40 + 3.792 * a.weight_kg) * 100) / 100, carrier: "NorthTide Freight", transit_days: 5 }
          : NOT_FOUND,
      get_customs_fee: distractor("get_customs_fee"),
    },
    expectedTool: "get_shipping_quote",
    expectedArgs: { origin_city: "Port Halvard", dest_city: "Lindqvist Bay", weight_kg: 12.5 },
    schema: schema("shipping_quote", { price_usd: N, carrier: S, transit_days: I }),
    checkAnswer: (a) => numEq(a.price_usd, 87.4, 0.01) && strEq(a.carrier, "NorthTide Freight") && numEq(a.transit_days, 5),
    goldAnswer: (o) => ({ price_usd: o.price_usd, carrier: o.carrier, transit_days: o.transit_days }),
  },
  {
    id: "t07",
    domain: "booking",
    system: SYSTEM,
    user: "Reserve a table at Marrowfield Bistro on 2026-12-03 for 4 people. Answer as a JSON object with three fields: confirmation_code (the reservation code), table (the table label) and time (the reserved time, HH:MM).",
    tools: [
      tool("reserve_table", "Reserve a restaurant table and return the confirmation.", {
        restaurant: { type: "string", description: "Restaurant name" },
        date: { type: "string", description: "Date, YYYY-MM-DD" },
        party_size: { type: "integer", description: "Number of guests" },
      }),
      tool("search_restaurants", "Search restaurants by cuisine in a city.", {
        city: { type: "string", description: "City name" },
        cuisine: { type: "string", description: "Cuisine type" },
      }),
    ],
    impl: {
      reserve_table: (a) =>
        String(a?.restaurant).trim().toLowerCase() === "marrowfield bistro" && String(a?.date).trim() === "2026-12-03" && Number(a?.party_size) === 4
          ? { confirmation_code: "RSV-9Q4M2", table: "B14", time: "19:45" }
          : NOT_FOUND,
      search_restaurants: distractor("search_restaurants"),
    },
    expectedTool: "reserve_table",
    expectedArgs: { restaurant: "Marrowfield Bistro", date: "2026-12-03", party_size: 4 },
    schema: schema("reservation", { confirmation_code: S, table: S, time: S }),
    checkAnswer: (a) => strEq(a.confirmation_code, "RSV-9Q4M2") && strEq(a.table, "B14") && strEq(a.time, "19:45"),
    goldAnswer: (o) => ({ confirmation_code: o.confirmation_code, table: o.table, time: o.time }),
  },
  {
    id: "t08",
    domain: "flight-status",
    system: SYSTEM,
    user: "What is the status of flight VK2291? Answer as a JSON object with three fields: status (the status word as reported), gate (the departure gate) and delay_minutes (whole minutes of delay).",
    tools: [
      tool("get_flight_status", "Get live status, gate and delay for a flight.", { flight_number: { type: "string", description: "Flight number, e.g. AB1234" } }),
      tool("get_baggage_info", "Get the baggage carousel for a flight.", { flight_number: { type: "string", description: "Flight number, e.g. AB1234" } }),
    ],
    impl: {
      get_flight_status: tableImpl("flight_number", { VK2291: { status: "delayed", gate: "C17", delay_minutes: 85 }, VK0045: { status: "on_time", gate: "A02", delay_minutes: 0 } }),
      get_baggage_info: distractor("get_baggage_info"),
    },
    expectedTool: "get_flight_status",
    expectedArgs: { flight_number: "VK2291" },
    schema: schema("flight_status", { status: S, gate: S, delay_minutes: I }),
    checkAnswer: (a) => strEq(a.status, "delayed") && strEq(a.gate, "C17") && numEq(a.delay_minutes, 85),
    goldAnswer: (o) => ({ status: o.status, gate: o.gate, delay_minutes: o.delay_minutes }),
  },
  {
    id: "t09",
    domain: "asset-tracking",
    system: SYSTEM,
    user: "Look up asset tag AT-90412. Answer as a JSON object with three fields: location (where the asset is housed), owner_team (the team that owns it) and warranty_expires (the warranty end date, YYYY-MM-DD).",
    tools: [
      tool("lookup_asset", "Look up location, owning team and warranty of an asset by tag.", { asset_tag: { type: "string", description: "Asset tag, e.g. AT-00000" } }),
      tool("lookup_vendor", "Look up vendor contact details by vendor code.", { vendor_code: { type: "string", description: "Vendor code" } }),
    ],
    impl: {
      lookup_asset: tableImpl("asset_tag", {
        "AT-90412": { location: "Rack R12, Hall Quillon", owner_team: "Tidewater Ops", warranty_expires: "2028-03-19" },
        "AT-11800": { location: "Rack R03, Hall Quillon", owner_team: "Harbor Net", warranty_expires: "2027-01-02" },
      }),
      lookup_vendor: distractor("lookup_vendor"),
    },
    expectedTool: "lookup_asset",
    expectedArgs: { asset_tag: "AT-90412" },
    schema: schema("asset_info", { location: S, owner_team: S, warranty_expires: S }),
    checkAnswer: (a) => strEq(a.location, "Rack R12, Hall Quillon") && strEq(a.owner_team, "Tidewater Ops") && strEq(a.warranty_expires, "2028-03-19"),
    goldAnswer: (o) => ({ location: o.location, owner_team: o.owner_team, warranty_expires: o.warranty_expires }),
  },
  {
    id: "t10",
    domain: "tariff-lookup",
    system: SYSTEM,
    user: "What import duty applies to product code PRD-5521 shipped to Orlanda? Answer as a JSON object with two fields: duty_percent (the duty rate as a percentage number) and requires_license (true or false).",
    tools: [
      tool("get_tariff_rate", "Get the import duty percentage and license requirement for a product code and destination country.", {
        product_code: { type: "string", description: "Product code, e.g. PRD-0000" },
        country: { type: "string", description: "Destination country" },
      }),
      tool("get_product_description", "Get the catalog description of a product code.", { product_code: { type: "string", description: "Product code" } }),
    ],
    impl: {
      get_tariff_rate: (a) =>
        String(a?.product_code).trim().toUpperCase() === "PRD-5521" && String(a?.country).trim().toLowerCase() === "orlanda" ? { duty_percent: 7.35, requires_license: true } : NOT_FOUND,
      get_product_description: distractor("get_product_description"),
    },
    expectedTool: "get_tariff_rate",
    expectedArgs: { product_code: "PRD-5521", country: "Orlanda" },
    schema: schema("tariff", { duty_percent: N, requires_license: B }),
    checkAnswer: (a) => numEq(a.duty_percent, 7.35) && a.requires_license === true,
    goldAnswer: (o) => ({ duty_percent: o.duty_percent, requires_license: o.requires_license }),
  },
  {
    id: "t11",
    domain: "scheduling",
    system: SYSTEM,
    user: "Find the next free slot for a tire rotation at Harbrook Service Center. Answer as a JSON object with three fields: date (YYYY-MM-DD), time (HH:MM) and slot_id (the slot identifier).",
    tools: [
      tool("find_next_slot", "Find the next available appointment slot for a service at a service center.", {
        center: { type: "string", description: "Service center name" },
        service: { type: "string", description: "Service name" },
      }),
      tool("get_center_hours", "Get opening hours of a service center.", { center: { type: "string", description: "Service center name" } }),
    ],
    impl: {
      find_next_slot: (a) =>
        String(a?.center).trim().toLowerCase() === "harbrook service center" && String(a?.service).trim().toLowerCase() === "tire rotation"
          ? { date: "2026-12-09", time: "10:20", slot_id: "SL-55820" }
          : NOT_FOUND,
      get_center_hours: distractor("get_center_hours"),
    },
    expectedTool: "find_next_slot",
    expectedArgs: { center: "Harbrook Service Center", service: "tire rotation" },
    schema: schema("slot", { date: S, time: S, slot_id: S }),
    checkAnswer: (a) => strEq(a.date, "2026-12-09") && strEq(a.time, "10:20") && strEq(a.slot_id, "SL-55820"),
    goldAnswer: (o) => ({ date: o.date, time: o.time, slot_id: o.slot_id }),
  },
  {
    id: "t12",
    domain: "library",
    system: SYSTEM,
    user: "Is catalog item CAT-88214 available? Answer as a JSON object with three fields: copies_available (integer), branch (the branch holding the copies) and due_back (the date the next loaned copy is due back, YYYY-MM-DD).",
    tools: [
      tool("get_book_copies", "Get availability of a library catalog item.", { catalog_id: { type: "string", description: "Catalog ID, e.g. CAT-00000" } }),
      tool("get_author_info", "Get the author biography for a catalog item.", { catalog_id: { type: "string", description: "Catalog ID" } }),
    ],
    impl: {
      get_book_copies: tableImpl("catalog_id", { "CAT-88214": { copies_available: 3, branch: "Eastwick Annex", due_back: "2026-12-14" } }),
      get_author_info: distractor("get_author_info"),
    },
    expectedTool: "get_book_copies",
    expectedArgs: { catalog_id: "CAT-88214" },
    schema: schema("availability", { copies_available: I, branch: S, due_back: S }),
    checkAnswer: (a) => numEq(a.copies_available, 3) && strEq(a.branch, "Eastwick Annex") && strEq(a.due_back, "2026-12-14"),
    goldAnswer: (o) => ({ copies_available: o.copies_available, branch: o.branch, due_back: o.due_back }),
  },
  {
    id: "t13",
    domain: "support-ticket",
    system: SYSTEM,
    user: "Look up support ticket TCK-70392. Answer as a JSON object with three fields: priority (the priority code), assignee_queue (the queue it is assigned to) and opened_hours_ago (whole hours since it was opened).",
    tools: [
      tool("get_ticket", "Get priority, assigned queue and age of a support ticket.", { ticket_id: { type: "string", description: "Ticket ID, e.g. TCK-00000" } }),
      tool("get_customer_plan", "Get the subscription plan of a customer account.", { account_id: { type: "string", description: "Account ID" } }),
    ],
    impl: {
      get_ticket: tableImpl("ticket_id", { "TCK-70392": { priority: "P2", assignee_queue: "billing-tier2", opened_hours_ago: 53 } }),
      get_customer_plan: distractor("get_customer_plan"),
    },
    expectedTool: "get_ticket",
    expectedArgs: { ticket_id: "TCK-70392" },
    schema: schema("ticket", { priority: S, assignee_queue: S, opened_hours_ago: I }),
    checkAnswer: (a) => strEq(a.priority, "P2") && strEq(a.assignee_queue, "billing-tier2") && numEq(a.opened_hours_ago, 53),
    goldAnswer: (o) => ({ priority: o.priority, assignee_queue: o.assignee_queue, opened_hours_ago: o.opened_hours_ago }),
  },
  {
    id: "t14",
    domain: "meter-reading",
    system: SYSTEM,
    user: "Read utility meter MTR-4408-ZP. Answer as a JSON object with three fields: kwh (the cumulative reading in kWh), last_read (the date of the last reading, YYYY-MM-DD) and tariff (the tariff name).",
    tools: [
      tool("get_meter_reading", "Get the latest reading, read date and tariff of a utility meter.", { meter_id: { type: "string", description: "Meter ID, e.g. MTR-0000-AA" } }),
      tool("get_outage_status", "Get outage status for a district.", { district: { type: "string", description: "District name" } }),
    ],
    impl: {
      get_meter_reading: tableImpl("meter_id", { "MTR-4408-ZP": { kwh: 18342.7, last_read: "2026-11-20", tariff: "night-saver" } }),
      get_outage_status: distractor("get_outage_status"),
    },
    expectedTool: "get_meter_reading",
    expectedArgs: { meter_id: "MTR-4408-ZP" },
    schema: schema("meter", { kwh: N, last_read: S, tariff: S }),
    checkAnswer: (a) => numEq(a.kwh, 18342.7, 0.01) && strEq(a.last_read, "2026-11-20") && strEq(a.tariff, "night-saver"),
    goldAnswer: (o) => ({ kwh: o.kwh, last_read: o.last_read, tariff: o.tariff }),
  },
  {
    id: "t15",
    domain: "parcel-locker",
    system: SYSTEM,
    user: "Where do I collect parcel PC-6620-HV? Answer as a JSON object with three fields: locker (the locker label), pin (the pickup PIN as a string) and station (the station name).",
    tools: [
      tool("get_locker_code", "Get the locker label, pickup PIN and station for a parcel.", { parcel_id: { type: "string", description: "Parcel ID, e.g. PC-0000-AA" } }),
      tool("get_station_hours", "Get opening hours of a parcel station.", { station: { type: "string", description: "Station name" } }),
    ],
    impl: {
      get_locker_code: tableImpl("parcel_id", { "PC-6620-HV": { locker: "L-0231", pin: "482915", station: "Oakmere Central" } }),
      get_station_hours: distractor("get_station_hours"),
    },
    expectedTool: "get_locker_code",
    expectedArgs: { parcel_id: "PC-6620-HV" },
    schema: schema("pickup", { locker: S, pin: S, station: S }),
    checkAnswer: (a) => strEq(a.locker, "L-0231") && strEq(String(a.pin ?? ""), "482915") && strEq(a.station, "Oakmere Central"),
    goldAnswer: (o) => ({ locker: o.locker, pin: o.pin, station: o.station }),
  },
];
