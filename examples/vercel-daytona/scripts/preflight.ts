import { readConfig } from "../src/config.js";

try {
  const config = readConfig();
  console.log(
    `Configuration complete for ${config.PUBLIC_BASE_URL}. No resources created.`,
  );
  console.log(
    `Snapshot: ${config.DAYTONA_SNAPSHOT}; Daytona region: ${config.DAYTONA_TARGET}`,
  );
  console.log("Google redirect URIs:");
  console.log(`${config.PUBLIC_BASE_URL}/auth/google/callback`);
  console.log(`${config.PUBLIC_BASE_URL}/webhooks/oauth/callback`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Configuration incomplete",
  );
  process.exitCode = 1;
}
