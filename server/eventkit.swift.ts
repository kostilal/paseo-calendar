/**
 * A one-file EventKit command-line helper, kept as a string because a plugin cannot find
 * its own directory (see the caffeine README). eventkit.ts writes this beside the
 * state file and compiles it with swiftc on first use. Subcommands: access, identity,
 * calendars, events, create. Everything it prints is JSON; every failure is
 * `{"error": "..."}` with a non-zero exit.
 */
export const EVENTKIT_SWIFT = String.raw`
import EventKit
import Foundation

let store = EKEventStore()
let iso: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  f.timeZone = TimeZone(identifier: "UTC")
  return f
}()
let allDayFormatter: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd"
  f.locale = Locale(identifier: "en_US_POSIX")
  return f
}()

// EKEvent.startDate/endDate for an all-day event is midnight in the event's own zone, not
// UTC — formatting it with iso (pinned to UTC) and truncating to ten characters reads
// back the previous day for anyone east of UTC, because midnight local is still the
// previous evening in UTC. This reads the same calendar date EventKit itself would show,
// by formatting in that zone (falling back to the machine's own when EventKit reports
// none, which it does for a floating all-day event).
func allDayString(_ date: Date, zone: TimeZone?) -> String {
  allDayFormatter.timeZone = zone ?? TimeZone.current
  return allDayFormatter.string(from: date)
}

// Printed last on every path, so the Node side can tell a finished write from one it has
// merely caught in progress. 'open -W' used to be what told it, and could not be trusted:
// it watches the process with kevent, and this helper exits too quickly to be watched.
// Nothing may print after this marker.
let doneMarker = "__calendar_helper_done__"

func fail(_ message: String) -> Never {
  print("{\"error\": \(jsonString(message))}")
  print(doneMarker)
  exit(1)
}

func jsonString(_ s: String) -> String {
  let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
  let one = String(data: data, encoding: .utf8)!
  return String(one.dropFirst().dropLast()) // strip the [ ]
}

// What the system already thinks, without asking it anything. authorizationStatus never
// raises the dialog, which is what lets the screen tell "never asked" apart from "refused"
// and skip the permission step entirely on a Mac that has already granted it.
func accessStatus() -> String {
  let status = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    switch status {
    case .fullAccess: return "granted"
    // Write-only is not enough for a plugin whose whole job is reading the day.
    case .writeOnly: return "denied"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "unknown"
    @unknown default: return "unknown"
    }
  }
  switch status {
  case .authorized: return "granted"
  case .denied, .restricted: return "denied"
  case .notDetermined: return "unknown"
  @unknown default: return "unknown"
  }
}

// EventKit's async access request, made synchronous for a one-shot CLI.
func requestAccess() -> Bool {
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
  } else {
    store.requestAccess(to: .event) { ok, _ in granted = ok; sem.signal() }
  }
  sem.wait()
  return granted
}

// A source is an account: the Exchange mailbox, the Google account macOS syncs over CalDAV,
// iCloud. Which of them to read is chosen by the person connecting, one account at a time,
// so nothing here filters by type any more — the old .exchange-only rule is exactly what hid
// Google and iCloud from that choice, and what made every system account collapse into one.
func calendarsOf(_ sourceId: String) -> [EKCalendar] {
  store.calendars(for: .event).filter { $0.source.sourceIdentifier == sourceId }
}

func sourceKind(_ type: EKSourceType) -> String {
  switch type {
  case .local: return "local"
  case .exchange: return "exchange"
  // Google and iCloud both arrive as CalDAV; the source title is what tells them apart.
  case .calDAV: return "caldav"
  case .mobileMe: return "icloud"
  case .subscribed: return "subscribed"
  case .birthdays: return "birthdays"
  @unknown default: return "other"
  }
}

// Reached through the calendars rather than store.sources, so a source holding nothing but
// reminders never appears in a calendar picker. Deduplicated by identifier, in first-seen
// order, which keeps the list stable between calls.
func eventSources() -> [[String: Any]] {
  var seen = Set<String>()
  var out: [[String: Any]] = []
  for calendar in store.calendars(for: .event) {
    let source = calendar.source!
    let id = source.sourceIdentifier
    if seen.insert(id).inserted {
      out.append([
        "id": id,
        "title": source.title,
        "kind": sourceKind(source.sourceType),
        "calendars": store.calendars(for: .event).filter { $0.source.sourceIdentifier == id }.count,
      ])
    }
  }
  return out
}

func response(_ status: EKParticipantStatus) -> String {
  switch status {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  default: return "unknown"
  }
}

func emailOf(_ p: EKParticipant) -> String {
  // EventKit hides the address behind a mailto: URL.
  let s = p.url.absoluteString
  return s.hasPrefix("mailto:") ? String(s.dropFirst("mailto:".count)) : s
}

func attendees(_ ev: EKEvent) -> [[String: Any]] {
  guard let people = ev.attendees else { return [] }
  return people.map { p in
    [
      "name": p.name ?? emailOf(p),
      "email": emailOf(p),
      "response": response(p.participantStatus),
      "self": p.isCurrentUser,
      "organiser": p.participantRole == .chair,
    ]
  }
}

// Every occurrence of a recurring series carries the same eventIdentifier — Apple documents
// this, and it is correct for EventKit's own purposes. It is wrong for a board that keys an
// event by {accountId, id}: a daily standup over a fortnight becomes ten rows sharing one
// key, the clash grouping merges them, and all ten draw on the earliest one's day. The
// occurrence date is what tells them apart, so it joins the id for a series and only for a
// series — a one-off event keeps the plain identifier it has always had.
func eventId(_ ev: EKEvent) -> String {
  let base = ev.eventIdentifier ?? UUID().uuidString
  guard ev.hasRecurrenceRules else { return base }
  return "\(base)_\(iso.string(from: ev.occurrenceDate))"
}

func eventJSON(_ ev: EKEvent) -> [String: Any] {
  return [
    "id": eventId(ev),
    "calendarId": ev.calendar.calendarIdentifier,
    "calendarName": ev.calendar.title,
    "title": ev.title ?? "(no title)",
    "start": ev.isAllDay ? allDayString(ev.startDate, zone: ev.timeZone) : iso.string(from: ev.startDate),
    // Still EventKit's own inclusive end (the last day itself) at this point — the Node
    // side (eventkit.ts's parseHelperEvents) pushes it one day forward to match Google's
    // exclusive end.date before this ever becomes an Event; see shared/event.ts.
    "end": ev.isAllDay ? allDayString(ev.endDate, zone: ev.timeZone) : iso.string(from: ev.endDate),
    "allDay": ev.isAllDay,
    "recurring": ev.hasRecurrenceRules,
    // No organiser at all means nobody was called to this: it is time blocked out, and yours.
    "mine": ev.organizer?.isCurrentUser ?? (ev.attendees?.isEmpty ?? true),
    "attendees": attendees(ev),
    "location": ev.location ?? "",
    "description": ev.notes ?? "",
    "conferenceUrl": "",                       // join.ts scans location/notes on the Node side
    "webLink": ev.url?.absoluteString ?? "",
    "myResponse": ev.attendees?.first(where: { $0.isCurrentUser }).map { response($0.participantStatus) } ?? "unknown",
  ]
}

func printJSON(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [])
  print(String(data: data, encoding: .utf8)!)
  print(doneMarker)
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""

switch command {
case "access":
  printJSON(["granted": requestAccess()])

// The one subcommand that deliberately does not call requestAccess(): asking is a separate,
// explicit step now, and this is what the screen uses to decide whether to offer it.
case "status":
  printJSON(["access": accessStatus()])

case "sources":
  guard requestAccess() else { fail("calendar access not granted") }
  printJSON(eventSources())

case "calendars":
  guard requestAccess() else { fail("calendar access not granted") }
  guard args.count >= 3 else { fail("calendars needs <sourceId>") }
  printJSON(calendarsOf(args[2]).map { ["id": $0.calendarIdentifier, "name": $0.title] })

case "events":
  guard requestAccess() else { fail("calendar access not granted") }
  guard args.count >= 5, let from = iso.date(from: args[2]) ?? ISO8601DateFormatter().date(from: args[2]),
        let to = iso.date(from: args[3]) ?? ISO8601DateFormatter().date(from: args[3]) else {
    fail("events needs <fromISO> <toISO> <sourceId>")
  }
  let cals = calendarsOf(args[4])
  let predicate = store.predicateForEvents(withStart: from, end: to, calendars: cals)
  printJSON(store.events(matching: predicate).map { eventJSON($0) })

// Editing an existing event. Deliberately refuses a series: changing one occurrence and
// changing the series are different operations, and .thisEvent on an event whose rules the
// caller did not mean to keep is how a standup gets rewritten forty times over. The Node side
// refuses first; this is the guard that holds even if it did not.
case "update":
  guard requestAccess() else { fail("calendar access not granted") }
  guard args.count >= 3, let data = args[2].data(using: .utf8),
        let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    fail("update needs a JSON argument")
  }
  let wantedEvent = spec["eventId"] as? String ?? ""
  guard let existing = store.event(withIdentifier: wantedEvent) else {
    fail("event not found: \(wantedEvent)")
  }
  if existing.hasRecurrenceRules { fail("this is a repeating event; the series is not edited here") }
  if let t = spec["title"] as? String { existing.title = t }
  if let d = spec["description"] as? String { existing.notes = d }
  if let s = spec["start"] as? String, let d = iso.date(from: s) ?? ISO8601DateFormatter().date(from: s) { existing.startDate = d }
  if let e = spec["end"] as? String, let d = iso.date(from: e) ?? ISO8601DateFormatter().date(from: e) { existing.endDate = d }
  do {
    try store.save(existing, span: .thisEvent)
    printJSON(eventJSON(existing))
  } catch {
    fail("could not save: \(error.localizedDescription)")
  }

// Removing an event. Refuses a series for the same reason update does, and more sharply:
// .removeThisEvent on a series would take every occurrence, and there is nothing to correct
// afterwards.
case "delete":
  guard requestAccess() else { fail("calendar access not granted") }
  guard args.count >= 3 else { fail("delete needs <eventId>") }
  guard let doomed = store.event(withIdentifier: args[2]) else {
    // Already gone is the outcome that was asked for, not a failure.
    printJSON(["deleted": true])
    break
  }
  if doomed.hasRecurrenceRules { fail("this is a repeating event; the series is not deleted here") }
  do {
    try store.remove(doomed, span: .thisEvent)
    printJSON(["deleted": true])
  } catch {
    fail("could not delete: \(error.localizedDescription)")
  }

case "create":
  guard requestAccess() else { fail("calendar access not granted") }
  guard args.count >= 3, let data = args[2].data(using: .utf8),
        let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    fail("create needs a JSON argument")
  }
  let wantedId = spec["calendarId"] as? String ?? ""
  // No "?? store.defaultCalendarForNewEvents" here. That default is typically iCloud, and
  // the confirmation screen has already told the user, in words, which employer calendar
  // this write is going to — falling back silently would write to the wrong one while
  // still looking like it had honoured what the screen said. Stored calendar identifiers
  // go stale when an Exchange account is removed and re-added in System Settings, which is
  // exactly when wantedId stops matching anything here; a refused write the user can read
  // beats a successful write to the wrong place.
  guard let calendar = calendarsOf(spec["sourceId"] as? String ?? "").first(where: { $0.calendarIdentifier == wantedId }) else {
    fail("calendar not found: \(wantedId) — reconnect the account to re-read its calendars")
  }
  let ev = EKEvent(eventStore: store)
  ev.title = spec["title"] as? String ?? "(no title)"
  ev.notes = spec["description"] as? String
  if let s = spec["start"] as? String, let d = iso.date(from: s) ?? ISO8601DateFormatter().date(from: s) { ev.startDate = d }
  if let e = spec["end"] as? String, let d = iso.date(from: e) ?? ISO8601DateFormatter().date(from: e) { ev.endDate = d }
  ev.calendar = calendar
  do {
    try store.save(ev, span: .thisEvent)
    printJSON(eventJSON(ev))
  } catch {
    fail("could not save: \(error.localizedDescription)")
  }

default:
  fail("unknown command: \(command)")
}
`;
