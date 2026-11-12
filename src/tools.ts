import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { KoofrWebDAV } from "./koofr";
import {
  dateInTz,
  frontmatter,
  parseTags,
  safeFileName,
  stripFrontmatter,
} from "./markdown";
import { formatTasks, openTasks, parseTasks, type Task } from "./tasks";

export interface Env {
  KOOFR_EMAIL: string;
  KOOFR_APP_PASSWORD: string;
  MCP_AUTH_TOKEN: string;
  VAULT_PATH: string;
  DEFAULT_TZ: string;
  DAILY_WRITE_LIMIT?: string;
  /** KV for the daily write counter. Optional: without it the limit is off. */
  MCP_COUNTER?: KVNamespace;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Joins "Inbox/Notes" with vaultPath -> "Obsidian/Inbox/Notes" */
function joinPath(vault: string, folder: string | undefined, file: string): string {
  const parts = [vault, folder ?? "", file]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return parts.join("/");
}

function getDav(env: Env): KoofrWebDAV {
  if (!env.KOOFR_EMAIL || !env.KOOFR_APP_PASSWORD) {
    throw new Error("Secrets KOOFR_EMAIL / KOOFR_APP_PASSWORD are not configured");
  }
  return new KoofrWebDAV({ email: env.KOOFR_EMAIL, password: env.KOOFR_APP_PASSWORD });
}

/**
 * Daily write limit. Protects the vault from a runaway agent or a stolen
 * token: even with a valid token, no more than N writes per day.
 *
 * The counter lives in KV, keyed by date, so it resets every day.
 * If KV is not bound, the limit is off: this is logged but writes still pass.
 */
async function consumeWrite(env: Env, tz: string): Promise<void> {
  const limit = Number(env.DAILY_WRITE_LIMIT ?? "0");
  if (!limit || !env.MCP_COUNTER) return;

  const { date } = dateInTz(tz);
  const key = `writes:${date}`;

  const used = Number((await env.MCP_COUNTER.get(key)) ?? "0");
  if (used >= limit) {
    throw new Error(
      `Daily write limit reached (${used}/${limit} on ${date}). ` +
        `New notes will be available tomorrow. Counter: ${key}`,
    );
  }

  // 2-day TTL so keys do not pile up
  await env.MCP_COUNTER.put(key, String(used + 1), { expirationTtl: 172800 });
}

/** Server factory: a fresh instance per request (stateless). */
export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "obsidian-koofr", version: "1.0.0" });
  const tz = env.DEFAULT_TZ || "Europe/Warsaw";
  const vault = env.VAULT_PATH || "/Obsidian";

  // ---------------------------------------------------------------- create_note
  server.registerTool(
    "create_note",
    {
      description:
        "Create a new note in Obsidian (via Koofr WebDAV). Returns the file path. " +
        "If a file with that name exists, it suffixes the name instead of overwriting.",
      inputSchema: {
        title: z.string().min(1).describe("Note title. Becomes the .md file name"),
        content: z.string().default("").describe("Note body in Markdown"),
        folder: z
          .string()
          .optional()
          .describe("Subfolder inside the vault, e.g. 'Inbox' or 'Daily/2025'. Root by default"),
        tags: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Tags: 'idea, project' or ['idea']"),
        dedupe: z
          .boolean()
          .default(true)
          .describe("true appends -2, -3 on a name clash; false overwrites"),
      },
    },
    async ({ title, content, folder, tags, dedupe }) => {
      const dav = getDav(env);
      const when = dateInTz(tz);
      const base = safeFileName(title);
      const dir = joinPath(vault, folder, "").replace(/\/+$/, "");

      let name = base;
      let path = joinPath(vault, folder, `${name}.md`);
      if (dedupe) {
        let i = 1;
        while (await dav.exists(path)) {
          i += 1;
          name = `${base} ${i}`;
          path = joinPath(vault, folder, `${name}.md`);
          if (i > 999) throw new Error("Too many notes with the same name");
        }
      }

      await dav.ensureDir(dir);
      const body =
        frontmatter({ title: name, tags: parseTags(tags), when, folderHint: folder }) +
        stripFrontmatter(content || "");

      await dav.writeFile(path, body);
      return text(`Note created: ${path}\n[[${name}]]`);
    },
  );

  // ---------------------------------------------------------------- append_note
  server.registerTool(
    "append_note",
    {
      description:
        "Append text to the end of an existing note. Useful for daily and project notes.",
      inputSchema: {
        path: z.string().min(1).describe("Note path relative to the vault, e.g. 'Inbox/X.md'"),
        content: z.string().min(1).describe("Text to append (Markdown)"),
        separator: z.string().default("\n\n").describe("Separator before the text"),
      },
    },
    async ({ path, content, separator }) => {
      const dav = getDav(env);
      const full = joinPath(vault, path, "").replace(/\/+$/, "");
      const existing = await dav.readFile(full);
      if (existing === undefined) {
        throw new Error(
          `Note not found: ${full}. Use create_note to create it.`,
        );
      }
      await dav.writeFile(full, existing.replace(/\s*$/, "") + separator + content.trim() + "\n");
      return text(`Appended to ${full} (+${content.length} characters)`);
    },
  );

  // ---------------------------------------------------------------- read_note
  server.registerTool(
    "read_note",
    {
      description: "Read a whole note (or find it by query in search_notes).",
      inputSchema: {
        path: z.string().min(1).describe("Note path relative to the vault"),
        maxChars: z.number().int().min(500).max(100_000).default(20_000),
      },
    },
    async ({ path, maxChars }) => {
      const dav = getDav(env);
      const full = joinPath(vault, path, "").replace(/\/+$/, "");
      const data = await dav.readFile(full);
      if (data === undefined) return text(`Not found: ${full}`);
      const truncated = data.length > maxChars;
      return text(truncated ? data.slice(0, maxChars) + "\n\n…truncated" : data);
    },
  );

  // ---------------------------------------------------------------- search_notes
  server.registerTool(
    "search_notes",
    {
      description:
        "Find notes by file name and/or text inside. Walks the vault recursively. " +
        "Returns the path and a snippet. Not a replacement for Obsidian search, but works from chat.",
      inputSchema: {
        query: z.string().min(1).describe("Search string (case-insensitive)"),
        folder: z.string().optional().describe("Limit the search to a subfolder"),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, folder, limit }) => {
      const dav = getDav(env);
      const rootDir = joinPath(vault, folder, "").replace(/\/+$/, "");
      const needle = query.toLowerCase();
      const hits: string[] = [];

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (hits.length >= limit || depth > 6) return;
        const entries = await dav.list(dir);
        for (const e of entries) {
          if (hits.length >= limit) return;
          if (e.isDir) {
            await walk(e.path, depth + 1);
            continue;
          }
          if (!/\.(md|markdown|txt|canvas)$/i.test(e.path)) continue;

          const nameHit = e.path.toLowerCase().includes(needle);
          const body = await dav.readFile(e.path);
          if (body === undefined) continue;

          const idx = body.toLowerCase().indexOf(needle);
          if (nameHit || idx >= 0) {
            const rel = folder ? e.path.replace(new RegExp(`^${rootDir}/?`), "") : e.path;
            const snippet =
              idx >= 0
                ? body
                    .slice(Math.max(0, idx - 80), idx + 120)
                    .replace(/\s+/g, " ")
                    .trim()
                : "(file name match)";
            hits.push(`• ${rel}\n  ${snippet}`);
          }
        }
      };

      await walk(rootDir, 0);
      if (!hits.length) return text(`Nothing found for "${query}"`);
      return text(`Found ${hits.length}:\n\n` + hits.join("\n"));
    },
  );

  // ---------------------------------------------------------------- list_notes
  server.registerTool(
    "list_notes",
    {
      description: "List the contents of a vault folder (non-recursive).",
      inputSchema: {
        folder: z.string().optional().describe("Subfolder inside the vault. Empty = root"),
      },
    },
    async ({ folder }) => {
      const dav = getDav(env);
      const dir = joinPath(vault, folder, "").replace(/\/+$/, "");
      const entries = await dav.list(dir);
      if (!entries.length) return text(`Folder is empty or does not exist: ${dir}`);
      const lines = entries.map((e) => `${e.isDir ? "📁" : "📄"} ${e.path}`);
      return text(`Contents of ${dir} (${entries.length}):\n\n` + lines.join("\n"));
    },
  );

  // ---------------------------------------------------------------- daily_note
  server.registerTool(
    "daily_note",
    {
      description:
        "Append to the daily note (Daily/YYYY-MM-DD.md), creating it when missing. " +
        "Handy for 'write this thought into today'.",
      inputSchema: {
        content: z.string().min(1).describe("Markdown to append"),
        dailyFolder: z.string().default("Daily").describe("Daily notes folder"),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("YYYY-MM-DD; today by default"),
      },
    },
    async ({ content, dailyFolder, date }) => {
      const dav = getDav(env);
      const when = dateInTz(tz);
      const day = date ?? when.date;
      const path = joinPath(vault, dailyFolder, `${day}.md`);

      await dav.ensureDir(joinPath(vault, dailyFolder, "").replace(/\/+$/, ""));
      const existing = await dav.readFile(path);

      if (existing === undefined) {
        const header =
          `## Notes\n\n`;
        await dav.writeFile(path, header + content.trim() + "\n");
        return text(`Daily note created: ${path}`);
      }
      await dav.writeFile(path, existing.replace(/\s*$/, "") + "\n\n" + content.trim() + "\n");
      return text(`Appended to ${path}`);
    },
  );

  // ---------------------------------------------------------------- today_tasks
  server.registerTool(
    "today_tasks",
    {
      description:
        "Show open tasks for today or the week. Reads the daily note Daily/YYYY-MM-DD.md " +
        "and, optionally, collects every open '- [ ]' across the whole vault. " +
        "Answers questions such as 'what are my tasks today'.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Daily note date YYYY-MM-DD; today by default"),
        dailyFolder: z.string().default("Daily").describe("Daily notes folder"),
        includeVault: z
          .boolean()
          .default(false)
          .describe("true adds open tasks from every note in the vault, not just the daily one"),
        maxFiles: z.number().int().min(1).max(200).default(40),
      },
    },
    async ({ date, dailyFolder, includeVault, maxFiles }) => {
      const dav = getDav(env);
      const when = dateInTz(tz);
      const day = date ?? when.date;
      const dailyPath = joinPath(vault, dailyFolder, `${day}.md`);

      const blocks: string[] = [];

      const dailyMd = await dav.readFile(dailyPath);
      if (dailyMd === undefined) {
        blocks.push(`No daily note for ${day} (${dailyPath}).`);
      } else {
        const tasks = parseTasks(dailyMd, dailyPath);
        const open = openTasks(tasks);
        const done = tasks.length - open.length;
        blocks.push(
          `**Tasks for ${day}** (${open.length} open, ${done} done)\n\n` +
            (open.length ? formatTasks(open, { showPath: false }) : "All tasks done ✅"),
        );
      }

      if (includeVault) {
        const collected: Task[] = [];
        let scanned = 0;
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (depth > 5 || scanned >= maxFiles) return;
          const entries = await dav.list(dir);
          for (const e of entries) {
            if (scanned >= maxFiles) return;
            if (e.isDir) {
              if (/(^|\/)(\.obsidian|\.trash|node_modules)$/i.test(e.path)) continue;
              await walk(e.path, depth + 1);
              continue;
            }
            if (!/\.md$/i.test(e.path) || e.path === dailyPath) continue;
            scanned++;
            const body = await dav.readFile(e.path);
            if (!body) continue;
            collected.push(...openTasks(parseTasks(body, e.path)));
          }
        };
        await walk(vault.replace(/^\/+|\/+$/g, ""), 0);

        // Overdue and today's tasks first
        collected.sort((a, b) => (a.due ?? "9999") .localeCompare(b.due ?? "9999"));
        blocks.push(
          `**Open tasks across the vault** (files scanned: ${scanned})\n\n` +
            formatTasks(collected),
        );
      }

      return text(blocks.join("\n\n---\n\n"));
    },
  );

  // ---------------------------------------------------------------- add_task
  server.registerTool(
    "add_task",
    {
      description:
        "Add a checkbox task to the daily note (or to a given note). " +
        "Obsidian Tasks format: '- [ ] text'. Due date via 📅 YYYY-MM-DD.",
      inputSchema: {
        task: z.string().min(1).describe("Task text"),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Daily note date; today by default"),
        due: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Due date, added as 📅 YYYY-MM-DD"),
        priority: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Priority: high -> ⏫, medium -> 🔼, low -> 🔽"),
        dailyFolder: z.string().default("Daily").describe("Daily notes folder"),
        path: z
          .string()
          .optional()
          .describe("Explicit note path relative to the vault; overrides dailyFolder"),
      },
    },
    async ({ task, date, due, priority, dailyFolder, path }) => {
      const dav = getDav(env);
      const when = dateInTz(tz);
      const day = date ?? when.date;

      const target = path
        ? joinPath(vault, path, "").replace(/\/+$/, "")
        : joinPath(vault, dailyFolder, `${day}.md`);

      const pr = priority === "high" ? " ⏫" : priority === "medium" ? " 🔼" : priority === "low" ? " 🔽" : "";
      const dueTag = due ? ` 📅 ${due}` : "";
      const line = `- [ ] ${task.trim()}${pr}${dueTag}`;

      const existing = await dav.readFile(target);
      if (existing === undefined) {
        const dir = target.split("/").slice(0, -1).join("/");
        await dav.ensureDir(dir);
        const header = `## Tasks\n\n`;
        await dav.writeFile(target, header + line + "\n");
        return text(`Created ${target} and added the task:\n${line}`);
      }

      // If the file has a Tasks section, insert at the end of that list
      const lines = existing.split(/\r?\n/);
      let insertAt = -1;
      for (let i = 0; i < lines.length; i++) {
        // Keep the Russian heading too: notes written by older versions use it.
        if (/^#{2,6}\s+(Tasks|Задачи)/i.test(lines[i])) {
          insertAt = i + 1;
          for (let j = i + 1; j < lines.length; j++) {
            if (/^\s*[-*+]\s+\[[ xX]\]/.test(lines[j]) || lines[j].trim() === "") insertAt = j + 1;
            else break;
          }
          break;
        }
      }

      if (insertAt < 0) {
        await dav.writeFile(target, existing.replace(/\s*$/, "") + "\n" + line + "\n");
      } else {
        lines.splice(insertAt, 0, line);
        await dav.writeFile(target, lines.join("\n").replace(/\s*$/, "") + "\n");
      }

      return text(`Task added to ${target}:\n${line}`);
    },
  );

  // ---------------------------------------------------------------- create_folder
  server.registerTool(
    "create_folder",
    {
      description:
        "Create a folder (and parents) in the vault. Add a note there afterwards with create_note.",
      inputSchema: {
        path: z.string().min(1).describe("Folder path relative to the vault, e.g. 'Projects/Website'"),
        readme: z
          .string()
          .optional()
          .describe("When set, also creates a note with this name inside the folder"),
        readmeContent: z.string().default("").describe("Body for that note"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ path, readme, readmeContent }) => {
      const dav = getDav(env);
      const full = joinPath(vault, path, "").replace(/\/+$/, "");
      await dav.ensureDir(full);

      if (readme) {
        const when = dateInTz(tz);
        const name = safeFileName(readme);
        const notePath = `${full}/${name}.md`;
        const body = frontmatter({ title: name, tags: [], when }) + stripFrontmatter(readmeContent);
        await dav.writeFile(notePath, body);
        return text(`Folder created: ${full}\nNote: ${notePath}`);
      }

      return text(`Folder created: ${full}`);
    },
  );

  // ---------------------------------------------------------------- echo (health check)
  server.registerTool(
    "ping",
    {
      description: "Check that the server is up and Koofr is reachable.",
      inputSchema: {},
    },
    async () => {
      try {
        const dav = getDav(env);
        const entries = await dav.list(joinPath(vault, "", "").replace(/\/+$/, ""));
        return text(`OK. Vault "${vault}" is reachable, top-level objects: ${entries.length}`);
      } catch (e) {
        return text(`Koofr access error: ${(e as Error).message}`);
      }
    },
  );

  return server;
}
