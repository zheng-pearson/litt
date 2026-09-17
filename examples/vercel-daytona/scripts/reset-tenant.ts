import { Daytona, DaytonaNotFoundError } from "@daytona/sdk";
import postgres from "postgres";
import { z } from "zod";

const argsSchema = z.object({
  telegramId: z.string().regex(/^\d+$/),
  approved: z.boolean(),
  includeLinked: z.boolean(),
});

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DAYTONA_API_KEY: z.string().min(1),
  DAYTONA_TARGET: z.string().min(1).default("us"),
});

type ResetArgs = z.infer<typeof argsSchema>;
type TenantRow = {
  id: string;
  telegram_id: string;
  merged_into: string | null;
  sandbox_id: string | null;
};

const usage = `Usage: bun scripts/reset-tenant.ts --telegram-id <id> [--include-linked] [--yes]

The command is a dry run unless --yes is present. It retires the hosted
assistant, then removes only the matching demo tenant's local onboarding,
queue, and tenant records. It does not modify mailbox or calendar data.`;

export function parseResetArgs(argv: string[]): ResetArgs {
  let telegramId: string | undefined;
  let approved = false;
  let includeLinked = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--telegram-id") {
      telegramId = argv[index + 1];
      index += 1;
    } else if (argument === "--yes") {
      approved = true;
    } else if (argument === "--include-linked") {
      includeLinked = true;
    } else if (argument === "--help" || argument === "-h") {
      throw new Error(usage);
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}\n\n${usage}`);
    }
  }

  const parsed = argsSchema.safeParse({ telegramId, approved, includeLinked });
  if (!parsed.success) {
    throw new Error(`A numeric --telegram-id is required.\n\n${usage}`);
  }
  return parsed.data;
}

function sameValues(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

async function retireAssistant(
  daytona: Daytona,
  sandboxId: string,
): Promise<"retired" | "missing"> {
  let sandbox;
  try {
    sandbox = await daytona.get(sandboxId);
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) {
      return "missing";
    }
    throw error;
  }

  if (sandbox.state !== "started") {
    await sandbox.start(70);
  }
  const result = await sandbox.process.executeCommand(
    "bun cli/src/index.ts retire hosted-demo --source hosted-demo-reset --yes",
    "/opt/vellum",
    { VELLUM_ENVIRONMENT: "local" },
    240,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Assistant retirement failed in sandbox ${sandboxId}: ${result.result.trim()}`,
    );
  }
  return "retired";
}

async function main(): Promise<void> {
  const args = parseResetArgs(process.argv.slice(2));
  const env = envSchema.parse(process.env);
  const sql = postgres(env.DATABASE_URL, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    const [requested] = await sql<TenantRow[]>`
      SELECT id, telegram_id, merged_into, sandbox_id
      FROM demo_tenants
      WHERE telegram_id = ${args.telegramId}
    `;
    if (!requested) {
      throw new Error("No hosted demo tenant exists for that Telegram ID.");
    }

    const canonicalId = requested.merged_into ?? requested.id;
    const tenants = await sql<TenantRow[]>`
      SELECT id, telegram_id, merged_into, sandbox_id
      FROM demo_tenants
      WHERE id = ${canonicalId} OR merged_into = ${canonicalId}
      ORDER BY created_at
    `;
    if (tenants.length > 1 && !args.includeLinked) {
      throw new Error(
        `This identity has ${tenants.length} linked tenant records. Re-run with --include-linked to reset the whole identity group.`,
      );
    }

    const tenantIds = tenants.map((tenant) => tenant.id);
    const sandboxIds = [
      ...new Set(
        tenants
          .map((tenant) => tenant.sandbox_id)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    console.log(
      JSON.stringify(
        {
          mode: args.approved ? "approved" : "dry-run",
          tenantRecords: tenantIds.length,
          sandboxes: sandboxIds.length,
          preservesExternalMailboxAndCalendar: true,
        },
        null,
        2,
      ),
    );

    if (!args.approved) {
      console.log("Nothing changed. Re-run with --yes to perform this reset.");
      return;
    }

    const daytona = new Daytona({
      apiKey: env.DAYTONA_API_KEY,
      target: env.DAYTONA_TARGET,
    });
    for (const sandboxId of sandboxIds) {
      const status = await retireAssistant(daytona, sandboxId);
      console.log(`Sandbox ${sandboxId}: assistant ${status}.`);
    }

    await sql.begin(async (tx) => {
      const locked = await tx<TenantRow[]>`
        SELECT id, telegram_id, merged_into, sandbox_id
        FROM demo_tenants
        WHERE id = ${canonicalId} OR merged_into = ${canonicalId}
        ORDER BY created_at
        FOR UPDATE
      `;
      const lockedIds = locked.map((tenant) => tenant.id);
      const lockedSandboxIds = [
        ...new Set(
          locked
            .map((tenant) => tenant.sandbox_id)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      if (
        !sameValues(tenantIds, lockedIds) ||
        !sameValues(sandboxIds, lockedSandboxIds)
      ) {
        throw new Error(
          "Tenant state changed during the reset. Database records were preserved.",
        );
      }

      await tx`DELETE FROM demo_jobs WHERE tenant_id IN ${tx(tenantIds)}`;
      await tx`DELETE FROM demo_tickets WHERE tenant_id IN ${tx(tenantIds)}`;
      await tx`DELETE FROM demo_mini_sessions WHERE tenant_id IN ${tx(tenantIds)}`;
      await tx`
        DELETE FROM demo_tenants
        WHERE id IN ${tx(tenantIds)} AND merged_into IS NOT NULL
      `;
      await tx`DELETE FROM demo_tenants WHERE id = ${canonicalId}`;
    });

    console.log(
      "Reset complete. The next Telegram message will enter new-user onboarding.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    let message = error instanceof Error ? error.message : "Reset failed";
    for (const secret of [
      process.env.DATABASE_URL,
      process.env.DAYTONA_API_KEY,
    ]) {
      if (secret) {
        message = message.replaceAll(secret, "[redacted]");
      }
    }
    console.error(message);
    process.exitCode = 1;
  });
}
