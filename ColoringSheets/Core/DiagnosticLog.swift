import SwiftUI

// Only protocol metadata is accepted here. Never pass prompts, response bodies,
// authorization headers, Apple attestations, or localized network errors.
struct DiagnosticEvent: Codable, Identifiable {
    let id: UUID
    let date: Date
    let stage: String
    let outcome: String
    let generationID: UUID?
    let model: String?
    let httpStatus: Int?
    let workerCode: String?
    let errorCode: String?

    var text: String {
        var parts = [stage, outcome]
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
    private static let key = "diagnosticEvents.v1"
    @Published private(set) var events: [DiagnosticEvent]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        events = defaults.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode([DiagnosticEvent].self, from: $0) } ?? []
    }

    private let defaults: UserDefaults

    func record(_ stage: String, _ outcome: String, generationID: UUID? = nil,
                model: ImageModel? = nil, httpStatus: Int? = nil,
                workerCode: String? = nil, error: Error? = nil) {
        let code: String?
        if let error {
            let nsError = error as NSError
            // Domains and numeric codes are safe to retain; messages and userInfo are not.
            code = "\(nsError.domain):\(nsError.code)"
        } else { code = nil }
        let event = DiagnosticEvent(id: UUID(), date: Date(), stage: stage, outcome: outcome,
                                    generationID: generationID, model: model?.rawValue,
                                    httpStatus: httpStatus, workerCode: workerCode, errorCode: code)
        events.append(event)
        if events.count > 100 { events.removeFirst(events.count - 100) }
        defaults.set(try? JSONEncoder().encode(events), forKey: Self.key)
    }

    func clear() {
        events = []
        defaults.removeObject(forKey: Self.key)
    }

    var report: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        return (["Wonder Lines \(version) diagnostics", "Times are local to this iPad."] +
                events.reversed().map { "\($0.date.formatted(date: .numeric, time: .standard)) · \($0.text)" })
            .joined(separator: "\n")
    }
}
