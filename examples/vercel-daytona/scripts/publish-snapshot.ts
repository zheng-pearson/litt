import { Daytona, Image } from "@daytona/sdk";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--approved-deployment")) {
  throw new Error(
    "Publishing requires explicit deployment consent. Pass --approved-deployment only after obtaining it.",
  );
}
if (!process.env.DAYTONA_API_KEY || !process.env.DAYTONA_SNAPSHOT) {
  throw new Error(
    "Set DAYTONA_API_KEY and DAYTONA_SNAPSHOT outside the repository",
  );
}
const dockerfile = fileURLToPath(
  new URL("../artifacts/snapshot/Dockerfile", import.meta.url),
);
const daytona = new Daytona();
try {
  await daytona.snapshot.create(
    {
      name: process.env.DAYTONA_SNAPSHOT,
      image: Image.fromDockerfile(dockerfile),
      resources: { cpu: 2, memory: 8, disk: 10 },
    },
    { timeout: 1200 },
  );
  console.log("Demo snapshot published");
} catch (error) {
  const failure = error as {
    message?: string;
    statusCode?: number;
    status?: number;
  };
  const message = (failure.message ?? "Snapshot build failed").replaceAll(
    process.env.DAYTONA_API_KEY,
    "[redacted]",
  );
  console.error(
    JSON.stringify({
      error: message,
      status: failure.statusCode ?? failure.status,
    }),
  );
  process.exitCode = 1;
}
