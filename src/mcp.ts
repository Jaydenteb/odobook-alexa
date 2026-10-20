/**
 * The Odobook MCP server: the tools a voice assistant calls. Stateless Streamable HTTP (a fresh
 * server and transport per POST, JSON replies, no sessions), which keeps each call well under the
 * 500 ms Alexa+ budget and needs nothing kept between requests.
 *
 * Replies are written to be spoken: one or two short sentences first, with the details in
 * structuredContent for screens (Echo Show) and for the agent's follow-up questions.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./auth";
import {
  DEFAULTS,
  type Jurisdiction,
  type Kind,
  type Logbook,
  type Trip,
  fmtDate,
  fmtDistance,
  fmtNumber,
  fmtPct,
  isLate,
  isVaguePurpose,
  latestOdometer,
  localDate,
  localTime,
  plannedEnd,
  auIncomeYearEnd,
  summarise,
  toCsv,
  tripDistance,
} from "./logbook";

export interface Props {
  userId: string;
  name: string;
}

const MAX_BODY = 64 * 1024;

const json = (status: number, body: unknown, extra?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

// ---------------------------------------------------------------- data access

const LOGBOOK_COLS =
  "id, jurisdiction, unit, time_zone, make, model, rego, engine_cc, start_date, planned_end, start_odometer, closed_at, end_odometer, business_pct";
const TRIP_COLS =
  "id, started_at, ended_at, start_odometer, end_odometer, distance, kind, purpose, destination, source, entered_at, late";

async function openLogbook(env: Env, userId: string): Promise<Logbook | null> {
  return env.DB.prepare(`SELECT ${LOGBOOK_COLS} FROM logbooks WHERE user_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .bind(userId)
    .first<Logbook>();
}

async function tripsFor(env: Env, logbookId: string): Promise<Trip[]> {
  const { results } = await env.DB.prepare(`SELECT ${TRIP_COLS} FROM trips WHERE logbook_id = ? ORDER BY started_at`).bind(logbookId).all<Trip>();
  return results;
}

/** Tool result: spoken text plus structured details. */
const say = (text: string, details?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text }],
  ...(details ? { structuredContent: details } : {}),
});
const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

const NO_LOGBOOK = refuse(
  "You don't have a logbook running. Start one by giving your car's make, model, rego and odometer reading.",
);

function tripView(t: Trip, lb: Logbook) {
  const locale = DEFAULTS[lb.jurisdiction].locale;
  return {
    id: t.id,
    date: localDate(t.started_at, lb.time_zone),
    start: localTime(t.started_at, lb.time_zone, locale),
    end: t.ended_at ? localTime(t.ended_at, lb.time_zone, locale) : null,
    startOdometer: t.start_odometer,
    endOdometer: t.end_odometer,
    distance: tripDistance(t),
    unit: lb.unit,
    kind: t.kind,
    purpose: t.purpose,
    destination: t.destination,
    late: !!t.late,
  };
}

// ---------------------------------------------------------------- tools

export function createServer(env: Env, props: Props, scopes: string[] = ["logbook:read", "logbook:write"]): McpServer {
  const server = new McpServer(
    { name: "odobook", title: "Odobook car logbook", version: "0.1.0" },
    {
      instructions:
        "Odobook keeps a car logbook by voice: the ATO 12-week logbook (Australia, km) or an IRS mileage log (US, miles). " +
        "Typical flow: start_trip when the driver leaves, end_trip when they arrive. Every business trip needs a specific purpose " +
        '("client meeting at Geelong Hospital"), not just "business"; ask for one if it\'s missing. ' +
        "Read replies aloud as given. Never estimate a tax deduction in dollars; Odobook isn't tax advice.",
    },
  );
  const { userId } = props;

  // Scopes: a token without logbook:write can only use the read-only tools (readOnlyHint).
  const canWrite = scopes.includes("logbook:write");
  const READ_ONLY = refuse("This link only lets me read your logbook. Re-link Odobook and allow changes to log trips.");
  // Same signature as server.registerTool (so tool arguments stay typed), with the scope check in front.
  const register = ((name: string, config: { annotations?: { readOnlyHint?: boolean } }, cb: (...args: unknown[]) => unknown) =>
    server.registerTool(name, config as never, (async (...args: unknown[]) =>
      config.annotations?.readOnlyHint || canWrite ? cb(...args) : READ_ONLY) as never)) as unknown as typeof server.registerTool;

  register(
    "start_logbook",
    {
      title: "Start a logbook",
      description:
        "Start a new logbook for a car: the ATO 12-week logbook (AU) or an IRS mileage log for the tax year (US). " +
        "Needs the car's make, model and registration, and the current odometer reading.",
      inputSchema: {
        make: z.string().min(1).max(40).describe("Car make, e.g. Toyota"),
        model: z.string().min(1).max(40).describe("Car model, e.g. Corolla"),
        rego: z.string().min(1).max(12).describe("Registration / licence plate"),
        odometer: z.number().int().min(0).max(2_000_000).describe("Current odometer reading, whole km or miles"),
        jurisdiction: z.enum(["AU", "US"]).default("AU").describe("AU = ATO logbook in km; US = IRS mileage log in miles"),
        engine_cc: z.number().int().min(50).max(10_000).optional().describe("Engine capacity in cc (the ATO asks for it)"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day, YYYY-MM-DD. Defaults to today."),
        time_zone: z.string().max(60).optional().describe("IANA time zone. Defaults to Australia/Melbourne (AU) or America/New_York (US)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      if (await openLogbook(env, userId)) {
        return refuse("You already have a logbook running. Close it before starting a new one.");
      }
      const j = a.jurisdiction as Jurisdiction;
      const tz = a.time_zone ?? DEFAULTS[j].timeZone;
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
      } catch {
        return refuse(`I don't recognise the time zone ${a.time_zone}.`);
      }
      const start = a.start_date ?? localDate(new Date(), tz);
      const end = plannedEnd(j, start);
      const lb: Logbook = {
        id: crypto.randomUUID(),
        jurisdiction: j,
        unit: DEFAULTS[j].unit,
        time_zone: tz,
        make: a.make.trim(),
        model: a.model.trim(),
        rego: a.rego.trim().toUpperCase(),
        engine_cc: a.engine_cc ?? null,
        start_date: start,
        planned_end: end,
        start_odometer: a.odometer,
        closed_at: null,
        end_odometer: null,
        business_pct: null,
      };
      await env.DB.prepare(
        "INSERT INTO logbooks (id, user_id, jurisdiction, unit, time_zone, make, model, rego, engine_cc, start_date, planned_end, start_odometer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(lb.id, userId, lb.jurisdiction, lb.unit, lb.time_zone, lb.make, lb.model, lb.rego, lb.engine_cc, lb.start_date, lb.planned_end, lb.start_odometer, new Date().toISOString())
        .run();
      const locale = DEFAULTS[j].locale;
      let text =
        j === "AU"
          ? `Your 12-week logbook for the ${lb.make} ${lb.model} starts ${fmtDate(start, locale)} at ${fmtDistance(lb.start_odometer, lb.unit, locale)} and runs to ${fmtDate(end, locale)}.`
          : `Your mileage log for the ${lb.make} ${lb.model} starts ${fmtDate(start, locale)} at ${fmtDistance(lb.start_odometer, lb.unit, locale)}.`;
      if (j === "AU" && end > auIncomeYearEnd(start)) {
        text += " Heads up: it runs past 30 June. A first-year logbook has to fit inside one income year.";
      }
      if (j === "AU" && !lb.engine_cc) text += " The ATO also wants the engine size. Just tell me when you know it.";
      return say(text, { logbookId: lb.id, startDate: start, plannedEnd: end, unit: lb.unit });
    },
  );

  register(
    "update_logbook",
    {
      title: "Fix logbook details",
      description:
        "Add or correct the car's details on the running logbook: engine size, rego, make, model. " +
        "The starting odometer can be corrected only before any trip is logged. Use this instead of closing or restarting a logbook.",
      inputSchema: {
        engine_cc: z.number().int().min(50).max(10_000).optional(),
        rego: z.string().min(1).max(12).optional(),
        make: z.string().min(1).max(40).optional(),
        model: z.string().min(1).max(40).optional(),
        start_odometer: z.number().int().min(0).max(2_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const locale = DEFAULTS[lb.jurisdiction].locale;
      if (a.start_odometer != null) {
        const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM trips WHERE logbook_id = ?").bind(lb.id).first<number>("n");
        if (n) return refuse("The starting odometer can't change once trips are logged, because every trip builds on it.");
      }
      const next = {
        engine_cc: a.engine_cc ?? lb.engine_cc,
        rego: a.rego?.trim().toUpperCase() ?? lb.rego,
        make: a.make?.trim() ?? lb.make,
        model: a.model?.trim() ?? lb.model,
        start_odometer: a.start_odometer ?? lb.start_odometer,
      };
      await env.DB.prepare("UPDATE logbooks SET engine_cc = ?, rego = ?, make = ?, model = ?, start_odometer = ? WHERE id = ?")
        .bind(next.engine_cc, next.rego, next.make, next.model, next.start_odometer, lb.id)
        .run();
      const changed: string[] = [];
      if (a.engine_cc != null) changed.push(`the engine size to ${fmtNumber(a.engine_cc, locale)} cc`);
      if (a.rego) changed.push(`the rego to ${next.rego}`);
      if (a.make || a.model) changed.push(`the car to ${next.make} ${next.model}`);
      if (a.start_odometer != null) changed.push(`the starting odometer to ${fmtDistance(next.start_odometer, lb.unit, locale)}`);
      const list = changed.length > 1 ? `${changed.slice(0, -1).join(", ")} and ${changed.at(-1)}` : changed[0];
      return say(changed.length ? `Done, I've updated ${list}.` : "There was nothing to change.", { car: `${next.make} ${next.model} (${next.rego})`, engineCc: next.engine_cc });
    },
  );

  register(
    "discard_logbook",
    {
      title: "Discard an empty logbook",
      description:
        "Delete the running logbook so the driver can start again, only while it has no completed trips (e.g. set up with the wrong car). " +
        "Confirm with the driver first. Once trips exist, use update_logbook or close_logbook instead.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM trips WHERE logbook_id = ? AND ended_at IS NOT NULL").bind(lb.id).first<number>("n");
      if (n) return refuse(`This logbook has ${n} ${n === 1 ? "trip" : "trips"}, so I won't delete it. I can fix its details instead.`);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM trips WHERE logbook_id = ?").bind(lb.id),
        env.DB.prepare("DELETE FROM logbooks WHERE id = ?").bind(lb.id),
      ]);
      return say(`Okay, I've deleted the empty logbook for the ${lb.make} ${lb.model}. You can start a new one.`);
    },
  );

  register(
    "start_trip",
    {
      title: "Start a trip",
      description:
        "Start timing a trip now, when the driver sets off. Purpose and destination can be given now or when the trip ends. " +
        "The odometer defaults to the last reading Odobook knows.",
      inputSchema: {
        kind: z.enum(["business", "private"]).optional().describe("business (work) or private"),
        purpose: z.string().max(200).optional().describe('Why: e.g. "client meeting with Barwon Health"'),
        destination: z.string().max(200).optional().describe("Where to, e.g. Geelong"),
        odometer: z.number().int().min(0).max(2_000_000).optional().describe("Odometer now, if the driver says it"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const trips = await tripsFor(env, lb.id);
      const active = trips.find((t) => t.ended_at === null);
      if (active) {
        return refuse(
          `A trip is already running since ${localTime(active.started_at, lb.time_zone, DEFAULTS[lb.jurisdiction].locale)}. End it or cancel it first.`,
        );
      }
      const last = latestOdometer(lb, trips);
      if (a.odometer != null && a.odometer < last) {
        return refuse(`The odometer can't go backwards: the last reading was ${fmtDistance(last, lb.unit, DEFAULTS[lb.jurisdiction].locale)}.`);
      }
      const now = new Date().toISOString();
      const odo = a.odometer ?? last;
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO trips (id, logbook_id, user_id, started_at, start_odometer, kind, purpose, destination, source, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)",
      )
        .bind(id, lb.id, userId, now, odo, a.kind ?? null, a.purpose?.trim() || null, a.destination?.trim() || null, now)
        .run();
      const locale = DEFAULTS[lb.jurisdiction].locale;
      const what = a.kind === "private" ? "Private trip" : a.kind === "business" ? "Work trip" : "Trip";
      const where = a.destination ? ` to ${a.destination.trim()}` : "";
      return say(`${what}${where} started at ${localTime(now, lb.time_zone, locale)}, from ${fmtDistance(odo, lb.unit, locale)}. Drive safely.`, {
        tripId: id,
        startOdometer: odo,
      });
    },
  );

  register(
    "end_trip",
    {
      title: "End the current trip",
      description:
        "End the running trip. Needs either the odometer reading now or the distance driven. " +
        "Business trips need a specific purpose; if the driver hasn't given one, ask before calling.",
      inputSchema: {
        odometer: z.number().int().min(0).max(2_000_000).optional().describe("Odometer reading now"),
        distance: z.number().int().min(0).max(5_000).optional().describe("Distance driven, if no odometer reading"),
        kind: z.enum(["business", "private"]).optional(),
        purpose: z.string().max(200).optional(),
        destination: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const locale = DEFAULTS[lb.jurisdiction].locale;
      const trip = await env.DB.prepare(`SELECT ${TRIP_COLS} FROM trips WHERE logbook_id = ? AND ended_at IS NULL LIMIT 1`).bind(lb.id).first<Trip>();
      if (!trip) return refuse("No trip is running. You can log a past trip instead.");
      if (a.odometer == null && a.distance == null) return refuse("What's the odometer reading now, or how far did you drive?");
      let endOdo: number | null = a.odometer ?? null;
      if (endOdo == null && trip.start_odometer != null) endOdo = trip.start_odometer + a.distance!;
      if (endOdo != null && trip.start_odometer != null && endOdo < trip.start_odometer) {
        return refuse(`That's lower than the start reading of ${fmtDistance(trip.start_odometer, lb.unit, locale)}. Check the odometer again?`);
      }
      const distance = endOdo != null && trip.start_odometer != null ? endOdo - trip.start_odometer : a.distance!;
      if (distance > 3_000) return refuse(`That's ${fmtDistance(distance, lb.unit, locale)} in one trip. Check the reading?`);
      const purpose = a.purpose?.trim() || trip.purpose;
      // A purpose implies work; with neither a kind nor a purpose, ask rather than guess.
      const kind = (a.kind ?? trip.kind ?? (purpose ? "business" : null)) as Kind | null;
      if (!kind) return refuse("Was that a work trip or a private one? If it was for work, what was it for?");
      const destination = a.destination?.trim() || trip.destination;
      if (kind === "business" && isVaguePurpose(purpose)) {
        return refuse('What was the trip for? The tax office needs a specific purpose, like "site visit at the Werribee depot", not just "business".');
      }
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE trips SET ended_at = ?, end_odometer = ?, distance = ?, kind = ?, purpose = ?, destination = ? WHERE id = ?")
        .bind(now, endOdo, distance, kind, purpose ?? null, destination ?? null, trip.id)
        .run();
      const trips = await tripsFor(env, lb.id);
      const s = summarise(lb, trips, localDate(new Date(), lb.time_zone));
      const where = destination ? ` to ${destination}` : "";
      // "for Quote for a bathroom" reads oddly; lower-case a capitalised first word, but not an acronym or name-like "ACME".
      const spokenPurpose = purpose && /^[A-Z][a-z]/.test(purpose) ? purpose[0].toLowerCase() + purpose.slice(1) : purpose;
      const text =
        kind === "business"
          ? `Logged ${fmtDistance(distance, lb.unit, locale)}${where} for ${spokenPurpose}. Business use is ${fmtPct(s.businessPct)} so far.`
          : `Logged a ${fmtDistance(distance, lb.unit, locale)} private trip${where}.`;
      return say(text, { trip: tripView({ ...trip, ended_at: now, end_odometer: endOdo, distance, kind, purpose, destination }, lb), businessPct: s.businessPct });
    },
  );

  register(
    "log_trip",
    {
      title: "Log a past trip",
      description:
        "Record a trip that already happened (forgot to start it, or entering from notes). " +
        "Trips entered more than a day after they happened are marked late, as the ATO expects.",
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Day of the trip, YYYY-MM-DD"),
        kind: z.enum(["business", "private"]),
        purpose: z.string().max(200).optional(),
        destination: z.string().max(200).optional(),
        start_odometer: z.number().int().min(0).max(2_000_000).optional(),
        end_odometer: z.number().int().min(0).max(2_000_000).optional(),
        distance: z.number().int().min(0).max(5_000).optional().describe("Use when there are no odometer readings"),
        start_time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("HH:MM local, if known"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const locale = DEFAULTS[lb.jurisdiction].locale;
      if (a.date < lb.start_date || a.date > lb.planned_end) {
        return refuse(`That date is outside this logbook, which runs ${fmtDate(lb.start_date, locale)} to ${fmtDate(lb.planned_end, locale)}.`);
      }
      const today = localDate(new Date(), lb.time_zone);
      if (a.date > today) return refuse("That date is in the future.");
      if (a.kind === "business" && isVaguePurpose(a.purpose)) {
        return refuse('What was the trip for? It needs a specific purpose, not just "business".');
      }
      let distance: number | null = null;
      if (a.start_odometer != null && a.end_odometer != null) {
        if (a.end_odometer < a.start_odometer) return refuse("The end reading is lower than the start reading.");
        distance = a.end_odometer - a.start_odometer;
      } else if (a.distance != null) {
        distance = a.distance;
      } else {
        return refuse("How far was it? Give the start and end odometer, or the distance.");
      }
      // Local wall-clock time to UTC: find the zone's offset at that moment, then shift.
      const wall = Date.parse(`${a.date}T${a.start_time ?? "12:00"}:00Z`);
      const zoned = Date.parse(
        new Date(wall).toLocaleString("sv-SE", { timeZone: lb.time_zone }).replace(" ", "T") + "Z",
      );
      const startedAt = new Date(wall - (zoned - wall)).toISOString();
      const now = new Date().toISOString();
      const endOfDay = new Date(Date.parse(startedAt) + 12 * 3600_000).toISOString();
      const late = isLate(endOfDay, now) ? 1 : 0;
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO trips (id, logbook_id, user_id, started_at, ended_at, start_odometer, end_odometer, distance, kind, purpose, destination, source, entered_at, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)",
      )
        .bind(id, lb.id, userId, startedAt, startedAt, a.start_odometer ?? null, a.end_odometer ?? null, distance, a.kind, a.purpose?.trim() || null, a.destination?.trim() || null, now, late)
        .run();
      let text = `Logged a ${fmtDistance(distance, lb.unit, locale)} ${a.kind} trip on ${fmtDate(a.date, locale)}.`;
      if (late) text += " It's marked as a late entry.";
      if (lb.jurisdiction === "AU" && a.kind === "business" && (a.start_odometer == null || a.end_odometer == null)) {
        text += " Add the odometer readings if you have them; the ATO asks for them.";
      }
      return say(text, { tripId: id, late: !!late });
    },
  );

  register(
    "cancel_trip",
    {
      title: "Cancel the running trip",
      description: "Throw away the trip that's running now (started by mistake). Completed trips are kept. Confirm with the driver first.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const r = await env.DB.prepare("DELETE FROM trips WHERE logbook_id = ? AND ended_at IS NULL").bind(lb.id).run();
      return say(r.meta.changes ? "Okay, I've cancelled the running trip." : "There's no trip running.");
    },
  );

  register(
    "logbook_status",
    {
      title: "Logbook status",
      description:
        "How the logbook is going: days left, trips, business and total distance, business-use percentage, a running trip, and anything that needs fixing.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const trips = await tripsFor(env, lb.id);
      const s = summarise(lb, trips, localDate(new Date(), lb.time_zone));
      const locale = DEFAULTS[lb.jurisdiction].locale;
      const parts = [
        lb.jurisdiction === "AU"
          ? `Day ${s.daysElapsed} of ${s.periodDays}, ${s.daysLeft} to go.`
          : `${s.daysLeft} days left in the tax year.`,
        `${s.completedTrips} ${s.completedTrips === 1 ? "trip" : "trips"}, ${fmtDistance(s.businessDistance, lb.unit, locale)} for work out of ${fmtDistance(s.totalDistance, lb.unit, locale)}.`,
        `Business use is ${fmtPct(s.businessPct)}.`,
      ];
      if (s.activeTrip) parts.push(`A trip is running since ${localTime(s.activeTrip.started_at, lb.time_zone, locale)}.`);
      if (s.warnings.length) parts.push(s.warnings[0]);
      return say(parts.join(" "), {
        car: `${lb.make} ${lb.model} (${lb.rego})`,
        jurisdiction: lb.jurisdiction,
        unit: lb.unit,
        period: { start: lb.start_date, end: lb.planned_end, daysElapsed: s.daysElapsed, daysLeft: s.daysLeft },
        trips: s.completedTrips,
        businessDistance: s.businessDistance,
        totalDistance: s.totalDistance,
        businessPct: s.businessPct == null ? null : Math.round(s.businessPct * 10) / 10,
        activeTrip: s.activeTrip ? tripView(s.activeTrip, lb) : null,
        warnings: s.warnings,
      });
    },
  );

  register(
    "list_trips",
    {
      title: "List recent trips",
      description: "The most recent trips in the logbook, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(5) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const trips = (await tripsFor(env, lb.id)).filter((t) => t.ended_at !== null).reverse().slice(0, limit);
      if (!trips.length) return say("No trips logged yet.", { trips: [] });
      const locale = DEFAULTS[lb.jurisdiction].locale;
      const views = trips.map((t) => tripView(t, lb));
      const spoken = views
        .slice(0, 3)
        .map((v) => `${fmtDate(v.date, locale)}: ${fmtDistance(v.distance ?? 0, lb.unit, locale)} ${v.kind}${v.destination ? ` to ${v.destination}` : ""}`)
        .join(". ");
      return say(`Your latest trips. ${spoken}.`, { trips: views });
    },
  );

  register(
    "close_logbook",
    {
      title: "Close the logbook",
      description:
        "Finish the logbook period with the final odometer reading. This freezes the business-use percentage. Confirm with the driver first.",
      inputSchema: { odometer: z.number().int().min(0).max(2_000_000).describe("Final odometer reading") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ odometer }) => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const trips = await tripsFor(env, lb.id);
      if (trips.some((t) => t.ended_at === null)) return refuse("A trip is still running. End it first.");
      const last = latestOdometer(lb, trips);
      const locale = DEFAULTS[lb.jurisdiction].locale;
      if (odometer < last) return refuse(`That's lower than the last reading of ${fmtDistance(last, lb.unit, locale)}.`);
      const s = summarise({ ...lb, end_odometer: odometer }, trips, localDate(new Date(), lb.time_zone));
      // Same rule as logbook_status, so the frozen figure matches the last one the driver heard.
      const total = s.totalDistance;
      const pct = s.businessPct ?? 0;
      await env.DB.prepare("UPDATE logbooks SET closed_at = ?, end_odometer = ?, business_pct = ? WHERE id = ?")
        .bind(new Date().toISOString(), odometer, pct, lb.id)
        .run();
      let text = `Logbook closed. ${fmtDistance(total, lb.unit, locale)} in total, ${fmtDistance(s.businessDistance, lb.unit, locale)} for work: business use of ${fmtPct(pct)}.`;
      if (lb.jurisdiction === "AU" && s.daysElapsed < 84) text += ` Note it ran ${s.daysElapsed} days; the ATO asks for at least 12 weeks.`;
      return say(text, { businessPct: Math.round(pct * 10) / 10, totalDistance: total, businessDistance: s.businessDistance, warnings: s.warnings });
    },
  );

  register(
    "export_logbook",
    {
      title: "Export the logbook",
      description: "The logbook as CSV (date, times, odometer readings, distance, kind, purpose, destination, late entries) for a tax agent.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const lb = await openLogbook(env, userId);
      if (!lb) return NO_LOGBOOK;
      const trips = await tripsFor(env, lb.id);
      const csv = toCsv(lb, trips);
      return {
        content: [
          { type: "text" as const, text: `Here's your logbook with ${trips.filter((t) => t.ended_at).length} trips as a CSV file.` },
          { type: "resource" as const, resource: { uri: `odobook://logbook/${lb.id}.csv`, mimeType: "text/csv", text: csv } },
        ],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------- HTTP handler for /mcp

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props; auth?: { scope?: string[] } }): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { error: "request too large" });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    if (Array.isArray(body)) return json(400, { jsonrpc: "2.0", error: { code: -32600, message: "Batches aren't supported" }, id: null });

    const server = createServer(env, ctx.props, ctx.auth?.scope?.length ? ctx.auth.scope : undefined);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, { parsedBody: body });
    } finally {
      await server.close();
    }
  },
};
