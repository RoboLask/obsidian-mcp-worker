#!/usr/bin/env node
/**
 * First-time deploy of obsidian-mcp to Cloudflare Workers.
 *
 * Works on Windows, macOS and Linux. Requires only Node.js — which you already
 * have, since you ran `npm install`.
 *
 * Usage:  npm run setup
 *     or  node setup.js
 *
 * Secrets are piped to wrangler through stdin and never printed.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const cwd = process.cwd();
// On Windows npx is npx.cmd, which needs the shell; the name itself is the same.
const npx = "npx";

/**
 * Run a command.
 *
 * On Windows npx is npx.cmd, which Node can only start through a shell, and
 * passing an args array with shell: true triggers a deprecation warning. So the
 * command is built as a single string there.
 *
 * Every argument is a literal written in this file; user input is never put on
 * the command line (secrets go through stdin), so there is no injection risk.
 */
function run(args, { input, quiet = false } = {}) {
  const command = [npx, ...args].join(" ");
  return spawnSync(command, {
    cwd,
    input,
    stdio: quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"],
    encoding: "utf8",
    shell: true,
  });
}

/** Read a value from .dev.vars when the file exists. */
function fromDevVars(key) {
  if (!existsSync(".dev.vars")) return "";
  const line = readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

/** Prompt for a line of input in the terminal. */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (hidden) {
      // Mask input by erasing every character readline echoes.
      const onData = (char) => {
        if (["\n", "\r", "\u0004"].includes(char)) return;
        process.stdout.write("\b \b");
      };
      process.stdin.on("data", onData);
      rl.question(question, (answer) => {
        process.stdin.off("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolve(answer.trim());
      });
      return;
    }

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function main() {
  console.log("\n=== Obsidian MCP — setup ===\n");

  // ------------------------------------------------------------------ 1. login
  const who = run(["wrangler", "whoami"], { quiet: true });
  const whoOut = `${who.stdout ?? ""}${who.stderr ?? ""}`;
  if (!/logged in|Account ID/i.test(whoOut)) {
    fail(
      "You are not logged in to Cloudflare.\n" +
        "  Run: npx wrangler login\n" +
        "  then start setup again.",
    );
  }
  console.log("✔ Cloudflare: logged in");

  // ------------------------------------------------ 2. check configuration
  const toml = readFileSync("wrangler.toml", "utf8");
  if (toml.includes("REPLACE_WITH_YOUR_")) {
    console.warn(
      "\n⚠ wrangler.toml still contains KV placeholders.\n" +
        "  Run these two commands first and paste the returned ids:\n" +
        "    npx wrangler kv namespace create MCP_COUNTER\n" +
        "    npx wrangler kv namespace create OAUTH_KV\n",
    );
  }
  if (toml.includes("obsidian-mcp.example.workers.dev")) {
    console.warn(
      "⚠ BASE_URL in src/index.ts is still the example value. If your address\n" +
        "  differs, change it, otherwise OAuth metadata points elsewhere.\n",
    );
  }

  // ------------------------------------------------------------------ 3. inputs
  let email = fromDevVars("KOOFR_EMAIL");
  let pass = fromDevVars("KOOFR_APP_PASSWORD");
  let owner = fromDevVars("OWNER_PASSWORD") || fromDevVars("PASSWORD");

  if (!email) email = await ask("WebDAV / Koofr email: ");
  if (!pass) pass = await ask("WebDAV / Koofr app password (hidden): ", { hidden: true });

  if (!email || !pass) fail("Both email and app password are required. Stopped.");

  if (!owner) {
    owner = randomBytes(9).toString("base64url");
    console.log(`\n✔ Owner password generated: ${owner}`);
    console.log("  Save it — you need it to connect a client.\n");
  }

  // ----------------------------------------------------------------- 4. secrets
  const secrets = [
    ["KOOFR_EMAIL", email],
    ["KOOFR_APP_PASSWORD", pass],
    ["OWNER_PASSWORD", owner],
  ];

  for (const [name, value] of secrets) {
    console.log(`→ secret ${name}`);
    const res = run(["wrangler", "secret", "put", name], { input: value });
    if (res.status !== 0) fail(`Could not set secret ${name}`);
  }

  // ------------------------------------------------------------------ 5. deploy
  console.log("\n→ deploying…\n");
  const deploy = spawnSync(`${npx} wrangler deploy`, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: true,
  });
  const out = deploy.stdout ?? "";
  process.stdout.write(out);

  if (deploy.status !== 0) fail("Deploy failed, see the output above.");

  const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];

  console.log("\n===================================================");
  if (url) {
    console.log(`Deployed:       ${url}`);
    console.log(`Connector URL:  ${url}/mcp`);
  } else {
    console.log("Connector URL:  https://<your-worker>.workers.dev/mcp");
  }
  console.log(`Owner password: ${owner}`);
  console.log("===================================================");
  console.log("\nIn Claude: Settings -> Connectors -> Add custom connector");
  console.log("  Authentication: OAuth (leave the default)\n");
  console.log("Reminder: VAULT_PATH in wrangler.toml must point to the folder holding");
  console.log("your vault inside WebDAV (where .obsidian/ lives).");
  console.log("Use the ping tool to verify the path.\n");
}

main().catch((e) => fail(e?.message ?? String(e)));
