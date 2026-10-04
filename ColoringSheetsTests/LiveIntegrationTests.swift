import XCTest
@testable import ColoringSheets

/// Opt-in only. Standard test runs skip this test and never send paid requests.
final class LiveIntegrationTests: XCTestCase {
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
