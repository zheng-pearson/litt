import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { digest, randomToken, Vault } from "./security.js";

export type Tenant = {
  id: string;
  telegram_id: string;
  email: string | null;
  status: "pending" | "provisioning" | "active";
  sandbox_id: string | null;
  secrets: string | null;
  google_app_id: string | null;
  merged_into?: string | null;
  channel_alias?: boolean;
};
export type Job = {
  id: string;
  tenant_id: string;
  kind: "telegram" | "whatsapp" | "provision" | "oauth_resume" | "oauth_notice";
  payload: string;
  attempts: number;
  lease_token: string;
  created_at?: Date | string;
};
export type Ticket = { tenant_id: string; payload: string | null };
export interface Database {
  query<T>(text: string, args?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}

export function database(url: string): Database {
  const sql = postgres(url, { max: 2, idle_timeout: 10, connect_timeout: 10 });
  const adapt = (client: typeof sql): Database => ({
    async query<T>(text: string, args: unknown[] = []) {
      return (await client.unsafe(text, args as never[])) as unknown as T[];
    },
    async transaction<T>(fn: (db: Database) => Promise<T>) {
      return (await client.begin((tx) =>
        fn(adapt(tx as unknown as typeof sql)),
      )) as T;
    },
  });
  return adapt(sql);
}

export class Store {
  constructor(
    public db: Database,
    public vault: Vault,
  ) {}
  async tenant(id: string): Promise<Tenant> {
    const [row] = await this.db.query<Tenant>(
      "SELECT * FROM demo_tenants WHERE id=$1",
      [id],
    );
    if (!row) {
      throw new Error("Tenant not found");
    }
    if (row.merged_into) {
      const target = await this.tenant(row.merged_into);
      return { ...target, telegram_id: row.telegram_id, channel_alias: true };
    }
    return row;
  }
  async ensureTenant(telegramId: string): Promise<Tenant> {
    const [row] = await this.db.query<Tenant>(
      `INSERT INTO demo_tenants(id,telegram_id) VALUES($1,$2)
      ON CONFLICT(telegram_id) DO UPDATE SET telegram_id=EXCLUDED.telegram_id RETURNING *`,
      [randomUUID(), telegramId],
    );
    return this.tenant(row!.id);
  }
  async enqueue(
    id: string,
    tenantId: string,
    kind: Job["kind"],
    payload: unknown,
  ): Promise<boolean> {
    const inserted = await this.db.query(
      `INSERT INTO demo_jobs(id,tenant_id,kind,payload) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO NOTHING RETURNING id`,
      [id, tenantId, kind, this.vault.seal(payload, id)],
    );
    return inserted.length > 0;
  }
  async ticket(
    tenantId: string,
    kind: string,
    payload: unknown = null,
    raw = randomToken(),
  ): Promise<string> {
    await this.db.query(
      `INSERT INTO demo_tickets(hash,tenant_id,kind,payload,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '10 minutes')`,
      [digest(raw), tenantId, kind, this.vault.seal(payload, digest(raw))],
    );
    return raw;
  }
  async consume(raw: string, kind: string): Promise<Ticket | undefined> {
    const [row] = await this.db.query<Ticket>(
      `UPDATE demo_tickets SET consumed_at=now()
      WHERE hash=$1 AND kind=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING tenant_id,payload`,
      [digest(raw), kind],
    );
    return row;
  }
  async consumeWithJobs(
    raw: string,
    kind: string,
    jobs: Array<{ id: string; kind: Job["kind"]; payload: unknown }>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const scoped = new Store(tx, this.vault);
      const ticket = await scoped.consume(raw, kind);
      if (!ticket) { return false; }
      const tenant = await scoped.tenant(ticket.tenant_id);
      for (const job of jobs) {
        await scoped.enqueue(job.id, tenant.id, job.kind, job.payload);
      }
      return true;
    });
  }
  async peek(raw: string, kind: string): Promise<Ticket | undefined> {
    const [row] = await this.db.query<Ticket>(
      `SELECT tenant_id,payload FROM demo_tickets
      WHERE hash=$1 AND kind=$2 AND consumed_at IS NULL AND expires_at>now()`,
      [digest(raw), kind],
    );
    return row;
  }
  async claim(kind?: Job["kind"]): Promise<Job | undefined> {
    return this.db.transaction(async (tx) => {
      const [lock] = await tx.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(7812394) AS locked",
      );
      if (!lock?.locked) {
        return undefined;
      }
      const [job] = await tx.query<Job>(
        `UPDATE demo_jobs SET status='running', attempts=attempts+1,
        lease_until=now()+interval '6 minutes', lease_token=$1 WHERE id=(
        SELECT candidate.id FROM demo_jobs candidate
        WHERE ((candidate.status='pending' AND candidate.available_at<=now())
          OR (candidate.status='running' AND candidate.lease_until<=now()))
        AND ($2::text IS NULL OR candidate.kind=$2)
        AND (candidate.kind='oauth_notice' OR NOT EXISTS (
          SELECT 1 FROM demo_jobs earlier
          WHERE earlier.tenant_id=candidate.tenant_id
          AND earlier.kind<>'oauth_notice'
          AND earlier.status IN ('pending','running')
          AND (earlier.created_at, earlier.id)<(candidate.created_at, candidate.id)
        ))
        AND NOT EXISTS (
          SELECT 1 FROM demo_jobs busy
          WHERE busy.status='running' AND busy.lease_until>now()
          AND ((busy.tenant_id=candidate.tenant_id
              AND (candidate.kind<>'oauth_notice' OR busy.kind='oauth_notice'))
            OR (busy.kind='provision' AND candidate.kind='provision'))
        )
        ORDER BY candidate.created_at, candidate.id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`,
        [randomToken(), kind ?? null],
      );
      return job;
    });
  }
  async finish(job: Job, failed = false): Promise<void> {
    await this.db.query(
      `UPDATE demo_jobs SET status=$3,lease_until=NULL,lease_token=NULL,
      available_at=now()+($4 * interval '1 second'),last_error=$5,
      payload=CASE WHEN $3='done' THEN '' ELSE payload END
      WHERE id=$1 AND lease_token=$2`,
      [
        job.id,
        job.lease_token,
        failed ? (job.attempts >= 8 ? "failed" : "pending") : "done",
        Math.min(300, 2 ** job.attempts * 5),
        failed
          ? "Upstream operation failed; retry or inspect provider status"
          : null,
      ],
    );
  }
  async approve(tenantId: string, email: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      email = email.trim().toLowerCase();
      await tx.query("SELECT pg_advisory_xact_lock(7812395)");
      const [tenant] = await tx.query<Tenant>(
        "SELECT * FROM demo_tenants WHERE id=$1 FOR UPDATE",
        [tenantId],
      );
      if (!tenant || tenant.status !== "pending" || tenant.merged_into) {
        return;
      }
      const [owner] = await tx.query<Tenant>("SELECT * FROM demo_tenants WHERE lower(email)=$1 AND id<>$2 AND merged_into IS NULL", [email, tenantId]);
      if (owner) {
        await tx.query("UPDATE demo_tenants SET merged_into=$2 WHERE id=$1", [tenantId, owner.id]);
        return;
      }
      await tx.query(
        "UPDATE demo_tenants SET email=$2,status='provisioning' WHERE id=$1",
        [tenantId, email],
      );
      const id = `provision:${tenantId}`;
      await tx.query(
        `INSERT INTO demo_jobs(id,tenant_id,kind,payload) VALUES($1,$2,'provision',$3)
        ON CONFLICT(id) DO NOTHING`,
        [id, tenantId, this.vault.seal({}, id)],
      );
    });
  }
}
