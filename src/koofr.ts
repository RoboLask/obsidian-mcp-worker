/**
 * Minimal WebDAV client for Koofr that runs on Cloudflare Workers.
 * Koofr WebDAV: https://app.koofr.net/dav/Koofr
 * Auth: Basic, email + application-specific password.
 */

export interface KoofrConfig {
  email: string;
  password: string;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://app.koofr.net/dav/Koofr";

function basicAuth(email: string, password: string): string {
  // btoa is available in Workers
  return "Basic " + btoa(`${email}:${password}`);
}

export class KoofrWebDAV {
  private readonly base: string;
  private readonly auth: string;

  constructor(cfg: KoofrConfig) {
    this.base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.auth = basicAuth(cfg.email, cfg.password);
  }

  /** Builds an absolute URL from a path inside the vault. */
  private url(path: string): string {
    const clean = path.replace(/^\/+/, "");
    return `${this.base}/${clean.split("/").map(encodeURIComponent).join("/")}`;
  }

  private headers(extra?: Record<string, string>): Headers {
    const h = new Headers({ Authorization: this.auth });
    for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
    return h;
  }

  /** Whether this file or folder exists. */
  async exists(path: string): Promise<boolean> {
    const res = await fetch(this.url(path), {
      method: "HEAD",
      headers: this.headers(),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`WebDAV HEAD ${path}: ${res.status} ${res.statusText}`);
    return true;
  }

  /** Reads a file as text. Returns undefined when not found. */
  async readFile(path: string): Promise<string | undefined> {
    const res = await fetch(this.url(path), { headers: this.headers() });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`WebDAV GET ${path}: ${res.status} ${res.statusText}`);
    return await res.text();
  }

  /** Writes a file atomically (PUT creates or overwrites). */
  async writeFile(path: string, body: string): Promise<void> {
    const res = await fetch(this.url(path), {
      method: "PUT",
      headers: this.headers({ "Content-Type": "text/markdown; charset=utf-8" }),
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WebDAV PUT ${path}: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }
  }

  /** Creates folders recursively (MKCOL; 405 means it already exists). */
  async ensureDir(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      const res = await fetch(this.url(current), {
        method: "MKCOL",
        headers: this.headers(),
      });
      // 201 created, 405 already exists
      if (!res.ok && res.status !== 405) {
        throw new Error(`WebDAV MKCOL ${current}: ${res.status} ${res.statusText}`);
      }
    }
  }

  /**
   * Lists files in a folder (depth 1) via PROPFIND.
   * Returns paths relative to the vault.
   */
  async list(dir: string): Promise<{ path: string; isDir: boolean; lastModified?: string }[]> {
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:resourcetype/><d:getlastmodified/><d:getcontentlength/></d:prop>
</d:propfind>`;

    const res = await fetch(this.url(dir), {
      method: "PROPFIND",
      headers: this.headers({ Depth: "1", "Content-Type": "application/xml; charset=utf-8" }),
      body,
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`WebDAV PROPFIND ${dir}: ${res.status} ${res.statusText}`);

    const xml = await res.text();
    return parsePropfind(xml);
  }
}

/** Simple but robust multistatus parsing, with no XML dependencies. */
function parsePropfind(xml: string): { path: string; isDir: boolean; lastModified?: string }[] {
  const out: { path: string; isDir: boolean; lastModified?: string }[] = [];
  const responses = xml.split(/<(?:\w+:)?response[\s>]/i).slice(1);

  for (const raw of responses) {
    const href = /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/i.exec(raw)?.[1];
    if (!href) continue;

    let path = decodeURIComponent(href);
    const marker = "/dav/Koofr";
    const idx = path.indexOf(marker);
    if (idx >= 0) path = path.slice(idx + marker.length);
    path = path.replace(/^\/+/, "").replace(/\/+$/, "");

    const isDir = /<(?:\w+:)?collection\s*\/?>/i.test(raw) || /<(?:\w+:)?collection>/i.test(raw);
    const lastModified = /<(?:\w+:)?getlastmodified>([^<]+)</i.exec(raw)?.[1];

    if (!path) continue; // the requested directory itself
    out.push({ path, isDir, lastModified });
  }
  return out;
}
