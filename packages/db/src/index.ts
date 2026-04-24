import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";

let _sql: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getDb(url?: string) {
  if (_db) return _db;
  const connString = url ?? process.env.DATABASE_URL;
  if (!connString) {
    throw new Error("DATABASE_URL is not set");
  }
  _sql = postgres(connString, { max: 8 });
  _db = drizzle(_sql, { schema });
  return _db;
}

export async function closeDb() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
  }
}
