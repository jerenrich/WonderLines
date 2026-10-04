import SwiftUI

// Only protocol metadata is accepted here. Never pass prompts, response bodies,
// authorization headers, Apple attestations, or localized network errors.
enum DiagnosticContext {
    @TaskLocal static var batchID: UUID?
}

struct DiagnosticEvent: Codable, Identifiable {
    let id: UUID
    let date: Date
    let stage: String
    let outcome: String
    let generationID: UUID?
    let model: String?
    let batchID: UUID?
    let httpStatus: Int?
    let workerCode: String?
    let errorCode: String?

    var moderationSummary: String? {
        switch (workerCode, httpStatus) {
        case ("description_not_suitable", 400): return "Description rejected by content moderation · no sheet allowance used"
        case ("provider_content_rejected", 502): return "Image rejected by provider content moderation · generation may have been charged"
        case ("moderation_unavailable", 503): return "Safety check unavailable · no content decision · no sheet allowance used"
        default: return nil
        }
    }

    var text: String {
        [moderationSummary, metadataText].compactMap { $0 }.joined(separator: " · ")
    }

    var metadataText: String {
        var parts = [stage, outcome]
        if let batchID { parts.append("batch=\(batchID.uuidString.lowercased())") }
        if let model { parts.append("model=\(model)") }
        if let generationID { parts.append("id=\(generationID.uuidString.lowercased())") }
        if let httpStatus { parts.append("HTTP \(httpStatus)") }
        if let workerCode { parts.append("worker=\(workerCode)") }
        if let errorCode { parts.append("error=\(errorCode)") }
        return parts.joined(separator: " · ")
    }
}

@MainActor
final class DiagnosticLog: ObservableObject {
    static let shared = DiagnosticLog()
    static let capacity = 300
    static let retention: TimeInterval = 7 * 86400
    private var persistenceTask: Task<Void, Never>?
    private static let key = "diagnosticEvents.v1"
    @Published private(set) var events: [DiagnosticEvent]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        events = defaults.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode([DiagnosticEvent].self, from: $0) } ?? []
        let originalCount = events.count
        trim()
        if events.count != originalCount {
            defaults.set(try? JSONEncoder().encode(events), forKey: Self.key)
        }
    }

    private let defaults: UserDefaults

    func record(_ stage: String, _ outcome: String, generationID: UUID? = nil,
                model: ImageModel? = nil, httpStatus: Int? = nil,
                workerCode: String? = nil, error: Error? = nil, batchID: UUID? = nil) {
        let code: String?
        if let error {
            let nsError = error as NSError
            // Domains and numeric codes are safe to retain; messages and userInfo are not.
            code = "\(nsError.domain):\(nsError.code)"
        } else { code = nil }
        let event = DiagnosticEvent(id: UUID(), date: Date(), stage: stage, outcome: outcome,
                                    generationID: generationID, model: model?.rawValue, batchID: batchID ?? DiagnosticContext.batchID,
                                    httpStatus: httpStatus, workerCode: workerCode, errorCode: code)
        events.append(event)
        trim()
        // Persist failures and terminal summaries immediately. Coalesce routine
        // events into one write per second instead of rewriting on every event.
        if error != nil || (httpStatus ?? 0) >= 400 || stage == "Batch summary" || stage == "Recovery summary" {
            flush()
        } else if persistenceTask == nil {
            persistenceTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                self?.flush()
            }
        }
    }

    private func trim() {
        let cutoff = Date().addingTimeInterval(-Self.retention)
        events.removeAll { $0.date < cutoff }
        if events.count > Self.capacity { events.removeFirst(events.count - Self.capacity) }
    }

    func flush() {
        persistenceTask?.cancel(); persistenceTask = nil
        trim()
        defaults.set(try? JSONEncoder().encode(events), forKey: Self.key)
    }

    func clear() {
        persistenceTask?.cancel(); persistenceTask = nil
        events = []
        defaults.removeObject(forKey: Self.key)
    }

    var report: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
        let mode = AppConfiguration.load().mock ? "mock" : "live"
        return (["Wonder Lines \(version) (build \(build)) diagnostics", "iOS \(UIDevice.current.systemVersion); mode=\(mode); diagnosticFormat=2", "Times are local to this device. Retention: 7 days, up to \(Self.capacity) events."] +
                events.filter { $0.date > Date().addingTimeInterval(-Self.retention) }.reversed().map { "\($0.date.formatted(date: .numeric, time: .standard)) · \($0.text)" })
            .joined(separator: "\n")
    }
}
