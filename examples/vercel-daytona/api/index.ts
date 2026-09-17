import { waitUntil } from "@vercel/functions";
import { service } from "../src/service.js";

let handler: ReturnType<typeof service> | undefined;
export default {
  fetch(request: Request) {
    handler ??= service((work) =>
      waitUntil(
        work.catch(() =>
          console.error("Demo worker interrupted; durable jobs will retry"),
        ),
      ),
    );
    return handler(request);
  },
};
