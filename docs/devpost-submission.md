# Devpost submission: Odobook

Amazon "Build, Ship, Shape" hackathon. Deadline **Sat 24 Oct 2026, 6:00 am AEDT**.

Items in `[brackets]` are placeholders.

---

## Project name

Odobook: a car logbook you talk to

## Elevator pitch (≤200 characters)

> Keep your ATO 12-week car logbook or IRS mileage log by voice. Say "start a work trip", "end trip", and Odobook records it properly. An MCP server built to the Alexa+ add-on spec.

(179 characters)

## Inspiration

In Australia, if you claim car expenses with the logbook method, the ATO wants a 12-week logbook: every work trip with dates, odometer readings, kilometres and a specific purpose. In the US, the IRS wants a contemporaneous mileage log. The people who need this most are tradies, sole traders and employees who drive between jobs all day, and the moment they need to record a trip is the moment they're behind the wheel. Typing into a phone app while driving is unsafe and illegal, so trips get reconstructed from memory at the end of the week, which is exactly what a logbook isn't supposed to be. Most of the apps that do this are subscriptions.

Voice is the natural interface in a car. With Alexa in the car (Echo Auto and built-in Alexa), "start a work trip to Geelong" should be all it takes. I'm a Victorian primary teacher and a self-taught developer (trading as TebTally), and I'd already sketched an Odobook iOS app idea. This hackathon was the push to build the voice-first version properly.

## What it does

Odobook is an MCP server with 11 tools that a voice assistant calls to keep a car logbook:

- **start_logbook / update_logbook / discard_logbook / close_logbook:** set up a logbook for a car (make, model, rego, engine size, odometer), fix details later, throw away an empty one, and close the period with a final odometer reading, which freezes the business-use percentage.
- **start_trip / end_trip / cancel_trip:** time a trip live. The odometer defaults to the last reading; the end needs an odometer reading or a distance.
- **log_trip:** record a trip you forgot. Anything entered more than 24 hours after the trip is flagged as a late entry.
- **logbook_status / list_trips:** days left, trips, business and total distance, business-use percentage, and the first thing that needs fixing.
- **export_logbook:** a CSV for your tax agent.

It knows the rules that make a logbook hold up:

- A business trip needs a specific purpose. "Business" or "work" alone is refused, and the assistant asks what the trip was for.
- Australian business trips should have odometer readings at both ends; Odobook reminds you when they're missing.
- Business % = business km / odometer distance over the period, not just the sum of logged trips (private driving often isn't logged trip by trip).
- An AU logbook runs 12 weeks (84 days, start day included). A first-year logbook can't cross 30 June, and Odobook warns if it would.
- The odometer can't go backwards, and a trip of 3,000+ km gets questioned.
- It never estimates a dollar deduction and says it isn't tax advice.

Every reply is written to be spoken: one or two short sentences, with details in `structuredContent` for screens like the Echo Show. It supports AU (km, ATO 12-week logbook) and US (miles, IRS mileage log for the tax year).

## How we built it

- **Cloudflare Worker** in TypeScript, acting as both the OAuth 2.1 authorization server and the protected MCP resource at `/mcp`. **D1** (SQLite) holds users, logbooks, trips and an amendments table; **KV** holds OAuth grants and tokens.
- **MCP:** `@modelcontextprotocol/sdk` over stateless Streamable HTTP (a fresh server per POST, JSON responses, no sessions), MCP spec 2025-11-25, with tool annotations (read-only, destructive, idempotent) on every tool.
- **Auth:** `@cloudflare/workers-oauth-provider` for authorization code + PKCE (S256 only), RFC 8707 resource indicators, RFC 9728 protected resource metadata and RFC 8414 authorization server metadata. Clients are pre-registered through an admin route, because Alexa+ doesn't support Dynamic Client Registration. Unauthenticated MCP requests get a bare 401 with no `WWW-Authenticate` header, as the Alexa+ docs require. The sign-in page is my own: PBKDF2 password hashing, same-origin form checks, a tight CSP.
- **Alexa+:** the real add-on toolkit (the `alexa-ai` CLI and MCP Toolkit) is available to select partners only. Amazon's Chief Alexa Evangelist said on the hackathon Discord that entrants should build the underlying MCP functionality, mimic the true add-on lifecycle, and demo it another way. So I built to every published Alexa+ MCP requirement, wrote an `addon.json` following the documented manifest fields, and demoed with the community **mcp-voice-simulator**, which does OAuth account linking and voice in the browser.
- **Agent Skill:** `skills/odobook-car-logbook/SKILL.md` teaches any agent the tools and the rules (ask for a real purpose, one question at a time while driving, never a dollar figure).
- **Amazon Bedrock:** a Converse API tool-use loop (the "brain") that reads the Odobook tool list over MCP and drives the tools from natural speech. It runs Amazon Nova 2 Lite (`global.amazon.nova-2-lite-v1:0`) from Sydney and plugs into the simulator as a custom brain (`simulator/run.mjs`, `SIM_BRAIN=bedrock`).
- **Testing:** 10 unit tests on the logbook rules (`node --test`); an end-to-end script against the live server covering discovery, the PKCE flow, every tool, code replay (a replayed authorization code is refused and revokes the token it issued) and per-call latency; and a headless-Chromium test of account linking, which caught three browser-only bugs the API tests couldn't (below).
- Built over about two days with **Claude Code** as a pair programmer.

## Challenges we ran into

- **The Alexa+ toolchain is partner-only, and the setup page doesn't say so.** I spent about an hour installing WSL, Node, AWS CLI v2 and an IAM user, then got a bare `AccessDenied` on `sts:AssumeRole`. The answer was in Discord. I switched to building to the published spec and demoing through a simulator.
- **The 401 rule conflicts with the MCP auth spec.** Alexa+ says send a 401 without `WWW-Authenticate`; the MCP spec and every mainstream OAuth library send it. I strip the header on `/mcp` and serve the protected-resource metadata at both the RFC 9728 path and the root path so clients still find it.
- **Three bugs only a real browser shows.** `Referrer-Policy: no-referrer` made browsers send `Origin: null` on the sign-in form, which my same-origin check refused. A CSP `form-action` directive blocked the redirect back to the linking app after the form post. And the "create an account" switch used a GET form that dropped the OAuth query string. All three passed the Node tests and failed in headless Chromium.
- **Latency from Australia.** A tool call makes several D1 queries; with the Worker near the user and the database elsewhere, each one paid a long round trip. Smart Placement runs the Worker next to the database, so a call is one long-haul hop. Measured live from Australia: 65–360 ms per call, under the 500 ms budget.
- **Making voice replies sound right.** "Logged 84 km for Quote for a bathroom" reads badly aloud. Small things like lower-casing the purpose, "1 mile" vs "52 miles", and en-AU vs en-US dates mattered more than expected.

## Accomplishments that we're proud of

- The whole published Alexa+ MCP auth checklist passes against the live server, tested end to end, including the edge cases (code replay revokes tokens, unregistered redirect URIs refused, forged cross-site sign-in refused).
- It's genuinely useful today: it applies the real ATO and IRS record-keeping rules, not just a trip timer.
- Every call is well under the 500 ms Alexa+ budget from the far side of the world.
- A contribution back to the community simulator that every Alexa+ track entrant can use.

## What we learned

- MCP plus OAuth 2.1 maps cleanly onto Alexa+'s requirements; an off-the-shelf OAuth library handled almost all of it. The one mismatch (the 401 header) was a wording question, not a technical one.
- Browser tests find bugs that protocol tests can't: Origin, Referrer-Policy and CSP all act on real form posts and redirects.
- For voice, the tool's text reply is the product. Writing it to be read aloud, and refusing early with a clear question, makes the assistant feel smart without extra model work.
- Domain rules belong in the server, not the prompt. The model can forget to ask for a purpose; the server never forgets to refuse "business".

## What's next for Odobook

- Submit as a real Alexa+ add-on as soon as the toolkit opens to developers, and test with Echo Auto in the car.
- Proactive prompts: "You've been parked at a job site for 10 minutes. Was that trip for work?"
- Amend a past trip by voice, with the change kept in the amendments table as an audit trail.
- Multiple cars, and a shared logbook for a small business's vehicles.
- The Odobook iOS app on the same backend, with CarPlay and Siri.
- A PDF report laid out the way tax agents expect.

## Built with

`typescript` `cloudflare-workers` `cloudflare-d1` `cloudflare-kv` `model-context-protocol` `oauth2` `pkce` `alexa` `amazon-alexa` `amazon-bedrock` `aws` `zod` `node.js` `playwright` `claude-code`

## Track and mini-challenge selections

- **Primary track:** Alexa+
- **Mini challenges:** Open Source; AWS Builder

## Open Source mini challenge

- **Contribution URL:** https://github.com/AlSayedGamal/mcp-voice-simulator/pull/10
- **Project repository URL:** https://github.com/Jaydenteb/odobook-alexa
- **GitHub username:** Jaydenteb
- **Description of the contribution:**
  > A pull request to mcp-voice-simulator, the community browser simulator that Alexa+ track entrants use to demo MCP servers by voice. Before it, speech input stopped at the first pause, so a natural sentence like "End trip... odometer 52,931" was cut in half and sent early. The PR makes voice input continuous, so pauses don't end the turn; sends automatically after 2 seconds of silence, so it stays hands-free; and sets the speech-recognition language from the browser's language instead of a fixed en-US, so Australian and other English speakers (and other languages) are recognised properly. The speaker echo guard is unchanged, so the simulator's own spoken reply still isn't sent back as a new utterance. I found the problem while testing Odobook by voice, where pausing to read an odometer is normal. The PR is open and awaiting review; it was tested with the project's 172 tests, a logic harness against a fake SpeechRecognition, and by hand in Chrome with a real microphone.

## AWS Builder mini challenge

- **AWS services used:** Amazon Bedrock (Converse API with tool use). Model: Amazon Nova 2 Lite via the global inference profile `global.amazon.nova-2-lite-v1:0`, called from ap-southeast-2. AWS IAM: a least-privilege user that can invoke only that model through that profile.
- **How they're used:**
  > A small "brain" in `simulator/` uses the Bedrock Converse API as the reasoning layer between speech and the Odobook MCP server, standing in for Alexa+'s own model. It lists Odobook's 11 tools over MCP, passes them to Converse as `toolConfig`, and loops: send the user's utterance, run any `toolUse` the model returns against Odobook's `/mcp` with the linked account's OAuth token, and return the `toolResult`. When a turn is a single tool call, the brain speaks Odobook's own voice-ready reply instead of having the model rephrase it: in testing, Nova 2 Lite once reported a refused call as a success, and the pass-through also halves the turn time to about 1 second. Odobook's server-side rules (refusing "business" as a purpose, late-entry flags, no dollar estimates) apply whichever model is driving. The brain has 19 unit tests with a mocked Bedrock client, and the IAM user can invoke only Nova 2 Lite through that one inference profile (policy in `simulator/README.md`).

## Testing instructions for judges

**Quickest check (no account needed):**
- Landing page: https://odobook-alexa.odobook-alexa.workers.dev/
- Protected resource metadata: https://odobook-alexa.odobook-alexa.workers.dev/.well-known/oauth-protected-resource/mcp
- Authorization server metadata: https://odobook-alexa.odobook-alexa.workers.dev/.well-known/oauth-authorization-server
- An unauthenticated `POST /mcp` returns a bare 401:
  `curl -i -X POST https://odobook-alexa.odobook-alexa.workers.dev/mcp -H "content-type: application/json" -d "{}"`

**Try it by voice with the simulator:**
1. Demo account: email `demo@odobook.example`, password [given in the Devpost testing instructions; kept out of the public repo]. It has a 12-week AU logbook for a Toyota HiLux with three weeks of trips. Please leave the logbook open (don't close or discard it) so the next judge sees the same data. (Or create your own account on the sign-in page; it takes 20 seconds.)
2. Run the simulator from this repo's `simulator/` folder (Node 22+): `npm install --ignore-scripts`, then
   `MCP_URL=https://odobook-alexa.odobook-alexa.workers.dev/mcp MCP_CLIENT_ID=MlV6mKfokdySIpfd node run.mjs`
   with either your own AWS profile that can use Nova 2 Lite (`AWS_PROFILE=... AWS_REGION=ap-southeast-2`, the default Bedrock brain) or `SIM_BRAIN=claude ANTHROPIC_API_KEY=...`. Then open http://127.0.0.1:8790.
3. Odobook only accepts pre-registered clients (as Alexa+ requires). `MlV6mKfokdySIpfd` is a public client registered for loopback redirects on any port, so it works for any judge running the simulator locally.
4. Click **Link account ↗**. The "Link Odobook" page opens; sign in with the demo account and you're sent back to the simulator.
5. Allow the microphone and try:
   - "How's my logbook going?"
   - "Start a work trip to Torquay."
   - "End trip, odometer [the starting reading it just told you, plus 24]. It was for business." (refused: needs a specific purpose)
   - "Quote for a bathroom renovation." (logged, with business %)
   - "I forgot to log yesterday's 30 km drive to Lara for a hot water service." (flagged if more than a day late)
   - "Export my logbook."
6. Without a microphone, type the same sentences.

**Run the tests yourself:** clone the repo, `npm install`, `npm test` (unit tests). The live e2e (`npm run test:e2e`) needs the admin token, so it isn't runnable by judges; its output is in the video.

Please don't put real personal or tax information into the demo account; other judges share it.

## Did this project exist before the hackathon?

No. All the code was written during the hackathon, this week. Before it there was only an idea for an Odobook iOS app, which was planned but never built; no code or assets from it were reused.
