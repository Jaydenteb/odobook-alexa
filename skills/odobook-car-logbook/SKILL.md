---
name: odobook-car-logbook
description: Keep a car logbook by voice with the Odobook MCP server - start and end work trips, log past trips, check business-use percentage, close and export an ATO 12-week logbook (Australia, km) or an IRS mileage log (US, miles). Use when someone asks to log a drive, start or end a trip, check their car logbook, or work out how much of their driving is for work.
license: MIT
compatibility: Needs the Odobook MCP server (Streamable HTTP, OAuth 2.1 account linking) connected as a tool source.
metadata:
  mcp-server: odobook
  version: "0.1.0"
---

# Odobook car logbook

Odobook keeps the records a tax office expects for work driving. The driver is usually **behind the wheel**, so keep every turn short, spoken and hands-free.

## The tools

| Say | Tool | Notes |
|---|---|---|
| "Start a logbook for my HiLux, rego 1ABC234, odometer 52,310" | `start_logbook` | Once per car and period. AU = 12 weeks, US = to 31 December. |
| "The engine's 2.8 litres" / "I got the rego wrong" | `update_logbook` | Fixes car details. The start odometer can only change before any trip. |
| "Scrap that logbook, wrong car" | `discard_logbook` | Only while it has no trips. Confirm first. **Never close a logbook just to fix a detail.** |
| "Start a work trip to Geelong" | `start_trip` | Odometer defaults to the last reading. Purpose can wait until the end. |
| "End trip, odometer 52,394" / "End trip, I drove 84 km" | `end_trip` | Needs an odometer reading **or** a distance. |
| "I forgot to log yesterday's drive to Ballarat, 112 km, site inspection" | `log_trip` | Past trips. More than a day late gets marked late, which is expected and fine. |
| "Cancel that trip" | `cancel_trip` | Only the running trip. Confirm first. |
| "How's my logbook going?" | `logbook_status` | Days left, business %, and the first thing that needs fixing. |
| "What were my last trips?" | `list_trips` | |
| "Close my logbook, odometer 58,020" | `close_logbook` | Freezes the business %. **Always confirm before calling.** |
| "Send my logbook to my accountant" | `export_logbook` | Returns CSV. |

## Rules that matter

1. **A business trip needs a specific purpose.** "Business" or "work" alone isn't accepted by the ATO or the IRS, and `end_trip` refuses it. Ask: *"What was the trip for?"* Good answers name the job: "quote for a bathroom renovation in Belmont", "client meeting at Barwon Health".
2. **Odometer readings matter in Australia.** For AU business trips, prefer readings at both ends. If the driver only knows the distance, log it, and Odobook will remind them later.
3. **Never estimate a deduction in dollars**, and don't say what's claimable. Odobook keeps records; it isn't tax advice. Suggest ato.gov.au, irs.gov or a registered tax agent.
4. **Read the tool's reply aloud as given.** It's already written for speech. On screens, `structuredContent` has the details.
5. **One question at a time** while driving. If both purpose and odometer are missing, ask for the purpose first. The odometer can come from the dashboard at the next stop.

## Example

> **Driver:** Start a work trip to Geelong.
> → `start_trip { kind: "business", destination: "Geelong" }`
> **Assistant:** "Work trip to Geelong started at 7:59 am, from 52,310 km. Drive safely."
>
> **Driver:** End trip, 52,394.
> → `end_trip { odometer: 52394 }` → refused: needs a purpose
> **Assistant:** "What was the trip for?"
> **Driver:** Quote for a bathroom reno.
> → `end_trip { odometer: 52394, purpose: "Quote for a bathroom reno" }`
> **Assistant:** "Logged 84 km to Geelong for quote for a bathroom reno. Business use is 88% so far."

## Connecting

The MCP endpoint is `https://<deployment>/mcp`. Clients discover the authorization server through `/.well-known/oauth-protected-resource/mcp`, then link the account with OAuth 2.1 authorization code + PKCE (S256) using a pre-registered client ID, the same flow as Alexa+ account linking.
