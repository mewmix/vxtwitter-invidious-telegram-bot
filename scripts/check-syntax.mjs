import { spawnSync } from "node:child_process";
for (const path of ["src/core.mjs", "src/beacon.mjs", "scripts/verify-roll.mjs",
  "scripts/set-webhook.mjs", "test/core.test.mjs", "test/bls.test.mjs", "test/worker.test.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
