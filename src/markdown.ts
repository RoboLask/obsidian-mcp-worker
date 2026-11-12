/** Helpers: safe file names, dates, note frontmatter. */

/** Strips anything from a name that breaks a path, Koofr or Obsidian. */
export function safeFileName(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]/g, "-") // characters Windows and Obsidian reject
    .replace(/[.\s]+$/g, "") // Windows dislikes a trailing dot
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return cleaned || "Untitled";
}

/** Plural form picker ("note", "notes"). */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** YYYY-MM-DD in the given time zone (no dependency on the runtime locale). */
export function dateInTz(tz: string): { date: string; iso: string } {
  const now = new Date();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const iso = `${date}T${get("hour")}:${get("minute")}`;
  return { date, iso };
}

export interface NoteMeta {
  title: string;
  tags: string[];
  when: { date: string; iso: string };
  folderHint?: string;
  /** Whether to add "created" to the frontmatter. Off by default. */
  markCreated?: boolean;
  /** Whether to add "source: mcp" to the frontmatter. Off by default. */
  markSource?: boolean;
}

/**
 * YAML frontmatter for Obsidian (properties).
 *
 * Empty by default, so notes are not cluttered with service fields.
 * When there is nothing to add it returns "" and the file starts with the text.
 *
 * Optional fields:
 * - tags — only when the caller passes them
 * - created / source — only when explicitly enabled
 */
export function frontmatter(meta: NoteMeta): string {
  const tags = meta.tags.filter(Boolean);
  const lines: string[] = [];

  if (tags.length) lines.push(`tags: [${tags.map((t) => `"${t}"`).join(", ")}]`);
  if (meta.markCreated) lines.push(`created: ${meta.when.date}`);
  if (meta.markSource) lines.push(`source: mcp`);

  // No properties at all — the frontmatter is not needed.
  if (!lines.length) return "";

  return ["---", ...lines, "---", ""].join("\n");
}

/** Note footer: a backlink plus a rule for the agent. */
export function noteFooter(): string {
  return "\n\n---\n#mcp/inbox\n";
}

/** Normalises a tag string: "a, #b" -> ["a","b"] */
export function parseTags(input?: string | string[]): string[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : input.split(/[,\s]+/);
  return arr.map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
}

/** Turns agent markdown into a note body: drops any frontmatter it brought. */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}
