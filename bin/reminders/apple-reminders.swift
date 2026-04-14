import EventKit
import Foundation

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
let listName = ProcessInfo.processInfo.environment["REMINDERS_LIST"] ?? "New Tasks"
let args = CommandLine.arguments

func printError(_ message: String) -> Never {
    let escaped = message
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    fputs("{\"error\": \"\(escaped)\"}\n", stderr)
    exit(1)
}

func jsonString(_ value: String) -> String {
    // Use JSONSerialization for safe escaping
    if let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
       let str = String(data: data, encoding: .utf8) {
        // Extract the string from the array: ["value"] -> value
        let trimmed = str.dropFirst(2).dropLast(2)
        return String(trimmed)
    }
    // Fallback: basic escaping
    return value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
}

func formatDueDate(_ reminder: EKReminder) -> String? {
    guard let components = reminder.dueDateComponents else { return nil }
    guard let year = components.year, let month = components.month, let day = components.day else { return nil }
    let dateStr = String(format: "%04d-%02d-%02d", year, month, day)
    if let hour = components.hour, let minute = components.minute {
        return String(format: "%@ %02d:%02d", dateStr, hour, minute)
    }
    return dateStr
}

func handleList() {
    store.requestFullAccessToReminders { granted, error in
        guard granted else {
            printError("Reminders access denied. Grant permission in System Settings > Privacy & Security > Reminders.")
        }
        guard let cal = store.calendars(for: .reminder).first(where: { $0.title == listName }) else {
            let available = store.calendars(for: .reminder).map { $0.title }.joined(separator: ", ")
            printError("List '\(listName)' not found. Available: \(available)")
        }
        let pred = store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: nil, calendars: [cal])
        store.fetchReminders(matching: pred) { reminders in
            guard let reminders = reminders else {
                print("[]")
                semaphore.signal()
                return
            }
            var items: [String] = []
            for r in reminders {
                let id = jsonString(r.calendarItemExternalIdentifier)
                let name = jsonString(r.title ?? "")
                var fields = "\"id\": \"\(id)\", \"name\": \"\(name)\""
                if let due = formatDueDate(r) {
                    fields += ", \"due_date\": \"\(due)\""
                } else {
                    fields += ", \"due_date\": null"
                }
                if let notes = r.notes, !notes.isEmpty {
                    fields += ", \"notes\": \"\(jsonString(notes))\""
                } else {
                    fields += ", \"notes\": null"
                }
                items.append("{\(fields)}")
            }
            print("[\(items.joined(separator: ", "))]")
            semaphore.signal()
        }
    }
    semaphore.wait()
}

func handleAdd(_ title: String, dueDate: String?, notes: String?, priority: Int) {
    store.requestFullAccessToReminders { granted, error in
        guard granted else {
            printError("Reminders access denied. Grant permission in System Settings > Privacy & Security > Reminders.")
        }
        let targetList = ProcessInfo.processInfo.environment["REMINDERS_ADD_LIST"] ?? listName
        guard let cal = store.calendars(for: .reminder).first(where: { $0.title == targetList }) else {
            let available = store.calendars(for: .reminder).map { $0.title }.joined(separator: ", ")
            printError("List '\(targetList)' not found. Available: \(available)")
        }
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.calendar = cal
        // EKReminder priority: 1 = high, 5 = medium, 9 = low, 0 = none
        reminder.priority = priority
        if let notes = notes, !notes.isEmpty {
            reminder.notes = notes
        }
        if let due = dueDate {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            var date: Date? = nil
            // Try datetime first, then date-only
            formatter.dateFormat = "yyyy-MM-dd HH:mm"
            date = formatter.date(from: due)
            if date == nil {
                formatter.dateFormat = "yyyy-MM-dd"
                date = formatter.date(from: due)
            }
            if let date = date {
                let components = Calendar.current.dateComponents(
                    [.year, .month, .day, .hour, .minute], from: date)
                reminder.dueDateComponents = components
                // Add an alarm at the due time so the phone actually notifies
                reminder.addAlarm(EKAlarm(absoluteDate: date))
            }
        }
        do {
            try store.save(reminder, commit: true)
            let id = jsonString(reminder.calendarItemExternalIdentifier)
            print("{\"ok\": true, \"id\": \"\(id)\"}")
        } catch {
            printError("Failed to save: \(error.localizedDescription)")
        }
        semaphore.signal()
    }
    semaphore.wait()
}

func handleComplete(_ id: String) {
    store.requestFullAccessToReminders { granted, error in
        guard granted else {
            printError("Reminders access denied. Grant permission in System Settings > Privacy & Security > Reminders.")
        }
        let items = store.calendarItems(withExternalIdentifier: id)
        guard let reminder = items.compactMap({ $0 as? EKReminder }).first else {
            printError("Reminder not found or already completed")
        }
        reminder.isCompleted = true
        do {
            try store.save(reminder, commit: true)
            print("{\"ok\": true}")
        } catch {
            printError("Failed to save: \(error.localizedDescription)")
        }
        semaphore.signal()
    }
    semaphore.wait()
}

// Main dispatch
if args.count < 2 {
    fputs("Usage: apple-reminders <list|complete|add> [args...]\n", stderr)
    exit(1)
}

switch args[1] {
case "list":
    handleList()
case "complete":
    guard args.count >= 3 else {
        fputs("Usage: apple-reminders complete <id>\n", stderr)
        exit(1)
    }
    handleComplete(args[2])
case "add":
    guard args.count >= 3 else {
        fputs("Usage: apple-reminders add <title> [--due YYYY-MM-DD [HH:MM]] [--notes TEXT] [--priority high|medium|low]\n", stderr)
        exit(1)
    }
    let title = args[2]
    var dueDate: String? = nil
    var notes: String? = nil
    var priority: Int = 1 // Default to high so phone actually notifies
    var i = 3
    while i < args.count {
        if args[i] == "--due" && i + 1 < args.count {
            i += 1
            dueDate = args[i]
            // Check if next arg is a time component (HH:MM)
            if i + 1 < args.count && args[i + 1].contains(":") && !args[i + 1].hasPrefix("--") {
                i += 1
                dueDate! += " " + args[i]
            }
        } else if args[i] == "--notes" && i + 1 < args.count {
            i += 1
            notes = args[i]
        } else if args[i] == "--priority" && i + 1 < args.count {
            i += 1
            switch args[i].lowercased() {
            case "high": priority = 1
            case "medium": priority = 5
            case "low": priority = 9
            case "none": priority = 0
            default: priority = 1
            }
        }
        i += 1
    }
    handleAdd(title, dueDate: dueDate, notes: notes, priority: priority)
default:
    fputs("Unknown command: \(args[1]). Use 'list', 'complete', or 'add'.\n", stderr)
    exit(1)
}
