# Friction log: Amazon Build, Ship, Shape (Alexa+ track)

Entries are written as things happen. Times are Melbourne (AEDT).

## 1. Alexa AI CLI setup: AssumeRole denied with no explanation

- **When:** Mon 19 Oct 2026, evening
- **Task:** Install and authenticate the Alexa AI CLI (`@alexa-ai/cli`) to build an Alexa+ MCP add-on.
- **Steps taken:**
  1. Followed *Set Up Your Development Environment* (Alexa+ add-ons docs).
  2. Created an Alexa developer account and signed in.
  3. Created IAM user `alexa-ai-dev` with an inline policy allowing `sts:AssumeRole` on `arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`, plus an access key.
  4. On Windows, installed Ubuntu 24.04 under WSL, because the CLI page lists only macOS and Ubuntu. Then installed Node 24 and AWS CLI v2.
  5. Set up the `alexa-ai-user` base profile and the `alexa-ai` role profile exactly as documented.
  6. Ran `aws sts get-caller-identity --profile alexa-ai`.
- **Expected:** The assumed-role identity in account 372468808636. Then `aws codeartifact login` and `npm install -g @alexa-ai/cli`.
- **Actual:** `AccessDenied ... is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`. The base profile worked, and the error gave no reason or next step.
- **Root cause (found in Discord):** The MCP Toolkit and Category SDK are available to select partners only. The add-ons docs home page says so, but the setup page doesn't, and the hackathon's Alexa+ track page doesn't either. An earlier entrant hit the same wall on 15 Sep 2026, and Amazon staff confirmed it in the #amazon-developer-tech-questions forum.
- **Severity:** High. About an hour of setup (WSL, Node, AWS CLI, IAM user, keys) went into a path that couldn't work, and the error message gives no clue why.
- **Workaround:** Build the MCP server to the published add-on requirements (Streamable HTTP, OAuth 2.1 + PKCE, PRM, 500 ms latency, `addon.json`), and demo it through a stand-in simulator instead of the real toolchain. Deleted the now-unused IAM user and key.
- **Suggestions:**
  1. Put the "select partners only" callout at the top of *Set Up Your Development Environment* and the MCP Toolkit quickstart, not only on the docs home page.
  2. On the hackathon page, say plainly that the Alexa+ track can't use the real toolchain, and link to the recommended simulated path.
  3. Return a clear error from the CLI onboarding (or the role's trust policy), such as "This account isn't enrolled in Alexa+ add-on tools", instead of a bare AccessDenied.
  4. Give hackathon entrants a sandboxed toolkit or an official web simulator that accepts any MCP server URL.

## 2. Alexa AI CLI: no Windows support

- **Task:** Install the CLI on a Windows 11 PC.
- **Expected:** An npm package that runs on any OS with Node.
- **Actual:** The docs list only macOS Sierra+ and Ubuntu, so Windows developers need WSL first.
- **Severity:** Low (there's a workaround).
- **Workaround:** WSL2 with Ubuntu 24.04.
- **Suggestion:** Support Windows, or at least add a "Windows: use WSL2" note with the steps.

## 3. "401 without WWW-Authenticate" conflicts with the MCP auth spec and standard OAuth libraries

- **When:** Tue 20 Oct 2026
- **Task:** Make the MCP server's unauthenticated response match the Alexa+ MCP requirements.
- **Steps taken:** Built the server with a mainstream OAuth 2.1 provider library (`@cloudflare/workers-oauth-provider` 1.2.3), then compared its 401 with the Alexa+ checklist.
- **Expected:** The same 401 would suit both Alexa+ and other MCP clients.
- **Actual:** The Alexa+ docs say unauthenticated requests should get "`401 Unauthorized` (without a `WWW-Authenticate` header)" and list `WWW-Authenticate` under "not supported yet". But the MCP authorization spec (2025-11-25) has servers send `WWW-Authenticate` with `resource_metadata` as the main discovery path, and the library always sends it. A server written to the MCP spec doesn't match the Alexa+ wording out of the box, and it's unclear whether the header is harmful or just ignored.
- **Severity:** Medium. It's easy to work around once spotted, but ambiguous wording here could fail certification or account linking.
- **Workaround:** A small wrapper strips `WWW-Authenticate` from 401s on `/mcp`. The protected resource metadata is served at both `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and the root form, so clients can still find it.
- **Suggestion:** Say whether Alexa+ *rejects* a 401 that carries `WWW-Authenticate` or just *ignores* the header. If it's ignored, reword the requirement as "Alexa+ doesn't read `WWW-Authenticate`; also host PRM at the well-known URI", so spec-compliant servers don't need to change.

## 4. Positive: the requirements map cleanly onto standard OAuth 2.1 tooling

- Pre-registered clients (no DCR), S256-only PKCE, RFC 8707 `resource` and RFC 8414/9728 metadata were all supported by an off-the-shelf library. Apart from entry 3, the whole Alexa+ auth checklist passed in our end-to-end test on the first run.
- Measured round trips were 8–25 ms locally against the 500 ms budget. The budget is generous for a stateless JSON-mode Streamable HTTP server.
