/** Parses Markdown tasks in Obsidian Tasks / GitLab format (`- [ ]`). */

export interface Task {
  text: string;
  done: boolean;
  path: string;
  line: number;
  section?: string;
  due?: string;
  priority?: "high" | "medium" | "low";
  raw: string;
}

const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX/\-])\]\s+(.*)$/;

/** Extracts Obsidian Tasks dates: 📅 2025-01-30, plus @due(...) and due:: forms. */
function extractDue(text: string): string | undefined {
  const patterns = [
    /📅\s*(\d{4}-\d{2}-\d{2})/,
    /@due\((\d{4}-\d{2}-\d{2})\)/,
    /\bdue::\s*(\d{4}-\d{2}-\d{2})/i,
    /\bdue date[:\s]+(\d{4}-\d{2}-\d{2})/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[1];
  }
  return undefined;
}

function extractPriority(text: string): Task["priority"] {
  if (/⏫|🔺|!!!|p1\b/i.test(text)) return "high";
  if (/🔼|!!|p2\b/i.test(text)) return "medium";
  if (/🔽|!|p3\b/i.test(text)) return "low";
  return undefined;
}

/** Strips service markers so the task text stays readable. */
export function cleanTaskText(text: string): string {
  return text
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/(⏫|🔺|🔼|🔽|✅|❌|🛫|⏳)/g, "")
    .replace(/@due\([^)]*\)/g, "")
    .replace(/\bdue::\s*\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Parses a whole file. `section` is the nearest ## / ### heading. */
export function parseTasks(markdown: string, path: string): Task[] {
  const out: Task[] = [];
  let section: string | undefined;

  markdown.split(/\r?\n/).forEach((line, i) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      return;
    }
    const m = CHECKBOX.exec(line);
    if (!m) return;

    const [, , mark, rest] = m;
    out.push({
      text: cleanTaskText(rest),
      done: mark.toLowerCase() === "x",
      path,
      line: i + 1,
      section,
      due: extractDue(rest),
      priority: extractPriority(rest),
      raw: line,
    });
  });

  return out;
}

/** Open tasks only. */
export function openTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.done);
}

/** Formats tasks grouped by file and section. */
export function formatTasks(tasks: Task[], opts: { showPath?: boolean } = {}): string {
  if (!tasks.length) return "No tasks found.";

  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = opts.showPath === false ? (t.section ?? "—") : `${t.path}${t.section ? " › " + t.section : ""}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const lines: string[] = [];
  for (const [group, arr] of groups) {
    lines.push(`### ${group}`);
    for (const t of arr) {
      const mark = t.done ? "x" : " ";
      const pr = t.priority === "high" ? " ⏫" : "";
      const due = t.due ? ` 📅 ${t.due}` : "";
      lines.push(`- [${mark}] ${t.text}${pr}${due}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
