import * as NodeCrypto from "node:crypto";

import { base64url } from "./bytes.ts";
import { loadConfig, type RelayEnv } from "./config.ts";
import { isId } from "./crypto.ts";
import { RelayStore } from "./store.ts";

const DAY_MS = 86_400_000;

export interface AdminIo {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `usage:
  node src/cli.ts invite              make a registration code (REQUIRE_INVITE=1 relays)
  node src/cli.ts block <hostId>      cut a host off: control and data closed, new connections refused
  node src/cli.ts unblock <hostId>    lift the block
  node src/cli.ts blocked             list blocked hosts
`;

/** The operator's commands. They act on the database, a running relay notices within seconds. */
export function runAdmin(
  argv: ReadonlyArray<string>,
  io: AdminIo,
  env: RelayEnv,
  now: () => number = () => Date.now(),
): number {
  const [command, argument] = argv;
  if (command === "block" || command === "unblock") {
    if (!isId(argument)) {
      io.err(`${command} needs a host id (32 characters, a-z and 2-7)\n`);
      return 2;
    }
    return withStore(env, (store) => {
      if (command === "block") {
        io.out(
          store.blockHost(argument, now())
            ? `blocked ${argument}\nA running relay cuts the host off within a few seconds.\n`
            : `${argument} was already blocked\n`,
        );
        return 0;
      }
      if (store.unblockHost(argument)) {
        io.out(`unblocked ${argument}\n`);
        return 0;
      }
      io.err(`${argument} was not blocked\n`);
      return 1;
    });
  }
  if (command === "blocked") {
    return withStore(env, (store) => {
      for (const hostId of store.blockedHosts()) io.out(`${hostId}\n`);
      return 0;
    });
  }
  if (command === "invite") {
    const config = loadConfig(env);
    return withStore(env, (store) => {
      const code = base64url(NodeCrypto.randomBytes(16));
      store.addInvite(
        NodeCrypto.createHash("sha256").update(code).digest(),
        now() + config.inviteTtlDays * DAY_MS,
      );
      io.out(`${code}\n`);
      return 0;
    });
  }
  io.err(USAGE);
  return 2;
}

function withStore(env: RelayEnv, work: (store: RelayStore) => number): number {
  const store = new RelayStore(loadConfig(env).dbPath);
  try {
    return work(store);
  } finally {
    store.close();
  }
}
