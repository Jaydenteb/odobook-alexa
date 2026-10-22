# Odobook demo video script

Target length: **2:45** (hard stop before 3:00; judges needn't watch past it). The best material, a real voice exchange with a refusal, is in the first 30 seconds.

## Before you record

1. **The demo account is already seeded** (Fri 23 Oct): 11 trips, last odometer 52,907 km. Before any shots it reads *"Day 22 of 84, 62 to go. 11 trips, 485 km for work out of 597 km. Business use is 81%. 1 trip was entered more than a day late."* Don't re-seed: that would undo step 2. If you ever must, run:
   ```
   BASE=https://odobook-alexa.odobook-alexa.workers.dev ADMIN_TOKEN=... DEMO_EMAIL=... DEMO_PASSWORD=... RESET=1 node scripts/seed-demo.mjs
   npx wrangler d1 execute odobook --remote --file=scripts/demo-ontime.sql
   ```
2. **Late flags on seeded trips.** The seed enters three weeks of trips in one go, so Odobook (correctly) marks them all late. `scripts/demo-ontime.sql` marks the seeded trips as logged live, except the Lara callout, so the demo shows the flag once. The README says so; it's demo data only.
3. **Run the e2e once** and keep the terminal open for the build section:
   ```
   BASE=https://odobook-alexa.odobook-alexa.workers.dev ADMIN_TOKEN=... npm run test:e2e
   ```
4. **Account-linking clip:** record it separately in a fresh browser profile (no saved passwords, no autofill popups), then cut it in at 0:22.
5. Open the simulator, link the demo account, and clear its chat so the screen starts empty.

## Recording tips

- **Capture:** OBS Studio (Display Capture or Window Capture, 1920x1080, 30 fps, MP4) or Xbox Game Bar (**Win+Alt+R** to start and stop; it records one app window, so keep everything in the browser).
- **Resolution:** 1080p. Browser zoom 125% so the chat text is readable on a phone.
- **Mic:** a headset or a mic 10 to 15 cm from your mouth. Record in a quiet room with soft furnishings; turn off fans. Do a 10-second test and listen back.
- **Screen hygiene:** use the demo account only. Hide the bookmarks bar (Ctrl+Shift+B), close other tabs, turn on Windows Focus / Do Not Disturb, hide the taskbar clock if it shows a date that contradicts the logbook. Never show `.dev.vars`, `.env`, the admin token or the Cloudflare dashboard's secrets.
- **Voice:** speak to the simulator naturally, one sentence, then pause. Continuous voice input auto-sends after 2 seconds of silence, so don't pause mid-sentence for longer than that.
- **Audio:** no music, or royalty-free only (YouTube Audio Library). No copyrighted music, logos or footage.
- **Editing:** cut dead air between turns (keep the reply audio). Add on-screen captions for each utterance and reply; many judges watch muted.
- **Upload:** YouTube, Public or Unlisted, then paste the link in Devpost. Check it plays logged out.

## Shot list

| Time | On screen | Jayden says / does |
|---|---|---|
| 0:00–0:08 | Face cam or a dashboard photo of the HiLux, then title card: "Odobook: a car logbook you talk to". | (Voice-over) "If you drive for work in Australia, the tax office wants a 12-week logbook: every trip, odometer readings and a real purpose. Nobody can type that while driving. So I made it something you say." |
| 0:08–0:14 | Simulator in the browser, demo account linked. Mic button on. | Say: **"Start a work trip to Torquay."** Reply on screen and spoken: *"Work trip to Torquay started at 9:12 am, from 52,907 km. Drive safely."* |
| 0:14–0:22 | Same. Caption: "24 km later". | Say: **"End trip, odometer 52,931. It was for business."** Reply: *"What was the trip for? The tax office needs a specific purpose, like 'site visit at the Werribee depot', not just 'business'."* Caption: "'Business' isn't a purpose, so Odobook refuses it." |
| 0:22–0:30 | Same. | Say: **"Quote for a bathroom renovation in Torquay."** Reply: *"Logged 24 km to Torquay for quote for a bathroom renovation in Torquay. Business use is 82% so far."* Caption: "Business % = business km / odometer distance." |
| 0:30–0:48 | Cut to the account-linking clip: the simulator's **Link account ↗** button, the Odobook "Link Odobook" page (sign in and allow), redirect back, and the status showing linked. | (Voice-over) "Linking works like Alexa+ account linking: OAuth 2.1 with PKCE, a pre-registered client, and my own sign-in page. One sign-in and the assistant can use the logbook, nothing else." |
| 0:48–0:58 | Back to the simulator. | Say: **"Update my logbook, the model is a HiLux SR5."** Reply: *"Updated: car Toyota HiLux SR5."* (Voice-over) "Fix a detail without starting over." |
| 0:58–1:12 | Same. | Say: **"I forgot to log a trip the day before yesterday. 64 km to Bannockburn and back, quoting a rainwater tank install."** Reply: *"Logged a 64 km business trip on [day, date]. It's marked as a late entry. Add the odometer readings if you have them; the ATO asks for them."* Caption: "Entered over 24 hours later, so it's flagged late." |
| 1:12–1:25 | Same. | Say: **"How's my logbook going?"** Reply (if recorded on Fri 23 Oct after the shots above): *"Day 22 of 84, 62 to go. 13 trips, 573 km for work out of 685 km. Business use is 84%. 1 business trip has no odometer readings, which the ATO asks for."* |
| 1:25–1:40 | Same (expand the `export_logbook` call in the MCP calls panel), then `docs/demo-logbook.csv` opened in Excel: date, times, odometer, distance, kind, purpose, destination, late_entry. The simulator shows only the reply text, not the CSV, so the file is exported straight from the demo account; ask Claude to refresh it after recording the voice shots so it has all 13 trips. | Say: **"Export my logbook for my accountant."** Reply: *"Here's your logbook with 13 trips as a CSV file."* (Voice-over) "That's the file a tax agent asks for. Odobook never estimates a deduction; it keeps the records." |
| 1:40–2:10 | Terminal: `npm run test:e2e` against the live URL scrolling PASS lines (bare 401, PRM, S256, no DCR, PKCE token, MCP 2025-11-25, 11 tools, code replay revokes the token), then the latency table. Then `addon-package/addon.json` in the editor. | (Voice-over) "The real Alexa+ add-on toolkit is partner-only, so I built to every published requirement and tested it against the live server: Streamable HTTP, MCP 2025-11-25, OAuth 2.1 with PKCE S256, resource indicators, protected-resource metadata, pre-registered clients, and the bare 401 Alexa+ expects. Every call came back in 65 to 360 milliseconds from Australia, under the 500 ms budget. The add-on manifest follows Amazon's documented fields. A headless-browser test of account linking caught three bugs the API tests couldn't." |
| 2:10–2:20 | `skills/odobook-car-logbook/SKILL.md` in the editor, the tools table and rules. | (Voice-over) "There's also an Agent Skill, so any agent knows the rules: ask for a real purpose, one question at a time while driving, never a dollar figure." |
| 2:20–2:35 | Split: the simulator's startup banner in the terminal (brain `bedrock`, model `global.amazon.nova-2-lite-v1:0`, Region `ap-southeast-2`) and a turn in the MCP calls panel (tool name, arguments, milliseconds), then the GitHub PR page on mcp-voice-simulator. | (Voice-over) "For the AWS Builder challenge, an Amazon Bedrock Converse loop drives the same tools. And for open source, I sent a PR to the voice simulator: voice input that doesn't cut off when you pause, auto-send after two seconds of silence, and your browser's language." |
| 2:35–2:45 | Title card: Odobook logo, live URL, GitHub URL, "Built by Jayden Tebble (TebTally)". | (Voice-over) "Odobook. Say the trip, keep the logbook. Built in two days by a Victorian primary teacher with Claude Code. Thanks for watching." |

## Exact utterances (in order)

1. "Start a work trip to Torquay."
2. "End trip, odometer 52,931. It was for business." (use the seed's printed number + 24)
3. "Quote for a bathroom renovation in Torquay."
4. "Update my logbook, the model is a HiLux SR5."
5. "I forgot to log a trip the day before yesterday. 64 km to Bannockburn and back, quoting a rainwater tank install."
6. "How's my logbook going?"
7. "Export my logbook for my accountant."

If the simulator's model asks for the purpose itself instead of calling `end_trip` with "business" (so the refusal never shows), say: "Just log it as business." The server refuses, and that refusal is the shot.

## If a take goes wrong

- Trip started twice or wrong destination: "Cancel that trip," then start again (cancel_trip).
- Wrong odometer: the server refuses a reading lower than the start; say the right one.
- Numbers don't match the table: they come from the seed. Read whatever Odobook says; don't edit the captions to numbers it didn't say.
