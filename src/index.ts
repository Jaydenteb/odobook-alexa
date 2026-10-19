/**
 * Odobook: one Worker that is both the OAuth 2.1 authorization server and the protected MCP
 * resource at /mcp, built to the published Alexa+ MCP add-on requirements:
 * - Streamable HTTP, MCP spec 2025-11-25
 * - OAuth 2.1 authorization code + PKCE (S256 only), RFC 8707 resource indicators
 * - RFC 9728 protected resource metadata and RFC 8414 authorization server metadata
 * - pre-registered clients only (Alexa+ doesn't support Dynamic Client Registration)
 * - a bare 401 for unauthenticated MCP requests (Alexa+ doesn't read WWW-Authenticate; clients
 *   find the metadata at the well-known URLs instead)
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { defaultHandler, type Env } from "./auth";
import { mcpHandler } from "./mcp";

let cached: { url: string; provider: OAuthProvider<Env> } | null = null;

function providerFor(env: Env): OAuthProvider<Env> {
  if (cached?.url === env.PUBLIC_URL) return cached.provider;
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    // The library types handlers as ExportedHandler; ours reads ctx.props, which it sets.
    apiHandler: mcpHandler as unknown as { fetch: ExportedHandlerFetchHandler<Env> },
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    scopesSupported: ["logbook:read", "logbook:write", "offline_access"],
    resourceMetadata: {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      resource_name: "Odobook car logbook",
    },
    accessTokenTTL: 3600,
  });
  cached = { url: env.PUBLIC_URL, provider };
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // RFC 9728 puts the metadata at /.well-known/oauth-protected-resource/mcp; some clients only
    // try the root form, so serve the same document there too.
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      url.pathname = "/.well-known/oauth-protected-resource/mcp";
      request = new Request(url, request);
    }
    const res = await providerFor(env).fetch(request, env, ctx);
    const path = url.pathname;
    if (res.status === 401 && (path === "/mcp" || path.startsWith("/mcp/")) && res.headers.has("WWW-Authenticate")) {
      const headers = new Headers(res.headers);
      headers.delete("WWW-Authenticate");
      return new Response(res.body, { status: 401, headers });
    }
    return res;
  },
} satisfies ExportedHandler<Env>;
