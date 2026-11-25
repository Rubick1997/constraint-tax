import { mkdirSync, writeFileSync } from "node:fs";
import { TASKS } from "./index.js";

const out = TASKS.map(({ impl: _i, checkAnswer: _c, goldAnswer: _g, ...rest }) => rest);
mkdirSync("bench", { recursive: true });
writeFileSync("bench/tasks.json", JSON.stringify(out, null, 2) + "\n");
console.log(`wrote bench/tasks.json (${out.length} tasks)`);
