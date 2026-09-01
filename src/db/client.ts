import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, COLUMN_MIGRATIONS } from "./schema.js";

let db: Database.Database | undefined;

interface TableInfoRow {
  name: string;
}

function getExistingColumns(database: Database.Database, table: string): Set<string> {
  // PRAGMA doesn't support bound parameters; safe here since `table` only
  // ever comes from our own hardcoded COLUMN_MIGRATIONS list, never input.
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
  return new Set(rows.map((row) => row.name));
}

function runColumnMigrations(database: Database.Database): void {
  const columnsByTable = new Map<string, Set<string>>();

  for (const migration of COLUMN_MIGRATIONS) {
    let existingColumns = columnsByTable.get(migration.table);
    if (!existingColumns) {
      existingColumns = getExistingColumns(database, migration.table);
      columnsByTable.set(migration.table, existingColumns);
    }

    if (!existingColumns.has(migration.column)) {
      database.exec(migration.ddl);
      existingColumns.add(migration.column);
    }
  }
}

/** Opens (or returns the already-open) SQLite connection, running schema migrations idempotently. */
export function getDb(dbPath: string): Database.Database {
  if (db) return db;

  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  runColumnMigrations(db);
  return db;
}
