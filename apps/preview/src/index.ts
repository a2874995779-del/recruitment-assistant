import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  runtimeDirectory,
  apiToken,
} from "../../../packages/persistence/src/runtime.js";
import { claimInstance } from "../../../packages/persistence/src/instance.js";
import { Store } from "../../../packages/persistence/src/database.js";
import { RecruitmentService } from "../../../packages/application/src/service.js";
import { Scheduler } from "../../../packages/scheduler/src/index.js";
import { createServer } from "../../api/src/server.js";
// Separate data avoids conflicts with the Electron app or regular API service.
const port = Number(process.env.RA_PORT ?? process.argv[2] ?? 4319);
process.env.RA_DATA_DIR ??= join(
  process.env.LOCALAPPDATA ?? process.cwd(),
  port === 4319
    ? "RecruitmentAssistantPreview"
    : `RecruitmentAssistantPreview-${port}`,
);
const directory = runtimeDirectory(),
  release = claimInstance(directory),
  store = new Store(join(directory, "database", "app.sqlite"));
const service = new RecruitmentService(store, directory),
  scheduler = new Scheduler(service);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("RA_PORT 不合法");
const origin = `http://127.0.0.1:${port}`,
  renderer = fileURLToPath(new URL("../../../dist/renderer/", import.meta.url));
const server = createServer(service, scheduler, apiToken(directory), {
  origin,
  directory: renderer,
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await scheduler.stop();
  await server.close();
  store.close();
  release();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
try {
  await server.listen({ host: "127.0.0.1", port });
  scheduler.start();
  console.log(`本地预览：${origin}/preview/\n独立数据目录：${directory}`);
} catch (error) {
  await close();
  throw error;
}
