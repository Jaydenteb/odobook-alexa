// Runs the e2e suite against the live Worker, reading REMOTE_ADMIN_TOKEN from .dev.vars so the
// token never has to be typed or shown on screen.
import { readFileSync } from "node:fs";

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);
if (!vars.REMOTE_ADMIN_TOKEN) {
  console.error("REMOTE_ADMIN_TOKEN is missing from .dev.vars");
  process.exit(1);
}
process.env.BASE ??= "https://odobook-alexa.odobook-alexa.workers.dev";
process.env.ADMIN_TOKEN = vars.REMOTE_ADMIN_TOKEN;
await import("./e2e.mjs");
