import XCTest
@testable import ColoringSheets

/// Opt-in only. Standard test runs skip this test and never send paid requests.
final class LiveIntegrationTests: XCTestCase {
    @MainActor
    func testExplicitBuild9ParallelGenerationAndConsent() async throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_BUILD9_CHECK"] == "one-batch" else {
            throw XCTSkip("Build 9 physical verification requires explicit one-batch opt-in.")
        }
        let configuration = AppConfiguration.load()
        XCTAssertFalse(configuration.mock)
        guard !configuration.mock else { return }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LiveVerification", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let claim = directory.appendingPathComponent("build9-one-batch-claimed")
        guard !FileManager.default.fileExists(atPath: claim.path) else {
            throw XCTSkip("This installation has already claimed its build 9 batch.")
        }
        try Data("claimed".utf8).write(to: claim, options: .withoutOverwriting)
        let suite = "Build9Live-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set(1, forKey: PrivacyConsent.key)
        defer { defaults.removePersistentDomain(forName: suite) }
        let identities = AnonymousIdentityStore(service: suite)
        let attestation = AppAttestClient(keychainService: suite + ".app-attest")
        defer { Task { try? await attestation.clearLocalEnrollment() } }
        let client = WorkerClient(serviceURL: configuration.serviceURL, identities: identities,
                                  pendingStore: PendingGenerationStore(defaults: defaults), appAttest: attestation)
        let gallery = GalleryStore(url: directory.appendingPathComponent("build9-test-gallery.json"))
        defer { try? gallery.remove() }
        let store = ColoringViewModel(service: client, isMock: false, defaults: defaults, galleryStore: gallery)
        store.description = "A friendly dinosaur riding a bicycle on the moon"
        store.setImageCount(3)
        store.generate()
        XCTAssertTrue(store.showsConsent)
        XCTAssertFalse(store.hasConsent)
        let beforeConsent = await identities.session()
        XCTAssertNil(beforeConsent, "Old consent must send no registration or generation request.")
        store.acceptConsent()
        let deadline = ContinuousClock.now + .seconds(240)
        while store.isGenerating && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(250))
        }
        do {
            XCTAssertFalse(store.isGenerating)
            XCTAssertEqual(store.results.count, 3, "All default sheets must arrive: \(store.phase)")
            XCTAssertTrue(store.hasConsent)
            let ids = store.results.compactMap { $0.generationID?.uuidString.lowercased() }
            XCTAssertEqual(Set(ids).count, 3)
            for (index, result) in store.results.enumerated() {
                let attachment = XCTAttachment(image: result.image)
                attachment.name = "Build 9 real iOS 27.2 sheet \(index + 1)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            let receipt: [String: Any] = ["version": "1.0", "build": "9", "generationIDs": ids,
                "sheetCount": store.results.count, "consentVersion": PrivacyConsent.currentVersion,
                "finishedAt": ISO8601DateFormatter().string(from: Date())]
            let data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: directory.appendingPathComponent("build9-live-verification.json"), options: .atomic)
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "Build 9 generation receipt"; attachment.lifetime = .keepAlways; add(attachment)
            try await client.deleteAccount()
            let saved = await identities.session()
            XCTAssertNil(saved)
        } catch {
            store.cancel()
            try? await client.deleteAccount()
            throw error
        }
    }
    @MainActor
    func testExplicitBuild7GenerationReportingAndDeletion() async throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_BUILD7_CHECK"] == "one-sheet" else {
            throw XCTSkip("Build 7 live verification requires explicit opt-in.")
        }
        let configuration = AppConfiguration.load()
        XCTAssertFalse(configuration.mock)
        guard !configuration.mock else { return }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LiveVerification", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let claim = directory.appendingPathComponent("build7-one-sheet-claimed")
        guard !FileManager.default.fileExists(atPath: claim.path) else {
            throw XCTSkip("This installation has already claimed its build 7 live check.")
        }
        try Data("claimed".utf8).write(to: claim, options: .withoutOverwriting)
        let suite = "Build7Live-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        // Isolate credentials, pending work and gallery from the user's account.
        let identities = AnonymousIdentityStore(service: suite)
        let client = WorkerClient(serviceURL: configuration.serviceURL, identities: identities,
                                  pendingStore: PendingGenerationStore(defaults: defaults))
        let gallery = GalleryStore(url: directory.appendingPathComponent("build7-test-gallery.json"))
        defer { try? gallery.remove() }
        let store = ColoringViewModel(service: client, isMock: false, defaults: defaults, galleryStore: gallery)
        store.description = "A friendly flower in a garden"
        store.setImageCount(1)
        store.generate()
        XCTAssertTrue(store.showsConsent)
        let beforeConsent = await identities.session()
        XCTAssertNil(beforeConsent)
        store.acceptConsent()
        let deadline = ContinuousClock.now + .seconds(240)
        while store.isGenerating && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(250))
        }
        do {
            XCTAssertFalse(store.isGenerating)
            let result = try XCTUnwrap(store.result, "Live generation must return a sheet: \(store.phase)")
            let id = try XCTUnwrap(result.generationID)
            let attachment = XCTAttachment(image: result.image)
            attachment.name = "Build 7 physical iPad live sheet"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTAssertTrue(store.hasConsent)
            let relaunched = ColoringViewModel(service: client, isMock: false, defaults: defaults, galleryStore: gallery)
            XCTAssertTrue(relaunched.hasConsent, "Consent must survive relaunch without another prompt.")
            await store.reportSelectedSheet(reason: .other)
            XCTAssertTrue(store.results.isEmpty)
            do {
                _ = try await client.recoverPending(PendingGeneration(id: id, model: result.requestedModel, createdAt: Date()))
                XCTFail("Reported sheets must remain unavailable for recovery.")
            } catch { /* Expected: the service blocks the reported sheet. */ }
            try await client.deleteAccount()
            let saved = await identities.session()
            XCTAssertNil(saved)
            try await client.deleteAccount() // Idempotent; must not register again.
        } catch {
            store.cancel()
            try? await client.deleteAccount()
            throw error
        }
    }

    @MainActor
    func testExplicitOneGenerationThroughFirstUseState() async throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_LIVE_CHECK"] == "one-generation" else {
            throw XCTSkip("One live first-use generation requires explicit opt-in.")
        }
        let configuration = AppConfiguration.load()
        XCTAssertFalse(configuration.mock)
        guard !configuration.mock else { return }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LiveVerification", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // A runner restart cannot accidentally repeat this paid smoke check.
        let claim = directory.appendingPathComponent("first-use-2026-10-17-claimed")
        guard !FileManager.default.fileExists(atPath: claim.path) else {
            throw XCTSkip("This installation has already claimed its one-generation check.")
        }
        try Data("claimed".utf8).write(to: claim, options: .withoutOverwriting)
        let suite = "LiveFirstUse-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set(PrivacyConsent.currentVersion, forKey: PrivacyConsent.key)
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ColoringViewModel(service: WorkerClient(serviceURL: configuration.serviceURL),
                                      isMock: false, defaults: defaults)
        XCTAssertEqual(store.age, 6)
        store.setImageCount(1)
        store.description = "A friendly dinosaur riding a bicycle on the moon"
        XCTAssertNil(store.validationMessage)
        store.generate()
        let deadline = ContinuousClock.now + .seconds(240)
        while store.isGenerating && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(250))
        }
        if store.isGenerating { store.cancel(); XCTFail("The live sheet did not finish within four minutes"); return }
        XCTAssertEqual(store.phase, .result)
        XCTAssertEqual(store.results.count, 1)
        let result = try XCTUnwrap(store.result)
        try result.data.write(to: directory.appendingPathComponent("first-use-2026-10-17.png"), options: .atomic)
        let attachment = XCTAttachment(image: result.image)
        attachment.name = "Real iPad first-use generation"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testExplicitAppAttestConcurrencyWithoutGeneration() async throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_ATTEST_CHECK"] == "compare-concurrency" else {
            throw XCTSkip("Real-device assertion comparison requires explicit opt-in.")
        }
        let configuration = AppConfiguration.load()
        guard !configuration.mock else { throw XCTSkip("Requires live configuration.") }
        let saved = await AnonymousIdentityStore().session()
        let identity = try XCTUnwrap(saved, "Requires an existing app account.")
        guard identity.isUsable else { throw XCTSkip("Requires a usable saved token.") }
        let client = AppAttestClient()
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        // {} fails input validation before any image reservation. Each request
        // has a fresh challenge and ID, including unsuccessful signing attempts.
        func check(_ mode: String) async -> Bool {
            let id = UUID()
            do {
                let body = Data("{}".utf8)
                let headers = try await client.proof(accountID: identity.accountID,
                    token: identity.accessToken, serviceURL: configuration.serviceURL,
                    session: session, idempotencyKey: id.uuidString.lowercased(), body: body)
                guard let headers else { return false }
                var request = URLRequest(url: configuration.serviceURL.appending(path: "/v1/generations"))
                request.httpMethod = "POST"
                request.httpBody = body
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("Bearer " + identity.accessToken, forHTTPHeaderField: "Authorization")
                request.setValue(id.uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
                for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { return false }
                let code = WorkerClient.workerErrorCode(data, response: http)
                await DiagnosticLog.shared.record("Assertion comparison", mode,
                    generationID: id, httpStatus: http.statusCode, workerCode: code)
                return http.statusCode == 400 && code == "invalid_request"
            } catch {
                await DiagnosticLog.shared.record("Assertion comparison", mode + " failed",
                    generationID: id, error: error)
                return false
            }
        }
        var sequential = 0
        for _ in 0..<3 { if await check("sequential before") { sequential += 1 } }
        let concurrent = await withTaskGroup(of: Bool.self, returning: Int.self) { group in
            for _ in 0..<3 { group.addTask { await check("concurrent") } }
            var successes = 0
            for await passed in group { if passed { successes += 1 } }
            return successes
        }
        for _ in 0..<3 { if await check("sequential after") { sequential += 1 } }
        await DiagnosticLog.shared.record("Assertion comparison summary",
            "sequential=\(sequential)/6; concurrent=\(concurrent)/3")
        XCTAssertEqual(sequential, 6, "Both sequential controls must pass for the comparison to be meaningful.")
        XCTAssertEqual(concurrent, 3, "Concurrent callers must all pass with serialized Apple signing.")
    }

    func testExplicitAppAttestCheckWithoutGeneration() async throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_ATTEST_CHECK"] == "verify-only" else {
            throw XCTSkip("Real-device App Attest check requires explicit opt-in.")
        }
        let configuration = AppConfiguration.load()
        XCTAssertFalse(configuration.mock)
        guard !configuration.mock else { return }
        let saved = await AnonymousIdentityStore().session()
        let identity = try XCTUnwrap(saved, "Use an existing app installation for this check.")
        XCTAssertTrue(identity.isUsable)
        guard identity.isUsable else { return }
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        // A correctly signed empty body reaches input validation (400) only
        // after App Attest verification, and cannot reserve or generate an image.
        let body = Data("{}".utf8), id = UUID()
        let headers = try await AppAttestClient().proof(accountID: identity.accountID,
            token: identity.accessToken, serviceURL: configuration.serviceURL, session: session,
            idempotencyKey: id.uuidString.lowercased(), body: body)
        let proof = try XCTUnwrap(headers, "App Attest must be supported on this device.")
        var request = URLRequest(url: configuration.serviceURL.appending(path: "/v1/generations"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + identity.accessToken, forHTTPHeaderField: "Authorization")
        request.setValue(id.uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        for (name, value) in proof { request.setValue(value, forHTTPHeaderField: name) }
        let (data, response) = try await session.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        let code = WorkerClient.workerErrorCode(data, response: http)
        await DiagnosticLog.shared.record("App Attest live check", "empty-body response",
            generationID: id, httpStatus: http.statusCode, workerCode: code)
        XCTAssertEqual(http.statusCode, 400, "A valid assertion must reach input validation.")
        XCTAssertEqual(code, "invalid_request")
        guard http.statusCode == 400, code == "invalid_request" else { return }
        let (replayedData, replayedResponse) = try await session.data(for: request)
        let replayed = try XCTUnwrap(replayedResponse as? HTTPURLResponse)
        XCTAssertEqual(replayed.statusCode, 403)
        XCTAssertEqual(WorkerClient.workerErrorCode(replayedData, response: replayed), "invalid_assertion")
        await DiagnosticLog.shared.record("App Attest replay check", "response",
            generationID: id, httpStatus: replayed.statusCode,
            workerCode: WorkerClient.workerErrorCode(replayedData, response: replayed))
    }

    func testExplicitTwoGenerationCheck() async throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_LIVE_CHECK"] == "two-generations" else {
            throw XCTSkip("Paid integration check requires explicit opt-in.")
        }
        let configuration = AppConfiguration.load()
        guard !configuration.mock else {
            XCTFail("Live build configuration is required.")
            return
        }
        let client = WorkerClient(serviceURL: configuration.serviceURL)
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LiveVerification", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // Durable, exclusive claim before any request: even a test runner restart or
        // accidental repeat cannot send another paid request from this installation.
        do {
            try Data("claimed".utf8).write(to: directory.appendingPathComponent("paid-check-claimed"), options: .withoutOverwriting)
        } catch {
            throw XCTSkip("This installation has already claimed its paid check. No requests sent.")
        }
        // Two deliberate requests, without retries. Failure of the first stops the check.
        let simple = try await client.generate(GenerationRequest(
            description: "A friendly dinosaur riding a bicycle in a garden", age: 3, model: .flare))
        try simple.data.write(to: directory.appendingPathComponent("flare-simple.png"), options: [.atomic, .completeFileProtection])
        let intricate = try await client.generate(GenerationRequest(
            description: "A friendly dinosaur riding a bicycle in a garden", age: 15, model: .sunburst))
        try intricate.data.write(to: directory.appendingPathComponent("sunburst-intricate.png"), options: [.atomic, .completeFileProtection])

        XCTAssertGreaterThan(simple.image.size.width, 0)
        XCTAssertGreaterThan(intricate.image.size.width, 0)
        // Save only non-sensitive usage metadata, not credentials or composed subjects.
        let summary: [[String: Any]] = [simple, intricate].map { result in
            ["model": result.requestedModel.rawValue,
             "width": result.image.size.width,
             "height": result.image.size.height,
             "estimatedUSD": result.metrics?.estimatedTotalUsd as Any? ?? NSNull(),
             "elapsedMs": result.metrics?.elapsedMs as Any? ?? NSNull()]
        }
        try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent("summary.json"), options: .atomic)
    }
}
