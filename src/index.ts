import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { buildServer, type Env } from "./tools";
import {
  errorPage,
  issueSession,
  loginPage,
  readSessionCookie,
  safeEqual,
  sessionCookie,
  verifySession,
} from "./login";

export interface OAuthEnv extends Env {
  OWNER_PASSWORD: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: {
    parseAuthRequest(req: Request): Promise<any>;
    lookupClient(clientId: string): Promise<any>;
    completeAuthorization(opts: {
      request: any;
      userId: string;
      metadata: Record<string, unknown>;
      scope: string[];
      props: Record<string, unknown>;
    }): Promise<{ redirectTo: string }>;
  };
}

/** MCP handler. Called only after a valid OAuth token has been verified. */
const apiHandler = {
  async fetch(request: Request, env: OAuthEnv): Promise<Response> {
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

/**
 * Everything outside /mcp: the login and consent pages.
 * The /authorize flow lives here too.
 */
const defaultHandler = {
  async fetch(request: Request, env: OAuthEnv): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;

    if (!env.OWNER_PASSWORD) {
      return errorPage(
        "Server is not configured: the OWNER_PASSWORD secret is missing. " +
          "Run: npx wrangler secret put OWNER_PASSWORD",
        503,
      );
    }

    // ---------------------------------------------------------- /authorize GET
    if (url.pathname === "/authorize" && request.method === "GET") {
      try {
        const authRequest = await oauth.parseAuthRequest(request);

        // Already signed in? Issue the code right away, no second password prompt.
        const ok = await verifySession(env.OWNER_PASSWORD, readSessionCookie(request));
        if (ok) {
          const { redirectTo } = await oauth.completeAuthorization({
            request: authRequest,
            userId: "owner",
            metadata: {},
            scope: authRequest.scope,
            props: { user: "owner" },
          });
          return Response.redirect(redirectTo, 302);
        }

        return loginPage({ scopes: authRequest.scope, action: url.search.slice(1) });
      } catch (e) {
        return loginPage({
          error: `Invalid authorization request: ${(e as Error).message}`,
          action: url.search.slice(1),
        });
      }
    }

    // --------------------------------------------------------- /authorize POST
    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const password = String(form.get("password") ?? "");

      if (!safeEqual(password, env.OWNER_PASSWORD)) {
        return loginPage({
          error: "Wrong password. Please try again.",
          action: url.search.slice(1),
        });
      }

      // Password is correct: issue the code and remember the session.
      // IMPORTANT: the authorization request comes from the original browser
      // request; the query string survives a POST to the same URL.
      try {
        const authRequest = await oauth.parseAuthRequest(request);
        const { redirectTo } = await oauth.completeAuthorization({
          request: authRequest,
          userId: "owner",
          metadata: {},
          scope: authRequest.scope,
          props: { user: "owner" },
        });

        const token = await issueSession(env.OWNER_PASSWORD);
        return new Response(null, {
          status: 302,
          headers: { Location: redirectTo, "Set-Cookie": sessionCookie(token) },
        });
      } catch (e) {
        return errorPage(`Could not complete authorization: ${(e as Error).message}`, 400);
      }
    }

    // --------------------------------------------------------------------- home
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "obsidian-mcp is running.\n\n" +
          "MCP endpoint: POST /mcp\n" +
          "Auth: OAuth 2.1 (clients register themselves via DCR).\n\n" +
          "In Claude: Settings -> Connectors -> Add custom connector\n" +
          "and enter this worker URL with the /mcp path. Leave auth at the default (OAuth).\n",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

/**
 * Public address of the worker. Must match the domain you deploy to.
 * Change it here, in this one place.
 */
const BASE_URL = "https://obsidian-mcp.example.workers.dev";

export default new OAuthProvider<OAuthEnv>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp:read", "mcp:write", "offline_access"],
  resourceMetadata: {
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
  },
  requiredScopes: ["mcp:read"],
  clientIdMetadataDocumentEnabled: true,
});
