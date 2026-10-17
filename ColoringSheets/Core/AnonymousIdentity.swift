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
    func session(register: @escaping @Sendable () async throws -> AnonymousSession,
                 renew: @escaping @Sendable (AnonymousSession) async throws -> AnonymousSession) async throws -> AnonymousSession {
        let saved = try loadSession()
        if let saved, saved.isUsable { return saved }
        if let registration { return try await registration.value }
        let task = Task {
            let created: AnonymousSession
            if let saved {
                created = try await renew(saved)
                guard created.accountID == saved.accountID else { throw GenerationError.configuration }
            } else {
                created = try await register()
            }
            guard created.isUsable else { throw GenerationError.configuration }
            try save(created)
            return created
        }
        registration = task
        defer { registration = nil }
        return try await task.value
    }

    func session() -> AnonymousSession? {
        try? loadSession()
    }

    func sessionForDeletion() async throws -> AnonymousSession? {
        // Renewal may be in flight from a usage lookup. Drain it so it cannot
        // write a saved credential back after deletion. Read failures must not
        // be mistaken for an installation with no account.
        if let registration { _ = try? await registration.value }
        return try loadSession()
    }

    private func loadSession() throws -> AnonymousSession? {
        guard let data = try read() else { return nil }
        guard let saved = try? JSONDecoder().decode(AnonymousSession.self, from: data) else {
            throw GenerationError.configuration
        }
        return saved
    }

    func save(_ session: AnonymousSession) throws {
        let data = try JSONEncoder().encode(session)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw GenerationError.configuration }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            throw GenerationError.configuration
        }
    }

    func deleteSavedSession() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PrivacyActionError.localDeletionFailed }
    }

    func remove() { SecItemDelete(baseQuery() as CFDictionary) }

    private func read() throws -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw GenerationError.configuration }
        return data
    }

    private func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}
