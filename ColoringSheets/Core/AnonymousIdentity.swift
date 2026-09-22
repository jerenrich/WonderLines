import Foundation
import Security

/// An opaque server account held only in the device Keychain. It contains no name,
/// email address, Apple ID, or user-entered profile information.
struct AnonymousSession: Codable, Equatable {
    let accountID: UUID
    let accessToken: String
    let expiresAt: Date

    var isUsable: Bool { expiresAt > Date().addingTimeInterval(60) }
}

actor AnonymousIdentityStore {
    private let service: String
    private let account = "current"
    private var registration: Task<AnonymousSession, Error>?

    init(service: String = "com.jordan.family.ColoringSheets.anonymous-account") {
        self.service = service
    }

    // A batch starts several requests together. They must share one registration
    // and one saved account, including while the network call suspends this actor.
    func session(register: @escaping @Sendable () async throws -> AnonymousSession) async throws -> AnonymousSession {
        if let saved = session(), saved.isUsable { return saved }
        if let registration { return try await registration.value }
        let task = Task {
            let created = try await register()
            try save(created)
            return created
        }
        registration = task
        defer { registration = nil }
        return try await task.value
    }

    func session() -> AnonymousSession? {
        guard let data = read() else { return nil }
        return try? JSONDecoder().decode(AnonymousSession.self, from: data)
    }

    func save(_ session: AnonymousSession) throws {
        let data = try JSONEncoder().encode(session)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            throw GenerationError.configuration
        }
    }

    func remove() { SecItemDelete(baseQuery() as CFDictionary) }

    private func read() -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess else { return nil }
        return value as? Data
    }

    private func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}
