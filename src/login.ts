/**
 * Login page for OAuth.
 *
 * The client (Claude) arrives at /authorize and we show a password form.
 * The password comes from the OWNER_PASSWORD secret. Without it /authorize
 * returns 503, so the vault can never be exposed by accident.
 */

const COOKIE = "__Host-owner_session";

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Obsidian MCP — sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0f1115; color: #e6e6e6; padding: 24px; }
  .card { width: 100%; max-width: 380px; background: #171a21; border: 1px solid #262b36;
          border-radius: 14px; padding: 28px; box-sizing: border-box; }
  h1 { font-size: 1.15rem; margin: 0 0 6px; }
  p  { margin: 0 0 20px; color: #9aa4b2; font-size: .9rem; }
  label { display: block; font-size: .85rem; color: #9aa4b2; margin-bottom: 6px; }
  input { width: 100%; padding: 11px 12px; box-sizing: border-box; border-radius: 9px;
          border: 1px solid #2d3340; background: #0f1115; color: #e6e6e6; font-size: 1rem; }
  input:focus { outline: 2px solid #3b82f6; outline-offset: 1px; border-color: #3b82f6; }
  button { width: 100%; margin-top: 18px; padding: 11px; border-radius: 9px; border: 0;
           background: #3b82f6; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #2f6fd8; }
  .err { background: #3a1d1d; border: 1px solid #6b2b2b; color: #ffb4b4;
         padding: 10px 12px; border-radius: 9px; font-size: .87rem; margin-bottom: 16px; }
  .scope { font-size: .82rem; color: #8b95a5; margin-top: 14px; }
  code { background: #0f1115; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body><div class="card">${body}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export function loginPage(opts: {
  error?: string;
  scopes?: string[];
  /** Query string of the original /authorize, kept in the form action. */
  action?: string;
}): Response {
  const err = opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : "";
  const scopeList = (opts.scopes ?? []).join(", ");
  // IMPORTANT: the action must keep the original query parameters, otherwise
  // the POST arrives without client_id and the request is rejected.
  const action = opts.action ? `/authorize?${opts.action}` : "/authorize";

  return html(`
    <h1>Obsidian MCP</h1>
    <p>Enter the owner password to allow access to your notes.</p>
    ${err}
    <form method="POST" action="${escapeHtml(action)}">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autocomplete="current-password"
             required autofocus>
      <button type="submit">Sign in and allow</button>
      ${scopeList ? `<div class="scope">Requested scopes: <code>${escapeHtml(scopeList)}</code></div>` : ""}
    </form>
  `, opts.error ? 401 : 200);
}

export function errorPage(message: string, status = 400): Response {
  return html(`
    <h1>Sign-in failed</h1>
    <div class="err">${escapeHtml(message)}</div>
    <p>Go back to Claude and try connecting the connector again.</p>
  `, status);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Constant-time password comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Simple owner session kept in a signed cookie.
 * It stops the consent page from asking for the password again.
 */
async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function issueSession(secret: string): Promise<string> {
  const issued = Math.floor(Date.now() / 1000).toString();
  const sig = await hmac(secret, issued);
  return `${issued}.${sig}`;
}

export async function verifySession(secret: string, cookieValue: string | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  const [issued, sig] = cookieValue.split(".");
  if (!issued || !sig) return false;

  const expected = await hmac(secret, issued);
  if (!safeEqual(sig, expected)) return false;

  // The session lasts 12 hours
  const ageSec = Math.floor(Date.now() / 1000) - Number(issued);
  return Number.isFinite(ageSec) && ageSec >= 0 && ageSec < 12 * 3600;
}

export function sessionCookie(value: string, maxAgeSec = 12 * 3600): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function readSessionCookie(request: Request): string | undefined {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}
