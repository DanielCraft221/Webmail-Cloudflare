import { Hono } from "hono";
import { handleEmail } from "./email";
import { handleQueue, type IngestJob } from "./ingest";

// No HTTP API in Etapa 2: with no routes, Hono answers 404 to every request.
const app = new Hono();

export default {
  fetch: app.fetch,
  email: handleEmail,
  queue: handleQueue,
} satisfies ExportedHandler<Env, IngestJob>;
