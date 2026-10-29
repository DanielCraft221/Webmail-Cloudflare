import { remoteAccessKeys } from "./access";
import { createApi } from "./api";
import { handleEmail } from "./email";
import { handleQueue, type IngestJob } from "./ingest";

// The only place the Access key source is chosen: always the real certs endpoint.
const app = createApi(remoteAccessKeys);

export default {
  fetch: app.fetch,
  email: handleEmail,
  queue: handleQueue,
} satisfies ExportedHandler<Env, IngestJob>;
