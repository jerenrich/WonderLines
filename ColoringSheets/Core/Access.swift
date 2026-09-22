import Foundation
import StoreKit

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

protocol AccessProviding: Sendable {
    func currentAccess() async -> AccessSnapshot
}

/// Local StoreKit state is advisory for the interface. The Worker remains the
/// authority for paid generation access and validates purchases before crediting it.
actor StoreKitEntitlements: AccessProviding {
    static let premiumProductIDs: Set<String> = [] // Add reviewed non-consumable/subscription IDs with the paywall.

    func currentAccess() async -> AccessSnapshot {
        var features = Set<AccessFeature>()
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  Self.premiumProductIDs.contains(transaction.productID) else { continue }
            features.formUnion([.premiumFormats, .premiumModels])
        }
        return AccessSnapshot(features: features, generationCredits: 0, freeGenerationsRemaining: nil, allowanceResetsAt: nil)
    }
}
