import Foundation

enum AccessFeature: String, Codable, Hashable {
    case premiumFormats
    case premiumModels
}

struct AccessSnapshot: Codable, Equatable {
    let features: Set<AccessFeature>
    let generationCredits: Int
    let freeGenerationsRemaining: Int?
    let allowanceResetsAt: Date?

    static let free = Self(features: [], generationCredits: 0, freeGenerationsRemaining: nil, allowanceResetsAt: nil)
}
