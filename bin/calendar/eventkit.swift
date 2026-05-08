// EventKit adapter — read-only fetch of calendar events for the
// Chief of Staff Calendar surface (PRD-111). Same JSON shape as the
// Rust ICS parser so the two transports are interchangeable on the
// wire.
//
// CLI:
//   eventkit list --from YYYY-MM-DD --to YYYY-MM-DD
//
// Both args are required; range is inclusive on both ends. Output is
// a JSON array of events on stdout. Errors go to stderr as JSON
// `{"error": "..."}` with exit code 1.
//
// Permission: requires Calendars access. On first run macOS prompts
// the user; if they decline, this binary exits with an error and the
// caller falls back to ICS.

import EventKit
import Foundation

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
let args = CommandLine.arguments

func printError(_ message: String) -> Never {
    let escaped = message
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    fputs("{\"error\": \"\(escaped)\"}\n", stderr)
    exit(1)
}

func parseDay(_ s: String) -> Date? {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = TimeZone.current
    return f.date(from: s)
}

func isoUtc(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone(secondsFromGMT: 0)
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: date)
}

func parsedFlag(_ name: String) -> String? {
    guard let idx = args.firstIndex(of: name), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

func encodeEvent(_ ev: EKEvent) -> [String: Any] {
    let attendees: [String] = (ev.attendees ?? []).compactMap { att in
        if let url = att.url as URL?, url.scheme?.lowercased() == "mailto" {
            return url.absoluteString
                .replacingOccurrences(of: "mailto:", with: "")
                .removingPercentEncoding ?? url.absoluteString
        }
        return att.name
    }
    let organizer: String? = {
        guard let p = ev.organizer else { return nil }
        if let url = p.url as URL?, url.scheme?.lowercased() == "mailto" {
            return url.absoluteString
                .replacingOccurrences(of: "mailto:", with: "")
                .removingPercentEncoding ?? url.absoluteString
        }
        return p.name
    }()
    let status: String? = {
        switch ev.status {
        case .confirmed: return "confirmed"
        case .tentative: return "tentative"
        case .canceled: return "cancelled"
        default: return nil
        }
    }()

    var dict: [String: Any] = [
        "uid": ev.eventIdentifier ?? "ek-\(ev.startDate.timeIntervalSince1970)",
        "summary": ev.title ?? "(no title)",
        "start": isoUtc(ev.startDate),
        "end": isoUtc(ev.endDate),
        "all_day": ev.isAllDay,
        "attendees": attendees,
    ]
    if let l = ev.location, !l.isEmpty { dict["location"] = l }
    if let n = ev.notes, !n.isEmpty { dict["description"] = n }
    if let o = organizer { dict["organizer"] = o }
    if let s = status { dict["status"] = s }
    return dict
}

func handleList() {
    // `??` doesn't compose with `Never` in Swift — use guard let.
    guard let fromArg = parsedFlag("--from") else {
        printError("missing --from YYYY-MM-DD")
    }
    guard let toArg = parsedFlag("--to") else {
        printError("missing --to YYYY-MM-DD")
    }
    guard let fromDate = parseDay(fromArg) else { printError("invalid --from") }
    guard var toDate = parseDay(toArg) else { printError("invalid --to") }

    // Make `to` exclusive at end-of-day so a single-day range covers the
    // whole day, not just midnight.
    let cal = Calendar(identifier: .gregorian)
    toDate = cal.date(byAdding: .day, value: 1, to: toDate) ?? toDate

    store.requestFullAccessToEvents { granted, error in
        guard granted else {
            printError("Calendars access denied. Grant in System Settings > Privacy & Security > Calendars.")
        }
        let calendars = store.calendars(for: .event)
        let predicate = store.predicateForEvents(withStart: fromDate, end: toDate, calendars: calendars)
        let events = store.events(matching: predicate)
        let payload = events.map(encodeEvent)
        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        } catch {
            printError("encode failed: \(error.localizedDescription)")
        }
        semaphore.signal()
    }
    semaphore.wait()
}

guard args.count >= 2 else {
    printError("usage: eventkit list --from YYYY-MM-DD --to YYYY-MM-DD")
}

switch args[1] {
case "list":
    handleList()
default:
    printError("unknown command: \(args[1])")
}
