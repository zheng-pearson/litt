import { service } from "./service.js";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3100),
  fetch: service((work) => {
    void work.catch(() =>
      console.error("Demo worker interrupted; invoke /jobs/drain to retry"),
    );
  }),
});
console.log(`Demo control service: ${server.url}`);
