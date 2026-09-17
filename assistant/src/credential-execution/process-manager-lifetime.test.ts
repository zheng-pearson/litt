import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

import { assertNotLiveDb } from "../__tests__/assert-not-live-db.js";

test("an idle lazy CES socket permits exit after a delayed handshake completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ces-lifetime-"));
  const socketPath = join(dir, "ces.sock");
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) {
        return;
      }
      const request = JSON.parse(buffer.trim());
      buffer = "";
      setTimeout(() => {
        socket.write(
          JSON.stringify({
            type: "handshake_ack",
            protocolVersion: request.protocolVersion,
            sessionId: request.sessionId,
            accepted: true,
          }) + "\n",
        );
      }, 50);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const manager = fileURLToPath(
    new URL("./process-manager.ts", import.meta.url),
  );
  const client = fileURLToPath(new URL("./client.ts", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { createCesProcessManager } = await import(${JSON.stringify(manager)});
    const { createCesClient } = await import(${JSON.stringify(client)});
    const pm = createCesProcessManager({ keepAlive: false });
    const transport = await pm.start();
    const rpc = createCesClient(transport);
    const result = await rpc.handshake();
    console.log(result.accepted ? "HANDSHAKE_COMPLETED" : "FAILED");
  `,
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        CES_LOCAL_SOCKET: socketPath,
        IS_CONTAINERIZED: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 3000);
  try {
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(output).toContain("HANDSHAKE_COMPLETED");
    expect(timedOut).toBe(false);
    expect(code).toBe(0);
  } finally {
    clearTimeout(timer);
    child.kill();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assertNotLiveDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
