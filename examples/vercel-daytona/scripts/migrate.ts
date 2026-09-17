import { readConfig } from "../src/config.js";
import { schemaSql } from "../src/schema.js";
import { database } from "../src/store.js";

const db = database(readConfig().DATABASE_URL);
await db.transaction(async (tx) => {
  await tx.query("SET LOCAL lock_timeout = '5s'");
  await tx.query("SET LOCAL statement_timeout = '30s'");
  await tx.query(schemaSql);
});
console.log("Demo database schema ready");
process.exit(0);
