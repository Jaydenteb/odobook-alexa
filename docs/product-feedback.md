# Product feedback: Amazon tools used for Odobook

Amazon "Build, Ship, Shape" hackathon, Alexa+ track. Written by Jayden Tebble from the friction log kept while building (`friction-log.md`), which is the source of truth for the dates and errors below. Items marked **TODO-VERIFY** are pending and will be filled in before submission.

Summary: the published Alexa+ MCP requirements are clear and standards-based, and building to them was the best part of the week. The biggest problem was discovering, after an hour of setup, that the toolchain is partner-only, from an error message that didn't say so.

---

## 1. Alexa+ for Builders documentation (MCP add-ons, MCP Toolkit, Category SDK)

**What I used it for:** the requirements for an Alexa+ MCP add-on (transport, MCP version, OAuth 2.1, metadata, latency), the `addon.json` manifest fields from *Create an MCP add-on*, and *Set Up Your Development Environment* for the `alexa-ai` CLI.

**What worked**
- The MCP requirements are concrete and standards-based: Streamable HTTP, MCP 2025-11-25, OAuth 2.1 authorization code + PKCE (S256), RFC 8707 resource indicators, RFC 9728 / RFC 8414 metadata, pre-registered clients, a 500 ms budget. An off-the-shelf OAuth library (`@cloudflare/workers-oauth-provider`) covered nearly all of it, and apart from one item (below) the whole auth checklist passed in my end-to-end test on the first run.
- Stating "no Dynamic Client Registration" and "no `WWW-Authenticate`" up front saved guesswork; those are exactly the places a generic MCP server would differ.
- The 500 ms budget is generous for a stateless JSON-mode server. I measured 8–25 ms locally and 65–360 ms live from Australia.
- The manifest field list (locales, example phrases, icons, privacy and terms URLs, the MCP integration block) was enough to write a plausible `addon.json` without the CLI.

**What needs work**
- **The "select partners only" notice is on the docs home page but not on *Set Up Your Development Environment* or the MCP Toolkit quickstart.** I followed the setup page from the top: Alexa developer account, IAM user with `sts:AssumeRole` on `AddOn3PDeveloperToolsRead`, WSL, Node 24, AWS CLI v2, the two AWS profiles. Then `aws sts get-caller-identity --profile alexa-ai` failed with a bare `AccessDenied`. About an hour went into a path that couldn't work. Another entrant hit the same wall on 15 Sep 2026, so it isn't a one-off.
- **The 401 wording conflicts with the MCP authorization spec.** The docs say unauthenticated requests should get "`401 Unauthorized` (without a `WWW-Authenticate` header)" and list `WWW-Authenticate` as "not supported yet". The MCP spec (2025-11-25) uses `WWW-Authenticate` with `resource_metadata` as the main discovery path, and mainstream libraries always send it. It's unclear whether Alexa+ *rejects* a 401 carrying the header or just *ignores* it. I strip it with a small wrapper and serve the metadata at both the RFC 9728 path and the root path, but a spec-compliant server shouldn't have to guess.
- **No Windows instructions.** The CLI page lists macOS Sierra+ and Ubuntu only. An npm CLI ought to run on Windows; if it can't, a "Windows: use WSL2" note with steps would help.
- **Manifest nesting isn't confirmed without the CLI.** The field names are documented, but without `alexa-ai deploy` I can't validate the structure. A published JSON Schema for `addon.json` would let anyone validate offline.

**Onboarding:** poor for non-partners, because the blocker appears at the end of setup rather than the start. For someone who reads the docs home page first it'd be fine.

**Would I build with it again?** Yes. The requirements are well chosen and I'd ship Odobook as a real add-on the day the toolkit opens. I'd want the partner-only status and the 401 behaviour made explicit first.

## 2. Alexa developer account and Login with Amazon

**What I used it for:** creating an Alexa developer account as step one of the add-on setup.

**What worked:** sign-up with an existing Amazon account was quick, and the developer console was familiar.

**What needs work:** nothing in the developer account tells you whether it's enrolled in the Alexa+ add-on tools. A simple "Alexa+ add-on tools: not enabled for this account (partners only)" status on the console would have stopped me before I touched AWS. I didn't end up needing Login with Amazon for Odobook itself: Alexa+ links to my own OAuth server, so Odobook users don't need an Amazon login to use it. That's the right design.

**Onboarding:** smooth for the account itself.

**Would I build with it again?** Yes.

## 3. AWS IAM and STS (role assumption for the Alexa AI CLI)

**What I used it for:** the documented setup: an IAM user (`alexa-ai-dev`) with an inline policy allowing `sts:AssumeRole` on `arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`, an access key, an `alexa-ai-user` base profile and an `alexa-ai` role profile, then `aws codeartifact login` and `npm install -g @alexa-ai/cli`.

**What worked:** the IAM side was easy to follow, and the base profile authenticated straight away. The docs gave exact policy JSON and profile config, which is better than most.

**What needs work**
- `aws sts get-caller-identity --profile alexa-ai` returned `AccessDenied ... is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`, with no reason or next step. From my side the policy was correct; the refusal was the role's trust policy in Amazon's account, which I can't see. A bare AccessDenied on a cross-account role sends people debugging their own IAM for nothing.
- Suggestion: a pre-check (CLI command or console page) that says "this AWS account isn't allow-listed for Alexa+ add-on tools", or a line in the docs: "If AssumeRole is denied, your account isn't enrolled yet."
- Asking people to create long-lived IAM user access keys for a developer tool feels dated; IAM Identity Center or a browser-based login would be safer. I deleted the unused user and key afterwards.

**Onboarding:** clear steps, unhelpful failure.

**Would I build with it again?** Yes for IAM generally; for this flow, only once enrolment can be checked up front.

## 4. Amazon Bedrock (Converse API), for the AWS Builder mini challenge

**What I used it for:** a "brain" in `simulator/` that drives Odobook's MCP tools through the Converse API's tool use, standing in for the Alexa+ model. Model: **Amazon Nova 2 Lite** through the global inference profile `global.amazon.nova-2-lite-v1:0`, called from Sydney (`ap-southeast-2`), non-streaming `Converse`, with a least-privilege IAM user.

**What worked:**
- Converse's `toolConfig` / `toolUse` / `toolResult` shape maps directly onto MCP's `tools/list` and `tools/call`, so converting Odobook's JSON Schema tool definitions was mechanical.
- Nova 2 Lite chose the right tool with the right arguments on the first live call ("Start a work trip to Geelong" → `start_trip { kind: "business", destination: "Geelong" }`, `stopReason: tool_use`, about 1.2 s).
- The least-privilege IAM policy (the inference profile, plus the foundation model only through that profile) worked first time.
- Amazon models need no use-case form: the playground worked immediately, which made Nova the fastest path.
- One API across models meant switching from Claude to Nova was a one-line model ID change.

**What needs work:**
- **Claude Haiku 5.5 was refused with no reason.** After I submitted Anthropic's use-case form, the playground returned `AccessDeniedException: anthropic.claude-haiku-5-5 is not available for this account ... contact AWS Sales`. It doesn't say whether the form is still pending, whether new accounts are restricted, or what to do next. "Contact Sales" is a heavy next step for a hackathon entrant.
- **No Australian route for Nova 2 Lite from Sydney.** It's offered only through the global profile, so requests may be served outside Australia. That matters for an app holding Australians' trip records. An AU geo profile would help.
- **Global-profile IAM is easy to get wrong.** The policy needs the Region-less foundation-model ARN (`arn:aws:bedrock:::foundation-model/...`) as well as the Regional ones. That's documented, but there's no worked example on the model card.

**Onboarding:** About 10 minutes from the Bedrock console to a working tool-use call, including creating the IAM user and access key. Most of that time went on the Claude refusal before switching to Nova.

**Would I build with it again?** Yes. Converse plus tool use is a clean fit for MCP. I'd like Claude access on a new account to be predictable, and an AU route for Nova.

## 5. Devpost and the hackathon Discord (support)

**What I used it for:** rules and track details (Devpost), and technical questions (Discord, `#amazon-developer-tech-questions`).

**What worked**
- Discord was where the answers were. Amazon staff confirmed the partner-only restriction there, and Amazon's Chief Alexa Evangelist gave a clear direction: build the underlying MCP functionality, mimic the real add-on lifecycle, and demo it another way. That turned a dead end into a plan within the evening.
- Staff responses were direct and didn't hedge.

**What needs work**
- The Alexa+ track page on Devpost doesn't say the real toolchain is partner-only or that a simulated demo is expected. That one sentence would have saved me (and at least one other entrant) the setup detour. Answers that change how everyone should build belong on the Devpost page or a pinned FAQ, not only in a Discord thread.
- An official, linked stand-in (a web simulator that accepts any MCP server URL and does account linking) would make entries comparable. Entrants are currently relying on a community simulator, which is why I sent it a pull request.

**Would I use them again?** Yes.

---

## Feature requests

### Critical
1. **Say "partners only" where people start.** Put it at the top of *Set Up Your Development Environment*, the MCP Toolkit quickstart and the hackathon's Alexa+ track page.
2. **A sandboxed path for non-partners**: either a limited toolkit for hackathon entrants, or an official web simulator that takes any MCP server URL, does real Alexa+-style account linking and speaks replies, so builders can test the real lifecycle end to end.
3. **Clear enrolment errors.** Replace the bare `AccessDenied` with "This account isn't enrolled in Alexa+ add-on tools" (from the CLI or a pre-check).

### Important
4. **Clarify the 401 / `WWW-Authenticate` rule.** Say whether a header is rejected or ignored. If ignored, reword it as "Alexa+ doesn't read `WWW-Authenticate`; also host protected-resource metadata at the well-known URI", so spec-compliant servers work unchanged.
5. **Publish a JSON Schema for `addon.json`** and an offline validator (`alexa-ai validate` that doesn't need deploy rights).
6. **A conformance test suite** for MCP add-on servers: discovery, PKCE, resource indicators, code replay, latency from several regions. I wrote my own; an official one would catch the same issues for everyone.
7. **Document latency measurement:** where the 500 ms is measured from, and which AWS region Alexa+ calls from, so builders outside the US (I'm in Australia) can place servers sensibly.

### Nice to have
8. **Windows support** for the `alexa-ai` CLI, or documented WSL2 steps.
9. **Short-lived credentials** (IAM Identity Center / browser login) instead of IAM user access keys for the CLI.
10. **Car context for add-ons:** a documented signal that the user is in a vehicle (Echo Auto, built-in Alexa), so add-ons like Odobook can keep replies shorter and avoid follow-up questions while driving.
11. **Proactive prompts for add-ons** (with user permission), such as "You've arrived; was that a work trip?", which would make logbook-style add-ons far more useful.
