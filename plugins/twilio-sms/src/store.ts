import { Database } from "bun:sqlite";
import { join } from "node:path";

export interface SmsJob {
  sid: string;
  sender: string;
  recipient: string;
  body: string;
  state: string;
  conversation_id: string | null;
  reply: string | null;
}

export function openStore(directory: string, create = false): Database {
  const db = new Database(join(directory, "messages.sqlite"), { create, readwrite: true });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  if (create) {
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      sid TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      conversation_id TEXT, reply TEXT, outbound_sid TEXT, error TEXT,
      created_at INTEGER NOT NULL
    )`);
  }
  return db;
}

export function enqueue(db: Database, message: Omit<SmsJob, "state" | "conversation_id" | "reply">): void {
  db.query("INSERT OR IGNORE INTO messages (sid, sender, recipient, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(message.sid, message.sender, message.recipient, message.body, Date.now());
}

export function claim(db: Database): SmsJob | null {
  return db.query<SmsJob, []>(`UPDATE messages SET state = 'processing'
    WHERE sid = (SELECT sid FROM messages WHERE state = 'pending' ORDER BY created_at LIMIT 1)
    RETURNING *`).get();
}
