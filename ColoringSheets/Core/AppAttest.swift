import CryptoKit
import DeviceCheck
import Foundation
import Security

/// One device key per anonymous account. Key IDs and enrollment state survive app
/// restarts; the private key stays in the Secure Enclave under DeviceCheck.
actor AppAttestClient {
    private struct Saved: Codable {
        let accountID: UUID
        let keyID: String
        var attested: Bool
    }
    private struct Challenge: Decodable { let challenge: String }
    private struct Status: Decodable { let keyID: String? }
    private struct Attestation: Encodable {
        let challenge: String
        let keyID: String
        let attestation: String
    }
    private struct ClientData: Encodable {
        let challenge: String
        let method: String
        let path: String
        let idempotencyKey: String
        let bodySHA256: String
    }
    private let service = DCAppAttestService.shared
    private let keychainService = "com.jordan.family.ColoringSheets.app-attest"
    private var enrollment: Task<Saved, Error>?

    func proof(accountID: UUID, token: String, serviceURL: URL, session: URLSession,
               idempotencyKey: String, body: Data) async throws -> [String: String]? {
        guard service.isSupported else {
            await DiagnosticLog.shared.record("Device verification", "unsupported on this device")
            return nil
        }
        let saved = try await enrolled(accountID: accountID, token: token, serviceURL: serviceURL, session: session)
        let challenge = try await issueChallenge(purpose: "assertion", token: token, serviceURL: serviceURL, session: session)
        let clientData = try JSONEncoder().encode(ClientData(
            challenge: challenge, method: "POST", path: "/v1/generations", idempotencyKey: idempotencyKey,
            bodySHA256: Self.base64url(Data(SHA256.hash(data: body)))))
        let assertion: Data
        do { assertion = try await service.generateAssertion(saved.keyID, clientDataHash: Data(SHA256.hash(data: clientData))) }
        catch {
            await DiagnosticLog.shared.record("Apple assertion", "failed", error: error)
            throw error
        }
        await DiagnosticLog.shared.record("Apple assertion", "ready")
        return ["X-App-Attest-Client-Data": Self.base64url(clientData),
                "X-App-Attest-Assertion": Self.base64url(assertion)]
    }

    private func enrolled(accountID: UUID, token: String, serviceURL: URL, session: URLSession) async throws -> Saved {
        if let saved = try load(), saved.accountID == accountID, saved.attested { return saved }
        if let enrollment { return try await enrollment.value }
        let task = Task { [self] () throws -> Saved in
            var saved: Saved
            if let previous = try load(), previous.accountID == accountID {
                saved = previous
                // If an attestation response was lost, the server may already
                // hold this key. This read avoids another Apple attestation.
                let remote = try await enrollmentStatus(token: token, serviceURL: serviceURL, session: session)
                if let remote {
                    guard let key = Data(base64Encoded: saved.keyID),
                          remote == Self.base64url(key) else { throw GenerationError.configuration }
                    saved.attested = true
                    try save(saved)
                    return saved
                }
            } else {
                let keyID: String
                do { keyID = try await service.generateKey() }
                catch {
                    await DiagnosticLog.shared.record("Apple key creation", "failed", error: error)
                    throw error
                }
                await DiagnosticLog.shared.record("Apple key creation", "ready")
                saved = Saved(accountID: accountID, keyID: keyID, attested: false)
                try save(saved) // Save before the Apple request so a failed upload can retry.
            }
            let challenge = try await issueChallenge(purpose: "attestation", token: token, serviceURL: serviceURL, session: session)
            let object: Data
            do { object = try await service.attestKey(saved.keyID, clientDataHash: Data(SHA256.hash(data: Data(challenge.utf8)))) }
            catch {
                await DiagnosticLog.shared.record("Apple attestation", "failed", error: error)
                throw error
            }
            await DiagnosticLog.shared.record("Apple attestation", "ready")
            guard let key = Data(base64Encoded: saved.keyID) else { throw GenerationError.configuration }
            var request = URLRequest(url: serviceURL.appending(path: "/v1/app-attest/attest"))
            request.httpMethod = "POST"
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(Attestation(
                challenge: challenge, keyID: Self.base64url(key), attestation: Self.base64url(object)))
            let data: Data
            let response: URLResponse
            do { (data, response) = try await session.data(for: request) }
            catch {
                await DiagnosticLog.shared.record("Worker attestation", "transport failed", error: error)
                throw error
            }
            await DiagnosticLog.shared.record("Worker attestation", "response",
                                              httpStatus: (response as? HTTPURLResponse)?.statusCode,
                                              workerCode: (response as? HTTPURLResponse)
                                                  .flatMap { WorkerClient.workerErrorCode(data, response: $0) })
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw GenerationError.configuration }
            saved.attested = true
            try save(saved)
            return saved
        }
        enrollment = task
        defer { enrollment = nil }
        return try await task.value
    }

    private func enrollmentStatus(token: String, serviceURL: URL, session: URLSession) async throws -> String? {
        var request = URLRequest(url: serviceURL.appending(path: "/v1/app-attest/status"))
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            await DiagnosticLog.shared.record("Attestation status", "transport failed", error: error)
            throw error
        }
        await DiagnosticLog.shared.record("Attestation status", "response",
                                          httpStatus: (response as? HTTPURLResponse)?.statusCode,
                                          workerCode: (response as? HTTPURLResponse)
                                              .flatMap { WorkerClient.workerErrorCode(data, response: $0) })
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 1024 else {
            throw GenerationError.configuration
        }
        return try JSONDecoder().decode(Status.self, from: data).keyID
    }

    private func issueChallenge(purpose: String, token: String, serviceURL: URL,
                                session: URLSession) async throws -> String {
        var request = URLRequest(url: serviceURL.appending(path: "/v1/app-attest/challenge"))
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["purpose": purpose])
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            await DiagnosticLog.shared.record("\(purpose) challenge", "transport failed", error: error)
            throw error
        }
        await DiagnosticLog.shared.record("\(purpose) challenge", "response",
                                          httpStatus: (response as? HTTPURLResponse)?.statusCode,
                                          workerCode: (response as? HTTPURLResponse)
                                              .flatMap { WorkerClient.workerErrorCode(data, response: $0) })
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 1024,
              let challenge = try? JSONDecoder().decode(Challenge.self, from: data).challenge,
              !challenge.isEmpty else { throw GenerationError.configuration }
        return challenge
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
         kSecAttrAccount as String: "current"]
    }
    private func load() throws -> Saved? {
        var request = query()
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data,
              let saved = try? JSONDecoder().decode(Saved.self, from: data) else { throw GenerationError.configuration }
        return saved
    }
    private func save(_ saved: Saved) throws {
        let data = try JSONEncoder().encode(saved)
        let attrs: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query() as CFDictionary, attrs as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw GenerationError.configuration }
        var item = query()
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw GenerationError.configuration }
    }
}
