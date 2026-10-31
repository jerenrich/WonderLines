import Foundation

// Increment only when the disclosed data sharing materially changes, never for
// ordinary releases. Consent stays local and is not a tracking permission.
enum PrivacyConsent {
    static let currentVersion = 2
    static let key = "aiSharingConsentVersion"
    static let deletionKey = "accountDeletionPending"
    static let policyURL = URL(string: "https://jerenrich.github.io/WonderLines/privacy.html")!
    static let supportURL = URL(string: "https://jerenrich.github.io/WonderLines/#support")!
    static let emailURL = URL(string: "mailto:jordan.erenrich@gmail.com?subject=Wonder%20Lines%20support")!
}

enum SheetReportReason: String, CaseIterable, Identifiable {
    case sexual, violence, hate, other
    var id: String { rawValue }
    var label: String {
        switch self {
        case .sexual: "Sexual content or nudity"
        case .violence: "Disturbing or violent content"
        case .hate: "Hateful or abusive content"
        case .other: "Another safety concern"
        }
    }
}
struct DeletedAccountResponse: Decodable { let deleted: Bool }
struct SheetReportResponse: Decodable { let reported: Bool }
enum PrivacyActionError: LocalizedError {
    case unavailable, deletionUnconfirmed, localDeletionFailed, reportUnconfirmed
    var errorDescription: String? {
        switch self {
        case .unavailable: "This action is unavailable. Please contact support in Settings."
        case .deletionUnconfirmed: "Account deletion could not be confirmed. Please try again."
        case .localDeletionFailed: "Local account data could not be removed. Please try again."
        case .reportUnconfirmed: "The report could not be sent. Please try again."
        }
    }
}
