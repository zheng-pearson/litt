import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const project = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(project, "../..");
const out = resolve(project, "artifacts/snapshot");
await mkdir(out, { recursive: true });
function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error("Unable to prepare committed source archive");
  }
  return result.stdout.toString().trim();
}
const commit = git(["rev-parse", "HEAD"]);
git(["archive", "--format=tar", `--output=${out}/source.tar`, commit]);
const manager = git([
  "show",
  `${commit}:gateway/src/telegram/webhook-manager.ts`,
]);
if (!manager.includes("webhookManaged")) {
  throw new Error("Source commit lacks the shared Telegram webhook guard");
}
await copyFile(
  resolve(project, "sandbox/Dockerfile"),
  resolve(out, "Dockerfile"),
);
await copyFile(
  resolve(project, "sandbox/bootstrap.ts"),
  resolve(out, "bootstrap.ts"),
);
const hash = createHash("sha256");
for (const name of ["source.tar", "Dockerfile", "bootstrap.ts"]) {
  hash.update(
    await Bun.file(resolve(out, name))
      .arrayBuffer()
      .then((v) => Buffer.from(v)),
  );
}
await writeFile(
  resolve(out, "manifest.json"),
  JSON.stringify({ sourceCommit: commit, sha256: hash.digest("hex") }, null, 2),
);
console.log(
  `Local snapshot context prepared at ${out}. Nothing uploaded or deployed.`,
);
