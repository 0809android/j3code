import * as NodeCrypto from "node:crypto";

import { base64url } from "./bytes.ts";
import { loadConfig } from "./config.ts";
import { RelayStore } from "./store.ts";

const DAY_MS = 86_400_000;
const [command] = process.argv.slice(2);

if (command !== "invite") {
  process.stderr.write("usage: node src/cli.ts invite\n");
  process.exit(2);
}

const config = loadConfig(process.env);
const store = new RelayStore(config.dbPath);
const code = base64url(NodeCrypto.randomBytes(16));
store.addInvite(
  NodeCrypto.createHash("sha256").update(code).digest(),
  Date.now() + config.inviteTtlDays * DAY_MS,
);
store.close();
process.stdout.write(`${code}\n`);
