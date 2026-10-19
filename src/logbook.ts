/**
 * Logbook rules, kept free of Workers and database code so they can be tested on their own.
 *
 * AU (ATO logbook method): a period of at least 12 continuous weeks; for each journey the start and
 * end dates, start and end odometer, km and a purpose ("business" alone isn't enough); totals and
 * the business-use percentage for the period. US (IRS mileage log): date, miles, destination and
 * business purpose for each trip, kept for the tax year.
 *
 * Odobook records trips. It isn't tax advice and never works out a dollar deduction.
 */

export type Jurisdiction = "AU" | "US";
export type Unit = "km" | "mi";
export type Kind = "business" | "private";

export interface Logbook {
  id: string;
  jurisdiction: Jurisdiction;
  unit: Unit;
  time_zone: string;
  make: string;
  model: string;
  rego: string;
  engine_cc: number | null;
  start_date: string;
  planned_end: string;
  start_odometer: number;
  closed_at: string | null;
  end_odometer: number | null;
  business_pct: number | null;
}

export interface Trip {
  id: string;
  started_at: string;
  ended_at: string | null;
  start_odometer: number | null;
  end_odometer: number | null;
  distance: number | null;
  kind: Kind | null;
  purpose: string | null;
  destination: string | null;
  source: "live" | "manual";
  entered_at: string;
  late: number;
}

export const DEFAULTS: Record<Jurisdiction, { unit: Unit; timeZone: string; locale: string }> = {
  AU: { unit: "km", timeZone: "Australia/Melbourne", locale: "en-AU" },
  US: { unit: "mi", timeZone: "America/New_York", locale: "en-US" },
};

/** A trip entered more than this long after it ended is marked late. */
export const LATE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Purposes too vague for the ATO (and the IRS): "business" alone isn't a purpose. */
const VAGUE_PURPOSES = new Set(["business", "work", "business trip", "work trip", "job", "for work", "for business"]);

export function isVaguePurpose(purpose: string | null | undefined): boolean {
  if (!purpose) return true;
  return VAGUE_PURPOSES.has(purpose.trim().toLowerCase());
}

/** YYYY-MM-DD plus n days (calendar arithmetic in UTC, so no daylight-saving surprises). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The local calendar date of an instant in a time zone. */
export function localDate(at: Date | string, timeZone: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** The local time of an instant, e.g. "8:42 am". */
export function localTime(at: Date | string, timeZone: string, locale: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(d).toLowerCase();
}

/** AU: 12 weeks (84 days, start day included). US: to the end of the tax year (31 December). */
export function plannedEnd(jurisdiction: Jurisdiction, startDate: string): string {
  return jurisdiction === "AU" ? addDays(startDate, 83) : `${startDate.slice(0, 4)}-12-31`;
}

/** The last day of the Australian income year (1 July – 30 June) that a date falls in. */
export function auIncomeYearEnd(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return `${month >= 7 ? year + 1 : year}-06-30`;
}

export function tripDistance(t: Pick<Trip, "distance" | "start_odometer" | "end_odometer">): number | null {
  if (t.distance != null) return t.distance;
  if (t.start_odometer != null && t.end_odometer != null) return t.end_odometer - t.start_odometer;
  return null;
}

/** The highest odometer reading the logbook knows about. */
export function latestOdometer(logbook: Pick<Logbook, "start_odometer" | "end_odometer">, trips: Trip[]): number {
  let best = logbook.end_odometer ?? logbook.start_odometer;
  for (const t of trips) {
    for (const v of [t.start_odometer, t.end_odometer]) if (v != null && v > best) best = v;
  }
  return best;
}

export interface Summary {
  daysElapsed: number;
  daysLeft: number;
  periodDays: number;
  completedTrips: number;
  businessTrips: number;
  businessDistance: number;
  privateDistance: number;
  totalDistance: number;
  businessPct: number | null;
  activeTrip: Trip | null;
  warnings: string[];
}

/**
 * Totals for a logbook. Total distance comes from the odometer (the latest reading minus the
 * start), because private driving often isn't logged trip by trip; if no reading has moved, it falls
 * back to the sum of logged trips.
 */
export function summarise(logbook: Logbook, trips: Trip[], today: string): Summary {
  const completed = trips.filter((t) => t.ended_at !== null);
  const activeTrip = trips.find((t) => t.ended_at === null) ?? null;
  let businessDistance = 0;
  let privateDistance = 0;
  let businessTrips = 0;
  const warnings: string[] = [];
  let vague = 0;
  let noOdometer = 0;
  let late = 0;
  for (const t of completed) {
    const d = tripDistance(t) ?? 0;
    if (t.kind === "business") {
      businessDistance += d;
      businessTrips += 1;
      if (isVaguePurpose(t.purpose)) vague += 1;
    } else {
      privateDistance += d;
    }
    if (logbook.jurisdiction === "AU" && t.kind === "business" && (t.start_odometer == null || t.end_odometer == null)) noOdometer += 1;
    if (t.late) late += 1;
  }
  const odometerTotal = latestOdometer(logbook, trips) - logbook.start_odometer;
  // Logged trips can outrun the last odometer reading (trips logged by distance only), so never
  // report less than what's been logged.
  const totalDistance = Math.max(odometerTotal, businessDistance + privateDistance);
  const businessPct = logbook.business_pct ?? (totalDistance > 0 ? Math.min(100, (businessDistance / totalDistance) * 100) : null);

  const periodDays = daysBetween(logbook.start_date, logbook.planned_end) + 1;
  const daysElapsed = Math.max(0, Math.min(periodDays, daysBetween(logbook.start_date, today) + 1));
  const daysLeft = Math.max(0, periodDays - daysElapsed);

  if (vague) warnings.push(`${vague} business ${plural(vague, "trip")} ${vague === 1 ? "needs" : "need"} a clearer purpose than just "business".`);
  if (noOdometer) warnings.push(`${noOdometer} business ${plural(noOdometer, "trip")} ${noOdometer === 1 ? "has" : "have"} no odometer readings, which the ATO asks for.`);
  if (late) warnings.push(`${late} ${plural(late, "trip was", "trips were")} entered more than a day late.`);
  if (logbook.jurisdiction === "AU" && logbook.planned_end > auIncomeYearEnd(logbook.start_date)) {
    warnings.push("A first-year logbook must fall within one income year, and this one runs past 30 June.");
  }
  if (activeTrip && Date.now() - Date.parse(activeTrip.started_at) > 12 * 60 * 60 * 1000) {
    warnings.push("A trip has been running for over 12 hours. End it or cancel it.");
  }
  return {
    daysElapsed,
    daysLeft,
    periodDays,
    completedTrips: completed.length,
    businessTrips,
    businessDistance,
    privateDistance,
    totalDistance,
    businessPct,
    activeTrip,
    warnings,
  };
}

/** Was a trip entered more than a day after it ended? */
export function isLate(endedAt: string, enteredAt: string): boolean {
  return Date.parse(enteredAt) - Date.parse(endedAt) > LATE_AFTER_MS;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export function fmtNumber(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
}

/** "84 km", "1 mile", "52 miles". */
export function fmtDistance(n: number, unit: Unit, locale: string): string {
  return unit === "km" ? `${fmtNumber(n, locale)} km` : `${fmtNumber(n, locale)} ${plural(n, "mile")}`;
}

export function fmtPct(p: number | null): string {
  return p == null ? "not known yet" : `${Math.round(p)}%`;
}

/** "Tuesday 20 October" (AU) or "Tuesday, October 20" (US). */
export function fmtDate(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** CSV for the logbook report (RFC 4180 quoting). */
export function toCsv(logbook: Logbook, trips: Trip[]): string {
  const q = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const u = logbook.unit;
  const header = ["date", "start_time", "end_time", `start_odometer_${u}`, `end_odometer_${u}`, `distance_${u}`, "kind", "purpose", "destination", "late_entry"];
  const rows = trips
    .filter((t) => t.ended_at !== null)
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((t) => [
      localDate(t.started_at, logbook.time_zone),
      localTime(t.started_at, logbook.time_zone, "en-GB"),
      t.ended_at ? localTime(t.ended_at, logbook.time_zone, "en-GB") : "",
      t.start_odometer,
      t.end_odometer,
      tripDistance(t),
      t.kind,
      t.purpose,
      t.destination,
      t.late ? "yes" : "",
    ]);
  return [header, ...rows].map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
}
