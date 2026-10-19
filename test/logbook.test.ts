import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  auIncomeYearEnd,
  fmtDistance,
  isLate,
  isVaguePurpose,
  plannedEnd,
  summarise,
  toCsv,
  type Logbook,
  type Trip,
} from "../src/logbook.ts";

const lb = (over: Partial<Logbook> = {}): Logbook => ({
  id: "lb1",
  jurisdiction: "AU",
  unit: "km",
  time_zone: "Australia/Melbourne",
  make: "Toyota",
  model: "Corolla",
  rego: "ABC123",
  engine_cc: 1800,
  start_date: "2026-10-20",
  planned_end: "2027-01-11",
  start_odometer: 50_000,
  closed_at: null,
  end_odometer: null,
  business_pct: null,
  ...over,
});

let n = 0;
const trip = (over: Partial<Trip>): Trip => ({
  id: `t${++n}`,
  started_at: "2026-10-20T21:00:00Z",
  ended_at: "2026-10-20T22:00:00Z",
  start_odometer: null,
  end_odometer: null,
  distance: null,
  kind: "business",
  purpose: "Client meeting at Geelong Hospital",
  destination: "Geelong",
  source: "live",
  entered_at: "2026-10-20T22:00:00Z",
  late: 0,
  ...over,
});

test("AU period is 12 weeks including the start day; US runs to 31 Dec", () => {
  assert.equal(plannedEnd("AU", "2026-10-20"), "2027-01-11");
  assert.equal(addDays("2026-10-20", 83), "2027-01-11");
  assert.equal(plannedEnd("US", "2026-10-20"), "2026-12-31");
});

test("AU income year ends on the next 30 June", () => {
  assert.equal(auIncomeYearEnd("2026-10-20"), "2027-06-30");
  assert.equal(auIncomeYearEnd("2027-03-01"), "2027-06-30");
  assert.equal(auIncomeYearEnd("2027-07-01"), "2028-06-30");
});

test('"business" alone is too vague a purpose', () => {
  assert.equal(isVaguePurpose("Business"), true);
  assert.equal(isVaguePurpose(" work "), true);
  assert.equal(isVaguePurpose(null), true);
  assert.equal(isVaguePurpose("Site visit at Werribee depot"), false);
});

test("business % uses the odometer for total distance, not just logged trips", () => {
  const trips = [
    trip({ start_odometer: 50_000, end_odometer: 50_084, distance: 84 }),
    // 116 km of unlogged private driving happened before this reading
    trip({ start_odometer: 50_200, end_odometer: 50_300, distance: 100, kind: "private", purpose: null }),
  ];
  const s = summarise(lb(), trips, "2026-10-21");
  assert.equal(s.businessDistance, 84);
  assert.equal(s.totalDistance, 300);
  assert.equal(Math.round(s.businessPct!), 28);
  assert.equal(s.daysElapsed, 2);
  assert.equal(s.daysLeft, 82);
});

test("warnings: vague purpose, missing odometer, late entry", () => {
  const trips = [trip({ purpose: "business", distance: 10, late: 1 })];
  const s = summarise(lb(), trips, "2026-10-21");
  assert.equal(s.warnings.length, 3);
  assert.match(s.warnings[0], /clearer purpose/);
  assert.match(s.warnings[1], /odometer/);
  assert.match(s.warnings[2], /late/);
});

test("trips logged by distance only still count toward the total", () => {
  const trips = [
    trip({ start_odometer: 50_000, end_odometer: 50_084, distance: 84 }),
    trip({ distance: 12, kind: "private", purpose: null }),
  ];
  const s = summarise(lb(), trips, "2026-10-20");
  assert.equal(s.totalDistance, 96);
  assert.equal(Math.round(s.businessPct!), 88);
  assert.equal(s.warnings.length, 0); // private trips don't need odometer readings
});

test("a running trip is reported and not counted", () => {
  const trips = [trip({ ended_at: null, start_odometer: 50_000 })];
  const s = summarise(lb(), trips, "2026-10-20");
  assert.equal(s.completedTrips, 0);
  assert.ok(s.activeTrip);
});

test("late means entered more than 24 hours after the trip", () => {
  assert.equal(isLate("2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z"), false);
  assert.equal(isLate("2026-10-20T00:00:00Z", "2026-10-21T00:00:01Z"), true);
});

test("distances read naturally", () => {
  assert.equal(fmtDistance(52_310, "km", "en-AU"), "52,310 km");
  assert.equal(fmtDistance(1, "mi", "en-US"), "1 mile");
  assert.equal(fmtDistance(12, "mi", "en-US"), "12 miles");
});

test("CSV quotes commas and lists completed trips in order", () => {
  const csv = toCsv(lb(), [
    trip({ started_at: "2026-10-21T21:00:00Z", purpose: "Quote, then install", distance: 5 }),
    trip({ started_at: "2026-10-20T21:00:00Z", distance: 7 }),
    trip({ ended_at: null }),
  ]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^date,start_time/);
  assert.match(lines[1], /^2026-10-21,/); // 21:00Z on the 20th is the 21st in Melbourne
  assert.match(lines[2], /"Quote, then install"/);
});
