import { loadConfig } from "./config.ts";
import { createRelay, stdoutLogger } from "./server.ts";

const config = loadConfig(process.env);
const relay = createRelay({ config, logger: stdoutLogger });

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  relay.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await relay.listen();
