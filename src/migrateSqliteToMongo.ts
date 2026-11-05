import { DatabaseSync } from 'node:sqlite';
import { MongoClient, type Document } from 'mongodb';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync(resolve('.env'))) process.loadEnvFile(resolve('.env'));

type SqliteRow = Record<string, string | number | bigint | Uint8Array | null>;
interface MongoRow extends Document { _id: string | number }

const uri = process.env.MONGODB_URI?.trim();
if (!uri) throw new Error('MONGODB_URI is required to migrate SQLite data to MongoDB');

const sqlitePath = process.env.DB_PATH ?? './data/bettingify.db';
const resolvedSqlitePath = resolve(sqlitePath);
if (sqlitePath !== ':memory:' && !existsSync(resolvedSqlitePath)) {
  throw new Error(`SQLite database was not found at ${resolvedSqlitePath}`);
}

function documentId(table: string, row: SqliteRow): string | number {
  if (table === 'wallets') return String(row.user_id);
  if (table === 'idempotency_keys') return JSON.stringify([row.user_id, row.key]);
  if (row.id === undefined || row.id === null) {
    throw new Error(`Cannot determine a stable document ID for table "${table}"`);
  }
  return typeof row.id === 'bigint' ? Number(row.id) : row.id as string | number;
}

function comparableDocument(document: Document): string {
  const { _id: _ignored, ...fields } = document;
  return JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))));
}

const source = new DatabaseSync(sqlitePath, { readOnly: true });
source.exec('PRAGMA query_only = ON; BEGIN;');
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });

try {
  await client.connect();
  await client.db(process.env.MONGODB_DB?.trim() || 'bettingify').command({ ping: 1 });
  const target = client.db(process.env.MONGODB_DB?.trim() || 'bettingify');
  const tables = source.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];

  for (const { name: table } of tables) {
    const rows = source.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all() as SqliteRow[];
    const collection = target.collection<MongoRow>(table);
    let inserted = 0;
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500).map((row) => ({
        ...row,
        _id: documentId(table, row),
      }));
      if (!batch.length) continue;
      const result = await collection.bulkWrite(
        batch.map((document) => ({
          updateOne: {
            filter: { _id: document._id },
            update: { $setOnInsert: document },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      inserted += result.upsertedCount;

      const targetRows = await collection.find(
        { _id: { $in: batch.map((document) => document._id) } },
      ).toArray();
      const targetById = new Map(targetRows.map((document) => [document._id, document]));
      for (const sourceDocument of batch) {
        const targetDocument = targetById.get(sourceDocument._id);
        if (!targetDocument || comparableDocument(targetDocument) !== comparableDocument(sourceDocument)) {
          throw new Error(`Migration verification failed for collection "${table}"`);
        }
      }
    }
    console.log(`${table}: verified ${rows.length} row(s); inserted ${inserted} new document(s).`);
  }
  console.log('SQLite-to-MongoDB copy and verification completed. SQLite source was not modified.');
} catch (error) {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(`SQLite-to-MongoDB migration failed (${errorName}); connection details are suppressed.`);
  process.exitCode = 1;
} finally {
  source.close();
  await client.close();
}
