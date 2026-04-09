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
    fputs("Usage: apple-reminders <list|complete> [id]\n", stderr)
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
default:
    fputs("Unknown command: \(args[1]). Use 'list' or 'complete'.\n", stderr)
    exit(1)
}
