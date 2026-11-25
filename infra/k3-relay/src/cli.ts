import { runAdmin } from "./admin.ts";

process.exitCode = runAdmin(
  process.argv.slice(2),
  {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
  process.env,
);
