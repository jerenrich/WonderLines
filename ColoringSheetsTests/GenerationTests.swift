import XCTest
import UIKit
@testable import ColoringSheets

final class GenerationTests: XCTestCase {
    @MainActor
    func testForegroundReplacesHangingGETButPreservesUnfinishedPOST() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldRequestURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); HeldRequestURLProtocol.handler = nil; HeldRequestURLProtocol.stopped = nil }
        let client = WorkerClient(credential: "synthetic", session: session)
        let postStarted = expectation(description: "Submission in flight")
        let readStarted = expectation(description: "Recovery GET stranded")
        let readCancelled = expectation(description: "Old GET cancelled")
        let finished = expectation(description: "Fresh GET returns saved image promptly")
        let lock = NSLock()
        var heldPost: HeldRequestURLProtocol?
        var methods: [String] = []
        let png = MockGenerator.sampleImage().pngData()!
        HeldRequestURLProtocol.handler = { connection in
            let reads = lock.withLock {
                methods.append(connection.request.httpMethod!)
                if connection.request.httpMethod == "POST" { heldPost = connection }
                return methods.filter { $0 == "GET" }.count
            }
            if connection.request.httpMethod == "POST" { postStarted.fulfill(); return }
            if reads == 1 { readStarted.fulfill(); return } // Never responds unless cancelled.
            connection.finish(status: 200, data: png, type: "image/png")
        }
        HeldRequestURLProtocol.stopped = { connection in
            XCTAssertEqual(connection.request.httpMethod, "GET", "Foreground must not cancel a paid submission")
            readCancelled.fulfill()
        }
        let task = Task {
            defer { finished.fulfill() }
            return try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .redmond))
        }
        await fulfillment(of: [postStarted], timeout: 3)
        await client.resumePolling()
        lock.withLock { heldPost }?.finish(status: 202)
        await fulfillment(of: [readStarted], timeout: 3)
        await client.resumePolling()
        await fulfillment(of: [readCancelled, finished], timeout: 3)
        task.cancel()
        let result = try await task.value
        XCTAssertEqual(result.data, png)
        XCTAssertEqual(lock.withLock { methods }, ["POST", "GET", "GET"])
    }

    func testStopCancelsInFlightRecoveryRead() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldRequestURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); HeldRequestURLProtocol.handler = nil; HeldRequestURLProtocol.stopped = nil }
        let scheduler = RecoveryPollScheduler()
        let started = expectation(description: "GET in flight")
        let stopped = expectation(description: "GET cancelled")
        HeldRequestURLProtocol.handler = { _ in started.fulfill() }
        HeldRequestURLProtocol.stopped = { _ in stopped.fulfill() }
        let revision = await scheduler.revision
        let task = Task {
            try await scheduler.data(for: URLRequest(url: WorkerClient.endpoint), session: session, since: revision)
        }
        await fulfillment(of: [started], timeout: 3)
        task.cancel()
        await scheduler.wake()
        await fulfillment(of: [stopped], timeout: 3)
        do { _ = try await task.value; XCTFail("Explicit cancellation must not become a foreground retry") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    @MainActor
    func testForegroundWakesAllThreePollingDelaysWithoutAnotherPOST() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let suite = "ForegroundPollTests-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let identities = AnonymousIdentityStore(service: suite)
        let account = AnonymousSession(accountID: UUID(), accessToken: "synthetic", expiresAt: Date().addingTimeInterval(3600))
        try await identities.save(account)
        addTeardownBlock { await identities.remove() }
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil; defaults.removePersistentDomain(forName: suite) }
        let pendingStore = PendingGenerationStore(defaults: defaults)
        let scope = WorkerClient.defaultServiceURL.absoluteString + "/" + account.accountID.uuidString.lowercased()
        let waiting = expectation(description: "All three polls are waiting")
        waiting.expectedFulfillmentCount = 3
        let completed = expectation(description: "Foreground checks finish immediately")
        completed.expectedFulfillmentCount = 3
        let client = WorkerClient(session: session, identities: identities, pendingStore: pendingStore,
            recoverySleep: { _ in
                waiting.fulfill()
                try await Task.sleep(for: .seconds(60))
            })
        let pending = (0..<3).map { _ in PendingGeneration(id: UUID(), model: .redmond, createdAt: Date()) }
        for entry in pending { try await pendingStore.add(entry, scope: scope) }
        var polls: [String: Int] = [:]
        let png = MockGenerator.sampleImage().pngData()!
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET", "Returning must never submit another generation")
            let id = request.url!.lastPathComponent
            polls[id, default: 0] += 1
            let ready = polls[id] == 2
            return (HTTPURLResponse(url: request.url!, statusCode: ready ? 200 : 202, httpVersion: nil,
                headerFields: ["Content-Type": ready ? "image/png" : "application/json"])!, ready ? png : Data())
        }
        let tasks = pending.map { entry in
            Task {
                defer { completed.fulfill() }
                return try await client.recoverPending(entry)
            }
        }
        await fulfillment(of: [waiting], timeout: 3)
        await client.resumePolling()
        await fulfillment(of: [completed], timeout: 3)
        for task in tasks { task.cancel() } // Also drain safely if a regression times out.
        for (index, task) in tasks.enumerated() {
            let result = try await task.value
            XCTAssertEqual(result.generationID, pending[index].id)
        }
        XCTAssertEqual(polls.count, 3)
        XCTAssertTrue(polls.values.allSatisfy { $0 == 2 })
    }

    func testPollingWakeDoesNotMissForegroundDuringGETAndPreservesStop() async throws {
        let scheduler = RecoveryPollScheduler()
        let beforeForeground = await scheduler.revision
        await scheduler.wake()
        try await scheduler.wait(for: .seconds(60), since: beforeForeground, sleep: { _ in
            XCTFail("A foreground event during a GET must skip the following delay")
        })
        let current = await scheduler.revision
        let waiting = expectation(description: "Poll delay started")
        let task = Task {
            try await scheduler.wait(for: .seconds(60), since: current, sleep: { _ in
                waiting.fulfill()
                try await Task.sleep(for: .seconds(60))
            })
        }
        await fulfillment(of: [waiting], timeout: 3)
        task.cancel()
        await scheduler.wake()
        do { try await task.value; XCTFail("Stop waiting must still cancel the poll") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    @MainActor
    func testDiagnosticsPersistOnlySafeMetadataAndStayBounded() throws {
        let suite = "diagnostics-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let log = DiagnosticLog(defaults: defaults)
        let id = UUID()
        let error = NSError(domain: NSURLErrorDomain, code: -1001,
                            userInfo: [NSLocalizedDescriptionKey: "private prompt and token"])
        for _ in 0..<(DiagnosticLog.capacity + 1) {
            log.record("Generation POST", "transport failed", generationID: id, model: .flare, error: error)
        }
        XCTAssertEqual(log.events.count, DiagnosticLog.capacity)
        let restored = DiagnosticLog(defaults: defaults)
        XCTAssertEqual(restored.events.count, DiagnosticLog.capacity)
        XCTAssertTrue(restored.report.contains(id.uuidString.lowercased()))
        XCTAssertTrue(restored.report.contains("NSURLErrorDomain:-1001"))
        XCTAssertFalse(restored.report.contains("private prompt"))
        XCTAssertFalse(restored.report.contains("token"))
    }

    @MainActor
    func testDiagnosticRetentionMigrationAndClear() throws {
        let suite = "diagnostic-retention-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let log = DiagnosticLog(defaults: defaults)
        log.record("Batch", "started", batchID: UUID())
        XCTAssertNil(defaults.data(forKey: "diagnosticEvents.v1"), "Routine writes are coalesced.")
        log.flush()
        var saved = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(defaults.data(forKey: "diagnosticEvents.v1"))) as? [[String: Any]])
        var expired = saved[0]
        expired["date"] = Date().addingTimeInterval(-DiagnosticLog.retention - 60).timeIntervalSinceReferenceDate
        expired.removeValue(forKey: "batchID") // Original records had no batch ID.
        saved.insert(expired, at: 0)
        defaults.set(try JSONSerialization.data(withJSONObject: saved), forKey: "diagnosticEvents.v1")
        let restored = DiagnosticLog(defaults: defaults)
        XCTAssertEqual(restored.events.count, 1)
        XCTAssertTrue(restored.report.contains("diagnosticFormat=2"))
        XCTAssertTrue(restored.report.contains("build"))
        restored.record("Batch", "started")
        restored.clear()
        restored.flush()
        XCTAssertTrue(DiagnosticLog(defaults: defaults).events.isEmpty)
    }

    func testImageValidationReasonsExcludeResponseContent() {
        let png = Data([137, 80, 78, 71, 13, 10, 26, 10])
        XCTAssertEqual(WorkerClient.imageValidationFailure(Data("private response".utf8), response: response(200, type: "text/html")), "unexpected_content_type")
        XCTAssertEqual(WorkerClient.imageValidationFailure(Data("private response".utf8), response: response(200, type: "image/png")), "invalid_png_signature")
        XCTAssertEqual(WorkerClient.imageValidationFailure(png, response: response(200, type: "image/png")), "image_decode_failed")
    }

    func testBatchRequestSendsOriginalDescriptionAndBoundedChoices() throws {
        let batch = UUID()
        let request = try GenerationRequest(description: "  ferarri  ", age: 18, model: .sunburst,
            composition: .wide, batchID: batch)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.encoded()) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["description", "age", "composition", "batchID", "model", "width", "height"])
        XCTAssertEqual(body["description"] as? String, "ferarri")
        XCTAssertEqual(body["age"] as? Int, 18)
        XCTAssertEqual(body["composition"] as? String, "wide")
        XCTAssertEqual(body["batchID"] as? String, batch.uuidString.lowercased())
        XCTAssertNil(body["subject"], "Trusted guidance must be composed by the server.")
    }

    func testSelectableModelsExcludeRetiredChoices() {
        XCTAssertEqual(ImageModel.selectable.map(\.rawValue), [
            "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
            "flux-2-klein-4b", "flux-2-klein-9b", "phoenix-1.0", "coloringbook-redmond-v2"
        ])
    }

    func testAgeGuidanceAndWireContract() throws {
        for model in ImageModel.allCases {
            let young = try GenerationRequest(description: "A test flower", age: 3, model: model)
            let older = try GenerationRequest(description: "A test flower", age: 18, model: model)
            XCTAssertNotEqual(young.subject, older.subject)
            XCTAssertFalse(young.subject.contains("3"))
            XCTAssertFalse(older.subject.contains("18"))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: young.encoded()) as? [String: Any])
            XCTAssertEqual(Set(json.keys), ["subject", "model", "width", "height"])
            XCTAssertEqual(json["model"] as? String, model.rawValue)
            XCTAssertEqual(json["width"] as? Int, 1456)
            XCTAssertEqual(json["height"] as? Int, 1024)
            XCTAssertEqual(try GenerationRequest(description: "A test flower", age: 3, model: model), young)
        }
    }
    func testPageSizingAcrossLayoutsAndPixelScales() throws {
        for format in PageFormat.allCases {
            for available in [CGSize(width: 600, height: 650), CGSize(width: 380, height: 890),
                              CGSize(width: 200, height: 100), CGSize(width: 2000, height: 3000)] {
                let fitted = format.fittedSize(in: available)
                XCTAssertLessThanOrEqual(fitted.width, available.width + 0.001)
                XCTAssertLessThanOrEqual(fitted.height, available.height + 0.001)
                XCTAssertEqual(fitted.width / fitted.height, format.aspectRatio, accuracy: 0.0001)
                for scale: CGFloat in [1, 2, 3] {
                    let size = format.imageSize(for: available, displayScale: scale)
                    XCTAssertTrue(size.isValid, "Invalid size: \(size)")
                    XCTAssertEqual(CGFloat(size.width) / CGFloat(size.height), format.aspectRatio, accuracy: 0.02)
                }
            }
        }
        let size = PageFormat.a4Portrait.imageSize(for: CGSize(width: 600, height: 700), displayScale: 2)
        XCTAssertEqual(size, GenerationSize(width: 992, height: 1408))
        XCTAssertTrue(PageFormat.a4Portrait.imageSize(for: .zero, displayScale: 2).isValid)
        for invalid in [GenerationSize(width: 1023, height: 1456), GenerationSize(width: 16, height: 16),
                        GenerationSize(width: Int.max, height: Int.max), GenerationSize(width: 2048, height: 2048)] {
            XCTAssertThrowsError(try GenerationRequest(description: "Test flower", age: 3, model: .flare, size: invalid))
        }
        let mock = MockGenerator.sampleImage(size: size)
        XCTAssertEqual(mock.cgImage?.width, size.width)
        XCTAssertEqual(mock.cgImage?.height, size.height)
    }
    func testUTF16BoundaryAndValidation() throws {
        let overhead = try GenerationRequest.guidance(age: 3).utf16.count + 2
        let maximum = String(repeating: "a", count: 500 - overhead)
        XCTAssertEqual(try GenerationRequest(description: maximum, age: 3, model: .flare).subject.utf16.count, 500)
        XCTAssertThrowsError(try GenerationRequest(description: maximum + "a", age: 3, model: .flare))
        XCTAssertThrowsError(try GenerationRequest(description: String(repeating: "😀", count: 250), age: 3, model: .flare))
        XCTAssertThrowsError(try GenerationRequest(description: " \n ", age: 3, model: .flare))
        for age in [0, 2, 19] { XCTAssertThrowsError(try GenerationRequest(description: "Flower", age: age, model: .flare)) }
        // JSON escaping is counted too, independently of Swift Character count.
        XCTAssertLessThanOrEqual(try GenerationRequest(description: String(repeating: "\u{0001}", count: 300), age: 3, model: .flare).encoded().count, 4096)
    }
    func response(_ status: Int = 200, type: String = "image/png", metrics: String? = nil, headers extraHeaders: [String: String] = [:]) -> HTTPURLResponse {
        var headers = ["Content-Type": type]
        if let metrics { headers["x-generation-metrics"] = metrics }
        headers.merge(extraHeaders) { _, new in new }
        return HTTPURLResponse(url: WorkerClient.endpoint, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    }
    func testPNGSurvivesMissingMalformedAndFutureMetrics() throws {
        let png = MockGenerator.sampleImage().pngData()!
        for header in [nil, "%not-json", "%7B%22inputTokens%22%3Anull%2C%22imageInputTokens%22%3A0%2C%22future%22%3Atrue%7D"] as [String?] {
            let result = try WorkerClient.parse(png, response: response(metrics: header), requestedModel: .flare)
            XCTAssertEqual(result.data, png)
            if header?.contains("future") == true {
                XCTAssertNil(result.metrics?.inputTokens)
                XCTAssertEqual(result.metrics?.imageInputTokens, 0)
            }
        }
        let metrics = GenerationMetrics.decode("%7B%22requestedModel%22%3A%22a%2Bb%22%7D")
        XCTAssertEqual(metrics?.requestedModel, "a+b")
    }
    func testInvalidPNGAndHTTPFailures() {
        XCTAssertThrowsError(try WorkerClient.parse(Data(), response: response(), requestedModel: .flare))
        XCTAssertThrowsError(try WorkerClient.parse(MockGenerator.sampleImage().pngData()!, response: response(type: "text/html"), requestedModel: .flare))
        for status in [401, 403, 404, 405, 415, 503] {
            XCTAssertThrowsError(try WorkerClient.parse(Data(), response: response(status), requestedModel: .flare)) {
                XCTAssertEqual($0 as? GenerationError, .configuration)
            }
        }
        XCTAssertThrowsError(try WorkerClient.parse(Data("OpenAI reports insufficient credit or quota.".utf8), response: response(502, type: "text/plain"), requestedModel: .flare)) {
            XCTAssertNotEqual($0 as? GenerationError, .configuration)
            XCTAssertTrue($0.localizedDescription.contains("quota"))
        }
        for status in [302, 400, 413, 500, 502, 504] {
            XCTAssertThrowsError(try WorkerClient.parse(Data("<html>private diagnostics</html>".utf8), response: response(status, type: "text/html"), requestedModel: .flare)) {
                XCTAssertFalse($0.localizedDescription.contains("private diagnostics"))
            }
        }
    }

    func testDescriptionModerationErrors() {
        let cases: [(String, Int, GenerationError)] = [
            ("description_not_suitable", 400, .validation("Please describe a gentle scene. No sheet allowance was used.")),
            ("moderation_unavailable", 503, .upstream("Please describe a gentle scene. No sheet allowance was used."))
        ]
        for (code, status, expected) in cases {
            let body = Data("{\"error\":{\"code\":\"\(code)\",\"message\":\"Please describe a gentle scene. No sheet allowance was used.\"}}".utf8)
            XCTAssertThrowsError(try WorkerClient.parse(body, response: response(status, type: "application/json; charset=utf-8"), requestedModel: .flare)) {
                XCTAssertEqual($0 as? GenerationError, expected)
            }
            XCTAssertThrowsError(try WorkerClient.parse(body, response: response(502, type: "application/json"), requestedModel: .flare)) {
                XCTAssertNotEqual($0 as? GenerationError, expected, "Messages require the matching status code.")
            }
        }
    }

    func testModerationDiagnosticsOnlyRetainKnownCategories() throws {
        let body = try JSONSerialization.data(withJSONObject: ["error": ["code": "description_not_suitable", "message": "private message", "reasonCodes": ["violence", "private prompt and token", "uncertain", "violence"]]])
        XCTAssertEqual(WorkerClient.moderationDiagnostic(body, response: response(400, type: "application/json")),
                       "description rejected; reasons=uncertain,violence; allowanceUsed=false")
        XCTAssertNil(WorkerClient.moderationDiagnostic(body, response: response(503, type: "application/json")))
        XCTAssertNil(WorkerClient.moderationDiagnostic(body, response: response(400, type: "text/html")))
        let legacy = Data("{\"error\":{\"code\":\"description_not_suitable\",\"message\":\"Please rewrite your description.\",\"reasonCodes\":42}}".utf8)
        XCTAssertEqual(WorkerClient.moderationDiagnostic(legacy, response: response(400, type: "application/json")),
                       "description rejected; reasons=unspecified; allowanceUsed=false")
        XCTAssertThrowsError(try WorkerClient.parse(legacy, response: response(400, type: "application/json"), requestedModel: .flare)) {
            XCTAssertEqual($0 as? GenerationError, .validation("Please rewrite your description."))
        }
    }

    func testV1AllowanceResponse() {
        let body = Data(#"{"error":{"code":"allowance_exhausted","message":"Today’s free sheet allowance has been used."}}"#.utf8)
        XCTAssertThrowsError(try WorkerClient.parse(body, response: response(429, type: "application/json"), requestedModel: .flare)) {
            XCTAssertEqual($0 as? GenerationError, .allowance)
        }
    }
    func testRejectedDeviceAssertionHasSpecificSafeMessage() {
        let body = Data(#"{"error":{"code":"invalid_assertion","message":"Internal details must stay hidden."}}"#.utf8)
        XCTAssertThrowsError(try WorkerClient.parse(body, response: response(403, type: "application/json"), requestedModel: .flare)) {
            XCTAssertEqual($0 as? GenerationError, .deviceRejected)
            XCTAssertFalse($0.localizedDescription.contains("Internal details"))
        }
    }
    func testServiceBudgetIsDistinctFromPersonalAllowance() {
        let body = Data(#"{"error":{"code":"service_budget_exhausted"}}"#.utf8)
        XCTAssertThrowsError(try WorkerClient.parse(body, response: response(429, type: "application/json"), requestedModel: .flare)) {
            XCTAssertEqual($0 as? GenerationError, .serviceBudget)
        }
    }

    func testWorkerResponseDiagnosticRejectsSensitiveText() {
        let safe = Data(#"{"error":{"code":"service_unavailable","message":"token=private prompt=secret"}}"#.utf8)
        XCTAssertEqual(WorkerClient.workerErrorCode(safe, response: response(503, type: "application/json; charset=utf-8")), "service_unavailable")
        let unsafe = Data(#"{"error":{"code":"token=private prompt=secret"}}"#.utf8)
        XCTAssertNil(WorkerClient.workerErrorCode(unsafe, response: response(503, type: "application/json")))
        XCTAssertNil(WorkerClient.workerErrorCode(safe, response: response(200, type: "application/json")))
        XCTAssertNil(WorkerClient.workerErrorCode(safe, response: response(503, type: "text/html")))
    }
    func testStructuredWorkerErrorsReachTheUser() throws {
        for (status, code, message) in [
            (502, "provider_daily_quota_exhausted", "Cloudflare Workers AI has used its daily free allowance of 10,000 neurons. It resets at 00:00 UTC. Choose Flare or Sunburst (HTTP 429; Cloudflare code 4006)."),
            (502, "provider_rate_limited", "OpenAI has reached a request limit (HTTP 429)."),
            (502, "provider_authentication_failed", "AI Gateway rejected the service credentials (HTTP 401)."),
            (502, "provider_image_conversion_failed", "Cloudflare Images could not convert the image to PNG."),
            (502, "upstream_failed", "The image provider could not complete the request (HTTP 418)."),
            (503, "service_unavailable", "Image provider configuration is incomplete."),
            (400, "invalid_request", "Model is invalid."),
            (410, "result_unavailable", "Saved image is unavailable.")
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message]])
            XCTAssertThrowsError(try WorkerClient.parse(data, response: response(status, type: "application/json; charset=utf-8"), requestedModel: .fluxKlein4B)) {
                XCTAssertEqual($0.localizedDescription, message)
            }
            XCTAssertEqual(WorkerClient.workerErrorCode(data, response: response(status, type: "application/json")), code)
        }
    }
    func testUnrecognizedOrMalformedErrorDetailsUseFallback() throws {
        for (code, message) in [
            ("unknown_error", "private diagnostics"),
            ("provider_quota_exhausted", "<html>private diagnostics</html>"),
            ("provider_quota_exhausted", "private diagnostics\u{0000}"),
            ("provider_quota_exhausted", String(repeating: "private diagnostics", count: 300)),
            ("provider_quota_exhausted", " "),
            ("service_unavailable", "private diagnostics") // wrong HTTP status for this code
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message]])
            XCTAssertThrowsError(try WorkerClient.parse(data, response: response(502, type: "application/json"), requestedModel: .flare)) {
                XCTAssertFalse($0.localizedDescription.contains("private diagnostics"))
                XCTAssertFalse($0.localizedDescription.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        for body in [#"{"error":{"code":"upstream_failed"}}"#, #"{"error":{"code":"upstream_failed","message":42}}"#, "not JSON"] {
            XCTAssertThrowsError(try WorkerClient.parse(Data(body.utf8), response: response(502, type: "application/json"), requestedModel: .flare)) {
                XCTAssertTrue($0.localizedDescription.contains("could not return a sheet"))
            }
        }
    }
    @MainActor func testPrintFitAndExportPNG() throws {
        for paper in [CGRect(x: 18, y: 18, width: 559, height: 806), CGRect(x: 18, y: 18, width: 756, height: 576)] {
            for size in [CGSize(width: 1024, height: 1536), GenerationSize.a4Default.cgSize] {
                let rect = ColoringPrintRenderer.fittedRect(imageSize: size, printable: paper)
                XCTAssertTrue(paper.contains(rect))
                XCTAssertEqual(rect.width / rect.height, size.width / size.height, accuracy: 0.001)
            }
        }
        let image = MockGenerator.sampleImage()
        let result = ColoringResult(data: image.pngData()!, image: image, requestedModel: .flare, metrics: nil)
        let item = try ExportItem(kind: .share, result: result)
        XCTAssertEqual(try Data(contentsOf: item.url), result.data)
        XCTAssertNotNil(UIImage(contentsOfFile: item.url.path))
        item.cleanUp()
        XCTAssertFalse(FileManager.default.fileExists(atPath: item.url.path))
    }
}

final class HeldRequestURLProtocol: URLProtocol {
    static var handler: ((HeldRequestURLProtocol) -> Void)?
    static var stopped: ((HeldRequestURLProtocol) -> Void)?
    private let stateLock = NSLock()
    private var ended = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.handler?(self) }
    override func stopLoading() {
        let cancelled = stateLock.withLock {
            guard !ended else { return false }
            ended = true
            return true
        }
        if cancelled { Self.stopped?(self) }
    }
    func finish(status: Int, data: Data = Data(), type: String = "application/json") {
        let deliver = stateLock.withLock {
            guard !ended else { return false }
            ended = true
            return true
        }
        guard deliver else { return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: ["Content-Type": type])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (response, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class NetworkingTests: XCTestCase {
    func testModerationFailureIsLoggedAndNeverLeftPending() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let suite = "ModerationTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let identities = AnonymousIdentityStore(service: suite)
        try await identities.save(AnonymousSession(accountID: UUID(), accessToken: "synthetic", expiresAt: Date().addingTimeInterval(3600)))
        addTeardownBlock { await identities.remove() }
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil; defaults.removePersistentDomain(forName: suite) }
        let client = WorkerClient(session: session, identities: identities, pendingStore: PendingGenerationStore(defaults: defaults))
        for (status, code) in [(400, "description_not_suitable"), (503, "moderation_unavailable")] {
            var calls = 0
            var generationID: String?
            MockURLProtocol.handler = { request in
                calls += 1
                generationID = request.value(forHTTPHeaderField: "Idempotency-Key")
                XCTAssertEqual(request.httpMethod, "POST")
                let data = try JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": "No sheet allowance was used.", "reasonCodes": ["violence"]]])
                return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, data)
            }
            do { _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)); XCTFail("Expected moderation failure") }
            catch { XCTAssertTrue(error.localizedDescription.contains("No sheet allowance")) }
            XCTAssertEqual(calls, 1)
            let pending = await client.pendingGenerations()
            XCTAssertTrue(pending.isEmpty, "Moderation failed before any image job was reserved.")
            let event = await MainActor.run { DiagnosticLog.shared.events.last { $0.stage == "Content moderation" && $0.generationID?.uuidString.lowercased() == generationID } }
            XCTAssertEqual(event?.workerCode, code)
            XCTAssertEqual(event?.httpStatus, status)
            XCTAssertTrue(event?.outcome.contains("allowanceUsed=false") == true)
        }
    }

    func testOnePOSTAndNoRetryForAllModelsAndTimeout() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let client = WorkerClient(credential: "synthetic-dummy", session: session)
        var calls = 0
        for model in ImageModel.allCases {
            MockURLProtocol.handler = { request in
                calls += 1
                XCTAssertEqual(request.url, WorkerClient.endpoint)
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-dummy")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
                XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
                XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, MockGenerator.sampleImage().pngData()!)
            }
            _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: model))
        }
        XCTAssertEqual(calls, ImageModel.allCases.count)
        MockURLProtocol.handler = { _ in calls += 1; throw URLError(.timedOut) }
        do { _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error as? GenerationError, .uncertain) }
        XCTAssertEqual(calls, ImageModel.allCases.count + 1)
    }
    func testV1AllowanceDoesNotRepeatPaidPOST() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let client = WorkerClient(credential: "synthetic-dummy", session: session)
        var calls = 0
        MockURLProtocol.handler = { request in
            calls += 1
            return (HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil,
                                   headerFields: ["Content-Type": "application/json"])!,
                    Data(#"{"error":{"code":"allowance_exhausted"}}"#.utf8))
        }
        do { _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)); XCTFail("Expected allowance failure") }
        catch { XCTAssertEqual(error as? GenerationError, .allowance) }
        XCTAssertEqual(calls, 1)
    }

    func testV1RegistrationIsSharedByBatchAndPersistsAcrossClients() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let service = "com.jordan.family.ColoringSheets.tests.\(UUID().uuidString)"
        let identities = AnonymousIdentityStore(service: service)
        addTeardownBlock { await identities.remove() }
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let client = WorkerClient(session: session, identities: identities)
        let png = MockGenerator.sampleImage().pngData()!
        var registrations = 0
        var ids = Set<String>()
        let lock = NSLock()
        // Match the deployed Worker's spelling, numeric expiry, and JS ISO date.
        let registration = try JSONSerialization.data(withJSONObject: [
            "accountId": "860eca75-ca29-4271-9b13-a01f5c9dea52",
            "accessToken": "synthetic-token", "expiresAt": Date().timeIntervalSince1970 + 3600
        ])
        let access = #"{"features":[],"generationCredits":0,"freeGenerationsRemaining":2,"allowanceResetsAt":"2026-09-23T00:00:00.000Z"}"#
        MockURLProtocol.handler = { request in
            lock.lock(); defer { lock.unlock() }
            XCTAssertEqual(request.httpMethod, "POST")
            if request.url!.path == "/v1/installations" {
                registrations += 1
                return (HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil,
                                        headerFields: ["Content-Type": "application/json"])!, registration)
            }
            XCTAssertEqual(request.url!.path, "/v1/generations")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token")
            let id = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            XCTAssertNotNil(UUID(uuidString: id))
            XCTAssertEqual(id, id.lowercased(), "Worker UUID validation requires lowercase")
            XCTAssertTrue(ids.insert(id).inserted)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [
                "Content-Type": "image/png", "X-Generation-ID": id,
                "X-Access-Snapshot": access.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!
            ])!, png)
        }
        let request = try GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<5 {
                group.addTask {
                    let result = try await client.generate(request)
                    XCTAssertNotNil(result.generationID)
                    XCTAssertEqual(result.access?.freeGenerationsRemaining, 2)
                    XCTAssertNotNil(result.access?.allowanceResetsAt)
                }
            }
            try await group.waitForAll()
        }
        let nextClient = WorkerClient(session: session, identities: AnonymousIdentityStore(service: service))
        _ = try await nextClient.generate(request)
        XCTAssertEqual(registrations, 1, "A batch and later client must reuse the same account")
        XCTAssertEqual(ids.count, 6)
    }

    func testRecoveryUsesSameLowercaseIDWithoutRepeatingPOST() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let client = WorkerClient(credential: "synthetic-token", session: session)
        let png = MockGenerator.sampleImage().pngData()!
        var methods: [String] = []
        var generationID: String?
        MockURLProtocol.handler = { request in
            methods.append(request.httpMethod!)
            if request.httpMethod == "POST" {
                generationID = request.value(forHTTPHeaderField: "Idempotency-Key")
                return (HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil,
                                        headerFields: ["Content-Type": "application/json"])!, Data())
            }
            XCTAssertEqual(request.url!.lastPathComponent, generationID)
            XCTAssertEqual(generationID, generationID?.lowercased())
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: ["Content-Type": "image/png"])!, png)
        }
        _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .flare))
        XCTAssertEqual(methods, ["POST", "GET"])
        let summary = await MainActor.run { DiagnosticLog.shared.events.last { $0.stage == "Recovery summary" && $0.generationID?.uuidString.lowercased() == generationID } }
        XCTAssertTrue(summary?.outcome.contains("recovered; attempts=1") == true)
    }
    func testRecoveryPreservesTerminalErrorsAndCancellation() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let client = WorkerClient(credential: "synthetic-token", session: session)
        let request = try GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)
        for (status, expected) in [(403, GenerationError.configuration), (429, .allowance), (200, .invalidImage), (-1, .cancelled)] {
            var methods: [String] = []
            MockURLProtocol.handler = { request in
                methods.append(request.httpMethod!)
                if request.httpMethod == "POST" {
                    return (HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!, Data())
                }
                if status == -1 { throw URLError(.cancelled) }
                return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                        headerFields: ["Content-Type": "application/json"])!, Data())
            }
            do { _ = try await client.generate(request); XCTFail("Expected recovery failure") }
            catch { XCTAssertEqual(error as? GenerationError, expected) }
            XCTAssertEqual(methods, ["POST", "GET"], "Do not poll terminal failures or cancelled recovery again")
        }
    }

    func testFalQueueSurvivesCancellationAndClientRelaunchWithoutAnotherPOST() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let suite = "FalRecoveryTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let identities = AnonymousIdentityStore(service: suite)
        let account = AnonymousSession(accountID: UUID(), accessToken: "synthetic", expiresAt: Date().addingTimeInterval(3600))
        try await identities.save(account)
        addTeardownBlock { await identities.remove() }
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil; defaults.removePersistentDomain(forName: suite) }
        let store = PendingGenerationStore(defaults: defaults)
        let firstClient = WorkerClient(session: session, identities: identities, pendingStore: store,
                                       recoverySleep: { _ in throw CancellationError() })
        var methods: [String] = []
        var generationID: String?
        MockURLProtocol.handler = { request in
            methods.append(request.httpMethod!)
            if request.httpMethod == "POST" { generationID = request.value(forHTTPHeaderField: "Idempotency-Key") }
            return (HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!, Data())
        }
        do {
            _ = try await firstClient.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .redmond))
            XCTFail("Expected cancelled waiting")
        } catch { XCTAssertEqual(error as? GenerationError, .cancelled) }
        let restoredStore = PendingGenerationStore(defaults: defaults)
        let nextClient = WorkerClient(session: session, identities: identities, pendingStore: restoredStore,
            recoverySleep: { duration in
                XCTAssertEqual(duration, .seconds(5), "Confirmed processing jobs should be checked every five seconds")
            })
        let pending = await nextClient.pendingGenerations()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending.first?.id.uuidString.lowercased(), generationID)
        var polls = 0
        let png = MockGenerator.sampleImage().pngData()!
        MockURLProtocol.handler = { request in
            methods.append(request.httpMethod!)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url!.lastPathComponent, generationID)
            polls += 1
            if polls < 5 { return (HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!, Data()) }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: ["Content-Type": "image/png", "X-Generation-ID": generationID!])!, png)
        }
        let result = try await nextClient.recoverPending(try XCTUnwrap(pending.first))
        XCTAssertEqual(result.requestedModel, .redmond)
        XCTAssertEqual(result.generationID?.uuidString.lowercased(), generationID)
        XCTAssertEqual(methods.filter { $0 == "POST" }.count, 1)
        XCTAssertEqual(polls, 5, "fal recovery must tolerate more than the previous three short checks")
        let events = await MainActor.run { DiagnosticLog.shared.events.filter { $0.generationID?.uuidString.lowercased() == generationID } }
        XCTAssertEqual(events.filter { $0.stage == "Recovery" && $0.httpStatus == 202 }.count, 2, "One waiting event per recovery session, not one per identical poll.")
        XCTAssertTrue(events.contains { $0.stage == "Recovery summary" && $0.outcome.contains("cancelled") })
        XCTAssertTrue(events.contains { $0.stage == "Recovery summary" && $0.outcome.contains("recovered; attempts=5") })
        let delivered = await nextClient.pendingGenerations()
        XCTAssertEqual(delivered.count, 1, "Keep recovery until the gallery acknowledges durable receipt")
        await nextClient.acknowledgeResult(result.generationID!)
        let remaining = await nextClient.pendingGenerations()
        XCTAssertTrue(remaining.isEmpty)
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            return (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!,
                    Data(#"{"error":{"code":"service_unavailable","message":"Configure fal first."}}"#.utf8))
        }
        do {
            _ = try await nextClient.generate(GenerationRequest(description: "Flower", age: 8, model: .redmond))
            XCTFail("Expected configuration rejection")
        } catch {}
        let rejected = await nextClient.pendingGenerations()
        XCTAssertTrue(rejected.isEmpty, "Configuration rejection must not leave a phantom pending sheet")
    }

    func testSunburstSurvivesCancellationAndClientRelaunchWithoutAnotherPOST() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let suite = "FalRecoveryTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let identities = AnonymousIdentityStore(service: suite)
        let account = AnonymousSession(accountID: UUID(), accessToken: "synthetic", expiresAt: Date().addingTimeInterval(3600))
        try await identities.save(account)
        addTeardownBlock { await identities.remove() }
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil; defaults.removePersistentDomain(forName: suite) }
        let store = PendingGenerationStore(defaults: defaults)
        let firstClient = WorkerClient(session: session, identities: identities, pendingStore: store,
                                       recoverySleep: { _ in throw CancellationError() })
        let batchID = UUID()
        var methods: [String] = []
        var generationID: String?
        MockURLProtocol.handler = { request in
            methods.append(request.httpMethod!)
            if request.httpMethod == "POST" { generationID = request.value(forHTTPHeaderField: "Idempotency-Key") }
            return (HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!, Data())
        }
        do {
            _ = try await firstClient.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .sunburst, composition: .side, batchID: batchID))
            XCTFail("Expected cancelled waiting")
        } catch { XCTAssertEqual(error as? GenerationError, .cancelled) }
        let restoredStore = PendingGenerationStore(defaults: defaults)
        let nextClient = WorkerClient(session: session, identities: identities, pendingStore: restoredStore, recoverySleep: { _ in })
        let pending = await nextClient.pendingGenerations()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending.first?.batchID, batchID)
        XCTAssertEqual(pending.first?.id.uuidString.lowercased(), generationID)
        var polls = 0
        let png = MockGenerator.sampleImage().pngData()!
        MockURLProtocol.handler = { request in
            methods.append(request.httpMethod!)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url!.lastPathComponent, generationID)
            polls += 1
            if polls < 5 { return (HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!, Data()) }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: ["Content-Type": "image/png", "X-Generation-ID": generationID!])!, png)
        }
        let result = try await nextClient.recoverPending(try XCTUnwrap(pending.first))
        XCTAssertEqual(result.requestedModel, .sunburst)
        XCTAssertEqual(result.generationID?.uuidString.lowercased(), generationID)
        XCTAssertEqual(methods.filter { $0 == "POST" }.count, 1)
        XCTAssertEqual(polls, 5, "Sunburst recovery must tolerate more than the previous three short checks")
        let events = await MainActor.run { DiagnosticLog.shared.events.filter { $0.generationID?.uuidString.lowercased() == generationID } }
        XCTAssertEqual(events.filter { $0.stage == "Recovery" && $0.httpStatus == 202 }.count, 2, "One waiting event per recovery session, not one per identical poll.")
        XCTAssertTrue(events.contains { $0.stage == "Recovery summary" && $0.outcome.contains("cancelled") })
        XCTAssertTrue(events.contains { $0.stage == "Recovery summary" && $0.outcome.contains("recovered; attempts=5") })
        let delivered = await nextClient.pendingGenerations()
        XCTAssertEqual(delivered.count, 1, "Keep recovery until the gallery acknowledges durable receipt")
        await nextClient.acknowledgeResult(result.generationID!)
        let remaining = await nextClient.pendingGenerations()
        XCTAssertTrue(remaining.isEmpty)
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            return (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!,
                    Data(#"{"error":{"code":"service_unavailable","message":"Configure fal first."}}"#.utf8))
        }
        do {
            _ = try await nextClient.generate(GenerationRequest(description: "Flower", age: 8, model: .sunburst))
            XCTFail("Expected configuration rejection")
        } catch {}
        let rejected = await nextClient.pendingGenerations()
        XCTAssertTrue(rejected.isEmpty, "Configuration rejection must not leave a phantom pending sheet")
    }

    func testMissingRecoveryWaitsForReservationThenClearsOnlyConfirmedMissingJob() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        let suite = "MissingJobTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let identities = AnonymousIdentityStore(service: suite)
        let account = AnonymousSession(accountID: UUID(), accessToken: "synthetic", expiresAt: Date().addingTimeInterval(3600))
        try await identities.save(account)
        addTeardownBlock { await identities.remove() }
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil; defaults.removePersistentDomain(forName: suite) }
        let pendingStore = PendingGenerationStore(defaults: defaults)
        let scope = WorkerClient.defaultServiceURL.absoluteString + "/" + account.accountID.uuidString.lowercased()
        let client = WorkerClient(session: session, identities: identities, pendingStore: pendingStore, recoverySleep: { _ in })
        let missing = PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date())
        try await pendingStore.add(missing, scope: scope)
        var polls = 0
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            polls += 1
            return (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, Data(#"{"error":{"code":"not_found"}}"#.utf8))
        }
        do { _ = try await client.recoverPending(missing); XCTFail("Expected missing job") }
        catch { XCTAssertEqual(error as? GenerationError, .resultMissing) }
        XCTAssertEqual(polls, 6, "Allow moderation/reservation to finish, without another POST")
        let remaining = await client.pendingGenerations()
        XCTAssertTrue(remaining.isEmpty)

        let oldMissing = PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date().addingTimeInterval(-90))
        try await pendingStore.add(oldMissing, scope: scope)
        polls = 0
        do { _ = try await client.recoverPending(oldMissing); XCTFail("Expected missing job") }
        catch { XCTAssertEqual(error as? GenerationError, .resultMissing) }
        XCTAssertEqual(polls, 1, "An old ID which is already confirmed missing must fail immediately")

        let delayed = PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date())
        try await pendingStore.add(delayed, scope: scope)
        polls = 0
        let png = MockGenerator.sampleImage().pngData()!
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            polls += 1
            if polls < 3 { return (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, Data(#"{"error":{"code":"not_found"}}"#.utf8)) }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "image/png"])!, png)
        }
        let delivered = try await client.recoverPending(delayed)
        XCTAssertEqual(delivered.generationID, delayed.id)
        let beforeAcknowledgement = await client.pendingGenerations()
        XCTAssertEqual(beforeAcknowledgement.map(\.id), [delayed.id], "Cancellation after delivery must retain recovery")
        await client.acknowledgeResult(delayed.id)
        let afterAcknowledgement = await client.pendingGenerations()
        XCTAssertTrue(afterAcknowledgement.isEmpty)
    }

    func testFalUsageRefreshIsReadOnlyAndDecodesBillingEvidence() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let client = WorkerClient(credential: "synthetic", session: session)
        let id = UUID()
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url!.path, "/v1/generations/" + id.uuidString.lowercased() + "/usage")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!,
                    Data(#"{"metrics":{"provider":"fal","providerRequestID":"fal-job","inferenceMs":12000,"billableUnits":12.5,"unitPriceUsd":0.001,"billingUnit":"compute second","reportedCostUsd":0.01,"estimatedTotalUsd":0.01,"costStatus":"reported"}}"#.utf8))
        }
        let metrics = try await client.generationMetrics(id)
        XCTAssertEqual(metrics?.reportedCostUsd, 0.01)
        XCTAssertEqual(metrics?.billableUnits, 12.5)
        XCTAssertEqual(metrics?.costStatus, "reported")
        XCTAssertEqual(metrics?.providerRequestID, "fal-job")
    }

    func testPendingGenerationsAreScopedAndExpire() async throws {
        let suite = "PendingScopeTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PendingGenerationStore(defaults: defaults)
        let entry = PendingGeneration(id: UUID(), model: .redmond, createdAt: Date())
        try await store.add(entry, scope: "server/account-a")
        try await store.add(PendingGeneration(id: UUID(), model: .redmond, createdAt: .distantPast), scope: "server/account-a")
        let own = await store.list(scope: "server/account-a")
        let other = await store.list(scope: "server/account-b")
        XCTAssertEqual(own.map(\.id), [entry.id]); XCTAssertTrue(other.isEmpty)
        let persisted = String(data: defaults.data(forKey: "pendingGenerations.server/account-a")!, encoding: .utf8)!
        XCTAssertFalse(persisted.contains("accessToken")); XCTAssertFalse(persisted.contains("subject"))
    }

    func testExpiredIdentityRenewsOnceAndKeepsItsAccount() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let identities = AnonymousIdentityStore(service: "ColoringSheets.renewal-tests.\(UUID())")
        addTeardownBlock { await identities.remove() }
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let saved = AnonymousSession(accountID: UUID(), accessToken: "expired-token", expiresAt: .distantPast)
        try await identities.save(saved)
        let renewal = try JSONSerialization.data(withJSONObject: ["accountId": saved.accountID.uuidString,
            "accessToken": "renewed-token", "expiresAt": Date().timeIntervalSince1970 + 3600])
        let png = MockGenerator.sampleImage().pngData()!
        let lock = NSLock()
        var renewals = 0, generations = 0
        MockURLProtocol.handler = { request in
            lock.lock(); defer { lock.unlock() }
            if request.url!.path == "/v1/installations/renew" {
                renewals += 1
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer expired-token")
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, renewal)
            }
            generations += 1
            XCTAssertEqual(request.url!.path, "/v1/generations", "Never register a replacement account")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer renewed-token")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, png)
        }
        let client = WorkerClient(session: session, identities: identities)
        let request = try GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<5 { group.addTask { _ = try await client.generate(request) } }
            try await group.waitForAll()
        }
        XCTAssertEqual(renewals, 1)
        XCTAssertEqual(generations, 5)
        let persisted = await identities.session()
        XCTAssertEqual(persisted?.accountID, saved.accountID)
        XCTAssertEqual(persisted?.accessToken, "renewed-token")
    }

    func testFailedOrMismatchedRenewalRetainsSavedAccount() async throws {
        let identities = AnonymousIdentityStore(service: "ColoringSheets.renewal-failure-tests.\(UUID())")
        addTeardownBlock { await identities.remove() }
        let saved = AnonymousSession(accountID: UUID(), accessToken: "expired-token", expiresAt: .distantPast)
        try await identities.save(saved)
        for mismatched in [false, true] {
            do {
                _ = try await identities.session(register: {
                    XCTFail("An existing account must never be replaced by registration")
                    throw GenerationError.configuration
                }, renew: { identity in
                    XCTAssertEqual(identity, saved)
                    if !mismatched { throw GenerationError.uncertain }
                    return AnonymousSession(accountID: UUID(), accessToken: "different-account", expiresAt: .distantFuture)
                })
                XCTFail("Expected renewal failure")
            } catch { XCTAssertEqual(error as? GenerationError, mismatched ? .configuration : .uncertain) }
            let persisted = await identities.session()
            XCTAssertEqual(persisted, saved, "Failed renewal must leave the existing credential intact for another attempt")
        }
    }

    func testCancellationDuringRenewalNeverStartsGeneration() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let identities = AnonymousIdentityStore(service: "ColoringSheets.renewal-cancel-tests.\(UUID())")
        addTeardownBlock { await identities.remove() }
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let saved = AnonymousSession(accountID: UUID(), accessToken: "expired-token", expiresAt: .distantPast)
        try await identities.save(saved)
        let response = try JSONSerialization.data(withJSONObject: ["accountId": saved.accountID.uuidString,
            "accessToken": "renewed-token", "expiresAt": Date().timeIntervalSince1970 + 3600])
        let started = expectation(description: "Renewal started")
        let release = DispatchSemaphore(value: 0)
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url!.path, "/v1/installations/renew", "Cancellation must prevent a generation POST")
            started.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, response)
        }
        let client = WorkerClient(session: session, identities: identities)
        let request = try GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)
        let task = Task { try await client.generate(request) }
        await fulfillment(of: [started], timeout: 3)
        task.cancel()
        release.signal()
        do { _ = try await task.value; XCTFail("Expected cancellation") }
        catch { XCTAssertEqual(error as? GenerationError, .cancelled) }
        let persisted = await identities.session()
        XCTAssertEqual(persisted?.accountID, saved.accountID)
    }

    func testRedirectIsRejected() {
        let delegate = NoRedirectDelegate()
        let task = URLSession.shared.dataTask(with: WorkerClient.endpoint)
        let response = HTTPURLResponse(url: WorkerClient.endpoint, statusCode: 302, httpVersion: nil, headerFields: ["Location": "https://example.com"])!
        delegate.urlSession(.shared, task: task, willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: "https://example.com")!)) { redirected in
            XCTAssertNil(redirected)
        }
        task.cancel()
    }
}

@MainActor
final class ControlledService: GenerationServing {
    var calls = 0
    var pollingResumes = 0
    func resumePolling() async { pollingResumes += 1 }
    var recoveryCalls = 0
    var acknowledgedIDs: [UUID] = []
    var onAcknowledgement: ((UUID) -> Void)?
    var recoverable: [PendingGeneration] = []
    var recoveredEntries: [PendingGeneration] = []
    var holdsRecovery = false
    var recoveryContinuations: [Int: CheckedContinuation<ColoringResult, Error>] = [:]
    func pendingGenerations() async -> [PendingGeneration] { recoverable }
    func recoverPending(_ pending: PendingGeneration) async throws -> ColoringResult {
        let index = recoveryCalls
        recoveryCalls += 1
        recoveredEntries.append(pending)
        if holdsRecovery {
            let result = try await withCheckedThrowingContinuation { recoveryContinuations[index] = $0 }
            try Task.checkCancellation()
            return result
        }
        let image = MockGenerator.sampleImage()
        return ColoringResult(data: image.pngData()!, image: image, requestedModel: pending.model, metrics: nil, generationID: pending.id)
    }
    func acknowledgeResult(_ id: UUID) async {
        onAcknowledgement?(id)
        acknowledgedIDs.append(id)
        recoverable.removeAll { $0.id == id }
    }
    func finishRecovery(at index: Int) {
        let entry = recoveredEntries[index]
        let image = MockGenerator.sampleImage()
        recoveryContinuations.removeValue(forKey: index)?.resume(returning:
            ColoringResult(data: image.pngData()!, image: image, requestedModel: entry.model, metrics: nil, generationID: entry.id))
    }
    var captured: [GenerationRequest] = []
    var continuations: [Int: CheckedContinuation<ColoringResult, Error>] = [:]
    var pendingCount: Int { continuations.count }
    func generate(_ request: GenerationRequest) async throws -> ColoringResult {
        calls += 1; captured.append(request)
        let index = calls - 1
        return try await withCheckedThrowingContinuation { continuations[index] = $0 }
    }
    func succeed() {
        for index in continuations.keys.sorted() { succeed(at: index) }
    }
    func succeed(at index: Int, generationID: UUID? = nil) {
        let image = MockGenerator.sampleImage(variation: index % ColoringViewModel.batchSize)
        continuations.removeValue(forKey: index)?.resume(returning: ColoringResult(data: image.pngData()!, image: image, requestedModel: .sunburst, metrics: nil, generationID: generationID))
    }
    func fail() {
        for index in continuations.keys.sorted() { fail(at: index) }
    }
    func fail(at index: Int) { continuations.removeValue(forKey: index)?.resume(throwing: GenerationError.uncertain) }
}

@MainActor
final class StateTests: XCTestCase {
    func waitFor(timeout: TimeInterval = 1, _ condition: @escaping () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while ContinuousClock.now < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("State did not settle")
    }
    func testRecoverUnfinishedSheetsAppendsWithoutGenerating() async {
        let suite = "RecoverGalleryTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults)
        store.age = 8; store.description = "Synthetic flower"; store.setImageCount(1)
        store.generate()
        await waitFor { service.pendingCount == 1 }
        service.succeed()
        await waitFor { store.phase == .result }
        let selected = store.selectedResultID
        service.recoverable = [PendingGeneration(id: UUID(), model: .redmond, createdAt: Date())]
        await store.refreshUnfinishedSheets()
        store.recoverUnfinishedSheets(); store.recoverUnfinishedSheets()
        await waitFor { store.phase == .result && store.unfinishedSheets.isEmpty }
        XCTAssertEqual(service.calls, 1); XCTAssertEqual(service.recoveryCalls, 1)
        XCTAssertEqual(store.results.count, 2)
        XCTAssertEqual(store.selectedResultID, selected)
        XCTAssertEqual(store.results.last?.requestedModel, .redmond)
        // Relaunch starts with an empty gallery; recovered output must be selected.
        let relaunched = ColoringViewModel(service: service, isMock: false, defaults: defaults)
        service.recoverable = [PendingGeneration(id: UUID(), model: .redmond, createdAt: Date())]
        await relaunched.refreshUnfinishedSheets()
        relaunched.recoverUnfinishedSheets()
        await waitFor { relaunched.phase == .result }
        XCTAssertEqual(relaunched.selectedResultID, relaunched.results.first?.id)
        XCTAssertNotNil(relaunched.selectedResultID)
    }

    func testUnlockKeepsSubmissionAliveWithoutAnotherGeneration() async {
        let suite = "UnlockRecoveryTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults)
        store.age = 8; store.description = "Synthetic flower"; store.setImageCount(1)
        store.generate()
        await waitFor { service.calls == 1 }
        let id = UUID()
        service.recoverable = [PendingGeneration(id: id, model: .sunburst, createdAt: Date(), batchID: service.captured[0].batchID)]
        store.enteredBackground()
        await store.enteredForeground()
        await store.enteredForeground()
        XCTAssertEqual(service.pollingResumes, 1, "Wake once per return, without restarting submissions")
        XCTAssertEqual(store.progressText, "Checking 1 sheet · 0 ready")
        XCTAssertTrue(store.isGenerating, "Lock must not cancel the original submission")
        XCTAssertEqual(service.recoveryCalls, 0)
        service.succeed(at: 0, generationID: id)
        await waitFor { store.phase == .result }
        XCTAssertEqual(service.calls, 1)
        XCTAssertEqual(store.results.count, 1)
        XCTAssertEqual(store.result?.generationID, id)

        store.generate()
        await waitFor { service.calls == 2 }
        service.recoverable = [PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date())]
        store.cancel()
        store.enteredBackground()
        await store.enteredForeground()
        XCTAssertEqual(service.recoveryCalls, 0, "User stop must not automatically resume on unlock")
        service.succeed()
    }

    func testFirstSheetAfterForegroundAppearsImmediatelyWhileOthersStillDraw() async {
        let suite = "ImmediateForegroundSheet-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        store.age = 8; store.description = "Synthetic flower"
        store.generate()
        await waitFor { service.calls == 3 }
        store.enteredBackground()
        await store.enteredForeground()
        service.succeed(at: 0)
        await waitFor { store.results.count == 1 }
        XCTAssertEqual(store.progressText, "Checking 3 sheets · 1 ready")
        XCTAssertEqual(store.readyCount, 1)
        XCTAssertTrue(store.isGenerating, "Show the first sheet before the other two finish")
        XCTAssertEqual(service.pollingResumes, 1)
        XCTAssertEqual(service.calls, 3)
        XCTAssertEqual(service.recoveryCalls, 0)
        service.succeed()
        await waitFor { store.phase == .result }
        XCTAssertEqual(store.results.count, 3)
    }

    func testUnlockReplacesPreviousTwoSheetsWithThreeFromInterruptedBatch() async {
        let suite = "ReplaceOnUnlock-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults)
        store.age = 8; store.description = "Synthetic flower"; store.setImageCount(2)
        store.generate()
        await waitFor { service.calls == 2 }
        service.succeed()
        await waitFor { store.phase == .result }
        let oldIDs = Set(store.results.map(\.id))
        XCTAssertEqual(oldIDs.count, 2)

        store.setImageCount(3)
        store.generate()
        await waitFor { service.calls == 5 }
        let batchID = service.captured[2].batchID
        let pending = (0..<3).map { _ in PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date(), batchID: batchID) }
        let stale = PendingGeneration(id: UUID(), model: .redmond, createdAt: Date(), batchID: UUID())
        service.recoverable = [stale] + pending
        store.enteredBackground()
        await store.enteredForeground()
        for index in 0..<3 { service.succeed(at: index + 2, generationID: pending[index].id) }
        await waitFor { store.phase == .result }
        XCTAssertEqual(service.calls, 5, "Unlock must never submit more generation requests")
        XCTAssertEqual(service.recoveryCalls, 0, "Keep the original requests; do not recover other batches")
        XCTAssertEqual(store.results.count, 3, "New batch must replace the previous two sheets")
        XCTAssertEqual(Set(store.results.compactMap(\.generationID)), Set(pending.map(\.id)))
        XCTAssertTrue(Set(store.results.map(\.id)).isDisjoint(with: oldIDs))
        await waitFor { service.acknowledgedIDs.count == 3 }
        XCTAssertEqual(service.recoverable.map(\.id), [stale.id])
        service.succeed() // Drain cancelled originals; they must not add sheets.
        await Task.yield()
        XCTAssertEqual(store.results.count, 3)
    }

    func testRepeatedUnlockPreservesPartialBatchAndSelectionWithoutDuplicates() async {
        let suite = "RepeatedUnlock-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = ControlledService()
        service.holdsRecovery = true
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults)
        store.age = 8; store.description = "Synthetic flower"
        store.generate()
        await waitFor { service.calls == 3 }
        let pending = (0..<3).map { _ in PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date(), batchID: service.captured[0].batchID) }
        service.recoverable = pending
        store.cancel()
        await store.refreshUnfinishedSheets()
        store.recoverUnfinishedSheets()
        await waitFor { service.recoveryCalls == 3 }
        XCTAssertTrue(store.progressText.hasPrefix("Checking"))
        store.enteredBackground() // Lock before any recovery result.
        await store.enteredForeground()
        XCTAssertEqual(service.recoveryCalls, 3, "Unlock must not replace in-flight recovery tasks")
        service.finishRecovery(at: 0)
        await waitFor { store.completedCount == 1 }
        let selected = store.selectedResultID
        store.enteredBackground() // Lock after the first sheet has arrived.
        await store.enteredForeground()
        for index in 1..<3 { service.finishRecovery(at: index) }
        await waitFor { store.phase == .result }
        XCTAssertEqual(store.results.count, 3)
        XCTAssertEqual(store.selectedResultID, selected)
        XCTAssertEqual(Set(store.results.compactMap(\.generationID)), Set(pending.map(\.id)))
        XCTAssertEqual(service.calls, 3)
        service.succeed()
    }

    func testManualRecoverySkipsAlreadyDisplayedGenerationIDs() async {
        let suite = "DeduplicatedRecovery-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults)
        store.age = 8; store.description = "Synthetic flower"; store.setImageCount(1)
        store.generate()
        await waitFor { service.calls == 1 }
        let id = UUID()
        service.succeed(at: 0, generationID: id)
        await waitFor { store.phase == .result }
        service.recoverable = [PendingGeneration(id: id, model: .sunburst, createdAt: Date())]
        await store.refreshUnfinishedSheets()
        store.recoverUnfinishedSheets()
        await Task.yield()
        XCTAssertEqual(store.results.count, 1)
        XCTAssertEqual(service.recoveryCalls, 0)
        XCTAssertEqual(service.calls, 1)
    }

    func testRelaunchRestoresGallerySelectionAndResumesOnlyUnfinishedPartOfBatch() async throws {
        let suite = "DurableGalleryTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let file = GalleryStore(url: directory.appendingPathComponent("gallery.json"))
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
        service.onAcknowledgement = { id in
            guard let saved = file.load() else {
                XCTFail("Gallery must exist before acknowledging a result")
                return
            }
            let storedIDs = (saved.sheets + saved.waitingToReveal).compactMap(\.generationID)
            XCTAssertTrue(storedIDs.contains(id), "Save the received PNG before removing its recovery ID")
        }
        store.age = 8; store.description = "Synthetic flower"
        store.generate()
        await waitFor { service.calls == 3 }
        let pending = (0..<3).map { _ in PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date(), batchID: service.captured[0].batchID) }
        service.recoverable = pending
        service.succeed(at: 0, generationID: pending[0].id)
        service.succeed(at: 1, generationID: pending[1].id)
        await waitFor { service.acknowledgedIDs.count == 2 }
        // The reveal delay has not ended. Simulate termination with no background callback.
        let relaunched = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
        XCTAssertEqual(relaunched.results.count, 2)
        relaunched.selectResult(at: 1)
        let selected = relaunched.selectedResultID
        let restoredSelection = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
        XCTAssertEqual(restoredSelection.selectedResultID, selected)
        await restoredSelection.enteredForeground()
        await waitFor { restoredSelection.phase == .result && restoredSelection.results.count == 3 }
        XCTAssertEqual(restoredSelection.selectedResultID, selected)
        XCTAssertEqual(service.recoveredEntries.map(\.id), [pending[2].id])
        XCTAssertEqual(service.calls, 3, "Relaunch must not generate replacements")
        await waitFor { Set(service.acknowledgedIDs).count == 3 }
        service.succeed() // Drain the original third request.
        await waitFor { store.phase == .result }
    }

    func testStoppedBatchRemainsManualAfterRelaunch() async throws {
        let suite = "StoppedGalleryTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let file = GalleryStore(url: directory.appendingPathComponent("gallery.json"))
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
        store.age = 8; store.description = "Synthetic flower"; store.setImageCount(1)
        store.generate()
        await waitFor { service.calls == 1 }
        service.recoverable = [PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date(), batchID: service.captured[0].batchID)]
        store.cancel()
        let relaunched = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
        await relaunched.enteredForeground()
        XCTAssertEqual(service.recoveryCalls, 0)
        XCTAssertEqual(relaunched.unfinishedSheets.count, 1)
        service.succeed()
    }

    func testFailedLocalSaveRetainsRecoveryID() async throws {
        let suite = "GallerySaveFailure-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let blocked = directory.appendingPathComponent("file-not-directory")
        try Data().write(to: blocked)
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults,
            galleryStore: GalleryStore(url: blocked.appendingPathComponent("gallery.json")))
        store.age = 8; store.description = "Synthetic flower"; store.setImageCount(1)
        store.generate()
        await waitFor { service.calls == 1 }
        let id = UUID()
        service.recoverable = [PendingGeneration(id: id, model: .sunburst, createdAt: Date())]
        service.succeed(at: 0, generationID: id)
        await waitFor { store.phase == .result }
        XCTAssertEqual(store.results.count, 1)
        XCTAssertTrue(service.acknowledgedIDs.isEmpty)
        XCTAssertEqual(service.recoverable.map(\.id), [id])
        XCTAssertTrue(store.batchMessage?.contains("could not be saved") == true)
    }

    func testLaterSuccessfulSaveAcknowledgesEverySavedSheet() async throws {
        let suite = "SaveRecovery-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let blocked = directory.appendingPathComponent("temporarily-blocked")
        try Data().write(to: blocked)
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let file = GalleryStore(url: blocked.appendingPathComponent("gallery.json"))
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
        store.age = 8; store.description = "Synthetic flower"; store.setImageCount(2)
        store.generate()
        await waitFor { service.calls == 2 }
        let entries = (0..<2).map { _ in PendingGeneration(id: UUID(), model: .sunburst, createdAt: Date()) }
        service.recoverable = entries
        service.succeed(at: 0, generationID: entries[0].id)
        await waitFor { store.readyCount == 1 }
        XCTAssertTrue(service.acknowledgedIDs.isEmpty)
        try FileManager.default.removeItem(at: blocked)
        service.succeed(at: 1, generationID: entries[1].id)
        await waitFor { store.phase == .result }
        await waitFor { service.recoverable.isEmpty }
        XCTAssertEqual(Set(service.acknowledgedIDs), Set(entries.map(\.id)))
        XCTAssertEqual(file.load()?.sheets.count, 2)
        XCTAssertNil(store.batchMessage, "A successful save must clear the obsolete save warning")
    }

    func testCompletedGalleryRetriesFailedSaveOnLifecycleChanges() async throws {
        for retryOnForeground in [false, true] {
            let suite = "LifecycleSaveRetry-" + UUID().uuidString
            let defaults = UserDefaults(suiteName: suite)!
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let blocked = directory.appendingPathComponent("temporarily-blocked")
            try Data().write(to: blocked)
            defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
            let file = GalleryStore(url: blocked.appendingPathComponent("gallery.json"))
            let service = ControlledService()
            let store = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
            store.age = 8; store.description = "Synthetic flower"; store.setImageCount(1)
            store.generate()
            await waitFor { service.calls == 1 }
            let id = UUID()
            service.recoverable = [PendingGeneration(id: id, model: .sunburst, createdAt: Date())]
            service.succeed(at: 0, generationID: id)
            await waitFor { store.phase == .result }
            XCTAssertTrue(service.acknowledgedIDs.isEmpty)
            if retryOnForeground { store.enteredBackground() }
            try FileManager.default.removeItem(at: blocked)
            if retryOnForeground { await store.enteredForeground() }
            else { store.enteredBackground() }
            XCTAssertEqual(file.load()?.sheets.compactMap(\.generationID), [id])
            XCTAssertNil(store.batchMessage)
            await waitFor { service.recoverable.isEmpty }
            XCTAssertEqual(service.calls, 1)
            XCTAssertEqual(service.recoveryCalls, 0)
        }
    }

    func testRelaunchAcknowledgesSheetSavedBeforeTermination() async throws {
        let suite = "SavedBeforeAcknowledgement-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let file = GalleryStore(url: directory.appendingPathComponent("gallery.json"))
        let id = UUID()
        let image = MockGenerator.sampleImage()
        let sheet = ColoringResult(data: image.pngData()!, image: image, requestedModel: .sunburst, metrics: nil, generationID: id)
        try file.save(GallerySnapshot(sheets: [GallerySnapshot.Sheet(sheet)], waitingToReveal: [],
            selectedID: sheet.id, hasRevealedResults: true, generationBatchID: UUID(), recoveringIDs: nil, shouldResume: true))
        let service = ControlledService()
        service.recoverable = [PendingGeneration(id: id, model: .sunburst, createdAt: Date())]
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
        await store.enteredForeground()
        await waitFor { service.recoverable.isEmpty }
        XCTAssertEqual(store.results.map(\.generationID), [id])
        XCTAssertEqual(service.recoveryCalls, 0, "The already saved PNG should not be downloaded again")
        XCTAssertEqual(service.calls, 0)
    }

    func testInterruptedTransportAfterUnlockAutomaticallyChecksExistingJob() async {
        let suite = "LateLockFailure-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults)
        store.age = 8; store.description = "Synthetic flower"; store.setImageCount(1)
        store.generate()
        await waitFor { service.calls == 1 }
        let id = UUID()
        service.recoverable = [PendingGeneration(id: id, model: .sunburst, createdAt: Date(), batchID: service.captured[0].batchID)]
        store.enteredBackground()
        await store.enteredForeground()
        service.fail() // URLSession interruption can arrive after foreground activation.
        await waitFor { store.phase == .result }
        XCTAssertEqual(service.recoveryCalls, 1)
        XCTAssertEqual(service.calls, 1)
        XCTAssertEqual(store.result?.generationID, id)
    }

    func testSettingsPersistAndControlNextBatch() async {
        let name = "SettingsTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        XCTAssertEqual(store.model, .sunburst)
        XCTAssertEqual(store.imageCount, 3)
        store.model = .flare
        store.setImageCount(1)
        store.age = 8; store.description = "Synthetic flower"
        let restored = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        XCTAssertEqual(restored.model, .flare)
        XCTAssertEqual(restored.imageCount, 1)
        store.generate()
        await waitFor { service.pendingCount == 1 }
        XCTAssertEqual(service.captured.map(\.model), [.flare])
        XCTAssertEqual(store.activeBatchSize, 1)
        store.setImageCount(5)
        store.model = .sunburst
        service.succeed()
        await waitFor { store.phase == .result }
        XCTAssertEqual(store.results.count, 1)
        store.generate()
        await waitFor { service.pendingCount == 3 }
        XCTAssertEqual(service.captured.dropFirst().map(\.model), Array(repeating: .sunburst, count: 3))
        service.succeed()
        await waitFor { store.phase == .result }
        XCTAssertEqual(store.results.count, 3)
        store.setImageCount(99)
        XCTAssertEqual(store.imageCount, 3)
        store.setImageCount(0)
        XCTAssertEqual(store.imageCount, 1)
        defaults.set(5, forKey: "imageCount")
        XCTAssertEqual(ColoringViewModel(service: service, isMock: true, defaults: defaults).imageCount, 3, "Old five-image preferences must be clamped")
        defaults.set(-4, forKey: "imageCount")
        XCTAssertEqual(ColoringViewModel(service: service, isMock: true, defaults: defaults).imageCount, 1)
        defaults.set("unsupported", forKey: "generationModel")
        XCTAssertEqual(ColoringViewModel(service: service, isMock: true, defaults: defaults).model, .sunburst)
        for removed in ["dreamshaper-8-lcm", "stable-diffusion-xl-lightning",
                        "stable-diffusion-xl-base-1.0", "lucid-origin",
                        "flux-1-schnell", "flux-2-dev"] {
            defaults.set(removed, forKey: "generationModel")
            XCTAssertEqual(ColoringViewModel(service: service, isMock: true, defaults: defaults).model, .sunburst)
        }
    }
    func testSelectionPersistenceDuplicatesFailureAndBackground() async {
        let name = "ColoringTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        XCTAssertEqual(store.age, 0)
        XCTAssertEqual(store.pageFormat, .a4Landscape)
        store.age = 3; store.description = "Synthetic flower"
        store.updatePreview(size: CGSize(width: 600, height: 700), displayScale: 2)
        XCTAssertEqual(ColoringViewModel(service: service, isMock: true, defaults: defaults).age, 3)
        store.generate(); store.generate()
        await waitFor { service.calls == ColoringViewModel.batchSize }
        XCTAssertEqual(service.pendingCount, ColoringViewModel.batchSize, "All requests start before any completes")
        XCTAssertEqual(ColoringViewModel.batchSize, 3)
        XCTAssertEqual(Set(service.captured.map(\.subject)).count, 3)
        XCTAssertTrue(service.captured.allSatisfy {
            $0.subject.hasPrefix("Synthetic flower\n\n") && $0.subject.contains("very simple") &&
            $0.model == .sunburst && $0.width == 1200 && $0.height == 848
        })
        XCTAssertEqual(Set(service.captured.map(\.subject)), Set(SheetComposition.allCases.prefix(3).map {
            "Synthetic flower\n\n" + (try! GenerationRequest.guidance(age: 3)) + "\n\n" + $0.guidance
        }))
        XCTAssertEqual(store.description, "Synthetic flower", "Composition guidance must not change the editable prompt")
        XCTAssertEqual(service.captured[0].model, .sunburst)
        XCTAssertEqual(service.captured[0].width, 1200)
        XCTAssertEqual(service.captured[0].height, 848)
        store.updatePreview(size: CGSize(width: 380, height: 890), displayScale: 2)
        XCTAssertEqual(service.captured[0].width, 1200, "Resizing must not change an in-flight request")
        store.age = 18; store.description = "Synthetic tree"
        XCTAssertTrue(service.captured[0].subject.contains("very simple"))
        service.succeed()
        await waitFor { store.phase == .result }
        let previous = store.result?.data
        store.generate(); await waitFor { service.calls == ColoringViewModel.batchSize * 2 }
        XCTAssertEqual(service.captured[ColoringViewModel.batchSize].width, 960)
        XCTAssertEqual(service.captured[ColoringViewModel.batchSize].height, 688)
        service.fail(); await waitFor { !store.isGenerating }
        XCTAssertEqual(store.result?.data, previous)
        XCTAssertEqual(store.description, "Synthetic tree")
        store.generate(); await waitFor { service.calls == ColoringViewModel.batchSize * 3 }
        store.enteredBackground(); service.succeed()
        await waitFor { !store.isGenerating }
        XCTAssertEqual(service.calls, ColoringViewModel.batchSize * 3)
        XCTAssertEqual(store.results.count, 3)
        XCTAssertEqual(store.phase, .result, "Lock must not discard the original results")
        defaults.set(99, forKey: "childAge")
        XCTAssertEqual(ColoringViewModel(service: service, isMock: true, defaults: defaults).age, 0)
    }

    func testParallelArrivalsSelectionExportsAndPartialFailure() async throws {
        let name = "BatchTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        store.age = 6; store.description = "Dinosaur riding a bike on the moon"
        store.generate(); store.generate()
        await waitFor { service.pendingCount == ColoringViewModel.batchSize }
        XCTAssertEqual(service.calls, ColoringViewModel.batchSize)
        service.succeed(at: 2)
        await waitFor { store.readyCount == 1 }
        let firstReceived = ContinuousClock.now
        XCTAssertTrue(store.results.isEmpty)
        XCTAssertNil(store.result)
        service.succeed(at: 1)
        await waitFor { store.readyCount == 2 }
        store.selectResult(at: 1)
        XCTAssertNil(store.selectedResultID, "Buffered images cannot be paged through")
        try await Task.sleep(for: .seconds(4))
        XCTAssertTrue(store.results.isEmpty, "Do not reveal images before the five-second window ends")
        await waitFor(timeout: 2) { store.results.count == 2 }
        XCTAssertGreaterThanOrEqual(firstReceived.duration(to: .now), .seconds(4.95))
        let first = try XCTUnwrap(store.result)
        XCTAssertTrue(store.isGenerating)
        XCTAssertEqual(store.readyCount, 2)
        store.selectResult(at: 1)
        let second = try XCTUnwrap(store.result)
        XCTAssertNotEqual(first.data, second.data)
        service.fail(at: 0)
        await waitFor { !store.isGenerating }
        XCTAssertEqual(store.phase, .result)
        XCTAssertEqual(store.results.count, 2)
        XCTAssertEqual(store.completedCount, ColoringViewModel.batchSize)
        XCTAssertEqual(store.failedCount, 1)
        XCTAssertNotNil(store.batchMessage)
        XCTAssertEqual(store.result?.id, second.id)
        XCTAssertEqual(store.results.first?.id, first.id, "Later results append without reordering")
        store.selectResult(at: -1); store.selectResult(at: 2)
        XCTAssertEqual(store.result?.id, second.id, "Invalid navigation must keep the selection")
        let exported = try ExportItem(kind: .share, result: XCTUnwrap(store.result))
        defer { exported.cleanUp() }
        XCTAssertEqual(try Data(contentsOf: exported.url), second.data)
        XCTAssertTrue(exported.image === second.image)
        XCTAssertEqual(service.calls, ColoringViewModel.batchSize, "Browsing and exporting must not generate or retry")

        store.generate()
        await waitFor { service.pendingCount == ColoringViewModel.batchSize }
        XCTAssertEqual(store.result?.id, second.id, "Retain the previous selection while drawing")
        service.fail()
        await waitFor { !store.isGenerating }
        XCTAssertEqual(store.results.count, 2)
        XCTAssertEqual(store.result?.id, second.id, "A completely failed batch preserves the gallery")
        XCTAssertNil(store.batchMessage)
        if case .error = store.phase {} else { XCTFail("Expected a full-batch error") }
    }

    func testCancellationRetainsCompletedSheetsAndIgnoresStaleCompletions() async throws {
        let name = "BatchCancellationTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        store.age = 8; store.description = "A moon bicycle"
        store.generate()
        await waitFor { service.pendingCount == ColoringViewModel.batchSize }
        XCTAssertEqual(Set(service.captured.map(\.batchID)).count, 1)
        XCTAssertNotNil(service.captured.first?.batchID)
        XCTAssertEqual(Set(service.captured.compactMap { $0.composition?.rawValue }), ["side", "front", "wide"])
        service.succeed(at: 2)
        await waitFor { store.readyCount == 1 }
        XCTAssertTrue(store.results.isEmpty)
        store.cancel()
        let stopped = DiagnosticLog.shared.events.last { $0.stage == "Batch summary" }
        XCTAssertTrue(stopped?.outcome.contains("user stopped waiting") == true)
        XCTAssertTrue(stopped?.outcome.contains("succeeded=1; failed=0; unfinished=2") == true)
        XCTAssertNotNil(stopped?.batchID)
        let retainedID = try XCTUnwrap(store.result?.id)
        XCTAssertFalse(store.isGenerating)
        XCTAssertNotNil(store.batchMessage)
        XCTAssertEqual(store.result?.id, retainedID)

        store.generate()
        await waitFor { service.calls == ColoringViewModel.batchSize * 2 }
        for index in [0, 1] { service.succeed(at: index) }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.completedCount, 0, "Cancelled responses cannot enter a new batch")
        XCTAssertEqual(store.result?.id, retainedID)
        service.succeed(at: ColoringViewModel.batchSize + 1)
        await waitFor { store.completedCount == 1 }
        XCTAssertEqual(store.results.count, 1)
        XCTAssertEqual(store.result?.id, retainedID, "Retain the previous gallery during the reveal delay")
        store.enteredBackground()
        let background = DiagnosticLog.shared.events.last { $0.stage == "Batch summary" }
        XCTAssertTrue(background?.outcome.contains("app entered background") == true)
        XCTAssertNotEqual(background?.batchID, stopped?.batchID)
        let newID = try XCTUnwrap(store.result?.id)
        XCTAssertNotEqual(newID, retainedID)
        service.succeed()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.result?.id, newID)
        XCTAssertEqual(store.results.count, 3)
        XCTAssertEqual(store.completedCount, 3)
        XCTAssertEqual(service.calls, ColoringViewModel.batchSize * 2)
    }

    func testCompletedBatchRevealsImmediatelyAndLaterArrivalsPreserveSelection() async throws {
        let name = "BatchRevealTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        store.age = 8; store.description = "A moon bicycle"
        store.generate()
        await waitFor { service.pendingCount == ColoringViewModel.batchSize }
        service.succeed(at: 0)
        await waitFor { store.readyCount == 1 }
        XCTAssertTrue(store.results.isEmpty)
        service.succeed()
        await waitFor { store.phase == .result }
        XCTAssertEqual(store.results.count, ColoringViewModel.batchSize, "Completion bypasses the five-second delay")
        store.selectResult(at: 2)
        let previousID = store.result?.id

        store.generate()
        await waitFor { service.pendingCount == ColoringViewModel.batchSize }
        service.succeed(at: ColoringViewModel.batchSize + 2)
        await waitFor { store.readyCount == 1 }
        XCTAssertEqual(store.result?.id, previousID)
        await waitFor(timeout: 6) { store.results.count == 1 }
        XCTAssertNotEqual(store.result?.id, previousID)
        service.succeed(at: ColoringViewModel.batchSize + 1)
        await waitFor { store.results.count == 2 }
        store.selectResult(at: 1)
        let selectedID = store.result?.id
        service.succeed(at: ColoringViewModel.batchSize)
        await waitFor { store.results.count == 3 }
        XCTAssertEqual(store.result?.id, selectedID)
        service.fail()
        await waitFor { store.phase == .result }
        XCTAssertEqual(store.result?.id, selectedID)
    }

    func testPartialFailureRevealsBufferedSuccessWithoutWaiting() async {
        let name = "BatchPartialRevealTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        store.age = 8; store.description = "A moon bicycle"
        store.generate()
        await waitFor { service.pendingCount == ColoringViewModel.batchSize }
        service.fail(at: 0)
        service.succeed(at: 2)
        await waitFor { store.completedCount == 2 }
        XCTAssertTrue(store.results.isEmpty)
        service.fail()
        await waitFor { store.phase == .result }
        XCTAssertEqual(store.results.count, 1)
        XCTAssertEqual(store.failedCount, 2)
        XCTAssertNotNil(store.batchMessage)
    }

    func testCancelBeforeTasksStartAndInvalidInputMakeNoRequests() async throws {
        let name = "BatchValidationTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        store.generate()
        XCTAssertFalse(store.isGenerating)
        store.age = 6; store.description = "A friendly dinosaur"
        store.generate(); store.cancel()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(service.calls, 0)
        XCTAssertTrue(store.results.isEmpty)
    }

    func testAllCompositionsValidateBeforeAnyRequestStarts() async throws {
        let name = "CompositionValidationTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        store.age = 6
        let longest = try XCTUnwrap(SheetComposition.allCases.prefix(3).max { $0.guidance.utf16.count < $1.guidance.utf16.count })
        let overhead = try GenerationRequest.guidance(age: 6).utf16.count + longest.guidance.utf16.count + 4
        let limit = 500 - overhead
        let valid = String(repeating: "😀", count: limit / 2) + (limit % 2 == 1 ? "x" : "")
        let request = try GenerationRequest(description: valid, age: 6, model: .sunburst, composition: longest)
        XCTAssertEqual(request.subject.utf16.count, 500)
        XCTAssertLessThanOrEqual(try request.encoded().count, 4096)
        store.description = valid
        XCTAssertNil(store.validationMessage)
        store.description += "x"
        // The first composition fits, but a later one exceeds the limit.
        XCTAssertNoThrow(try GenerationRequest(description: store.description, age: 6, model: .sunburst, composition: .side))
        XCTAssertNotNil(store.validationMessage)
        store.generate()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(service.calls, 0, "A later invalid composition must prevent the entire paid batch")
        XCTAssertFalse(store.isGenerating)
        XCTAssertEqual(store.description, valid + "x", "Never silently truncate a user's description")
    }
}

import SwiftUI

@MainActor
final class KeyboardFocusTests: XCTestCase {
    private let recentIPadLandscapeSizes: [(String, CGSize)] = [
        ("iPad 9th generation", CGSize(width: 1080, height: 810)),
        ("iPad mini 6", CGSize(width: 1133, height: 744)),
        ("iPad 10th generation", CGSize(width: 1180, height: 820)),
        ("iPad Air 11 inch", CGSize(width: 1180, height: 820)),
        ("iPad Air 13 inch", CGSize(width: 1366, height: 1024)),
        ("iPad Pro 11 inch", CGSize(width: 1210, height: 834)),
        ("iPad Pro 13 inch", CGSize(width: 1376, height: 1032))
    ]

    private func textInput(in view: UIView) -> UIView? {
        if view is UITextField { return view }
        if let text = view as? UITextView, text.isEditable { return text }
        return view.subviews.lazy.compactMap { self.textInput(in: $0) }.first
    }

    private func allSubviews(in view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap(allSubviews)
    }

    private func assertMainPageDoesNotScroll(_ host: UIHostingController<ContentView>, file: StaticString = #filePath, line: UInt = #line) {
        let largeScrollingView = allSubviews(in: host.view).compactMap { $0 as? UIScrollView }.first { scrollView in
            let frame = scrollView.convert(scrollView.bounds, to: host.view)
            return frame.height >= host.view.bounds.height * 0.6 &&
                scrollView.contentSize.height > scrollView.bounds.height + 1
        }
        XCTAssertNil(largeScrollingView, "The main page must fit without scrolling.", file: file, line: line)
    }

    private func capture(_ name: String, view: UIView) {
        let image = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testDescriptionRetainsResponderWhenKeyboardChangesLayout() async throws {
        let suite = "KeyboardFocusTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ColoringViewModel(service: MockGenerator(), isMock: true, defaults: defaults)
        store.age = 6
        store.description = "Synthetic flower"
        store.generate()
        for _ in 0..<200 where store.isGenerating { try await Task.sleep(for: .milliseconds(10)) }
        let previousImage = try XCTUnwrap(store.result?.data)
        store.description = ""
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: ContentView(store: store))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKey() }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeLeft))
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(600))
        capture("Landscape sheet with expanded composer", view: window)
        let input = try XCTUnwrap(textInput(in: host.view))

        XCTAssertTrue(input.becomeFirstResponder())
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertTrue(input === textInput(in: host.view), "Keyboard layout must preserve the same text input")
        XCTAssertTrue(input.isFirstResponder, "The field must retain focus after the layout changes")
        let keyboardInput = try XCTUnwrap(input as? UIKeyInput)
        let emptyFrame = input.convert(input.bounds, to: host.view)
        keyboardInput.insertText("S")
        try await Task.sleep(for: .milliseconds(150))
        let firstCharacterFrame = input.convert(input.bounds, to: host.view)
        XCTAssertEqual(firstCharacterFrame.minY, emptyFrame.minY, accuracy: 1,
                       "Typing the first character must not move the description")
        XCTAssertEqual(firstCharacterFrame.height, emptyFrame.height, accuracy: 1)
        keyboardInput.deleteBackward()
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(input.convert(input.bounds, to: host.view).minY, emptyFrame.minY, accuracy: 1,
                       "Clearing the description must not move the composer")
        keyboardInput.insertText("Synthetic scene")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(store.description, "Synthetic scene")
        XCTAssertEqual(store.result?.data, previousImage, "Typing must retain the generated image")
        capture("Landscape sheet while keyboard is open", view: window)

        XCTAssertTrue(input.resignFirstResponder())
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertTrue(input === textInput(in: host.view), "Dismissing the keyboard must preserve the same field")
        XCTAssertFalse(input.isFirstResponder)
        XCTAssertTrue(input.becomeFirstResponder())
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(input.isFirstResponder)
        XCTAssertEqual(store.description, "Synthetic scene")
        input.resignFirstResponder()
    }

    func testSuccessfulGenerationPreservesEditorAndNeverInterruptsTyping() async throws {
        let suite = "ComposerTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = ControlledService()
        let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
        store.age = 6; store.description = "Synthetic flower"
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: ContentView(store: store))
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKey() }
        try await Task.sleep(for: .milliseconds(150))
        let input = try XCTUnwrap(textInput(in: host.view))
        store.generate()
        for _ in 0..<100 where service.pendingCount < ColoringViewModel.batchSize { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(input.becomeFirstResponder())
        try await Task.sleep(for: .milliseconds(350))
        service.succeed()
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertEqual(store.phase, .result)
        XCTAssertTrue(input.isFirstResponder, "A finishing generation must not interrupt typing")
        XCTAssertTrue(input === textInput(in: host.view))

        input.resignFirstResponder()
        try await Task.sleep(for: .milliseconds(350))
        store.generate()
        for _ in 0..<100 where service.pendingCount < ColoringViewModel.batchSize { try await Task.sleep(for: .milliseconds(10)) }
        service.fail()
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertNotNil(textInput(in: host.view), "Failure must leave the description available")
        XCTAssertNotNil(store.result)

        store.generate()
        for _ in 0..<100 where service.pendingCount < ColoringViewModel.batchSize { try await Task.sleep(for: .milliseconds(10)) }
        service.succeed()
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertTrue(input === textInput(in: host.view), "Success must preserve the same editable field")
        XCTAssertFalse(input.isFirstResponder, "Success must not open the keyboard automatically")
        XCTAssertTrue(input.becomeFirstResponder())
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertTrue(input.isFirstResponder, "The existing field must accept focus immediately after generation")
        XCTAssertEqual(store.description, "Synthetic flower")
        XCTAssertEqual(service.calls, ColoringViewModel.batchSize * 3)
        capture("Landscape sheet editing after generation", view: window)
        input.resignFirstResponder()
    }

    func testMinimizedPromptUsesOnlyItsFirstLine() {
        XCTAssertEqual(ContentView.minimizedPrompt(from: "A dinosaur in a garden\nwith flowers"),
                       "A dinosaur in a garden")
        XCTAssertEqual(ContentView.minimizedPrompt(from: ""), "Edit description")
    }

    func testComposerFitsRecentIPadLandscapeSizesWithoutScrolling() async throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else {
            throw XCTSkip("iPad window fixtures require an iPad scene; phone layouts are covered by GalleryUITests.")
        }
        let suite = "ComposerLayoutTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ColoringViewModel(service: MockGenerator(), isMock: true, defaults: defaults)
        store.age = 6; store.description = "A flower in a sunny garden"
        store.generate()
        for _ in 0..<200 where store.isGenerating { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(store.result)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let container = UIViewController()
        window.rootViewController = container; window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKey() }
        for (device, size) in recentIPadLandscapeSizes {
            let host = UIHostingController(rootView: ContentView(store: store))
            container.addChild(host); container.view.addSubview(host.view)
            host.view.frame = CGRect(origin: .zero, size: size)
            host.didMove(toParent: container)
            try await Task.sleep(for: .milliseconds(250))
            host.view.layoutIfNeeded()
            let input = try XCTUnwrap(textInput(in: host.view))
            let inputFrame = input.convert(input.bounds, to: host.view)
            XCTAssertTrue(host.view.bounds.contains(inputFrame), "Description must remain inside the \(device) landscape window")
            XCTAssertGreaterThan(inputFrame.width, 80)
            assertMainPageDoesNotScroll(host)
            capture("Expanded composer \(device)", view: host.view)

            XCTAssertTrue(input.becomeFirstResponder())
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertTrue(input.isFirstResponder, "The editor must remain focused on \(device)")
            let focusedFrame = input.convert(input.bounds, to: host.view)
            XCTAssertTrue(host.view.bounds.contains(focusedFrame), "The focused editor must remain visible on \(device)")
            assertMainPageDoesNotScroll(host)
            input.resignFirstResponder()
            host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
        }
    }

    func testPostGenerationComposerFitsRecentIPadLandscapeSizesWithoutScrolling() async throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else {
            throw XCTSkip("iPad window fixtures require an iPad scene; phone layouts are covered by GalleryUITests.")
        }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let container = UIViewController()
        window.rootViewController = container; window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKey() }

        for (device, size) in recentIPadLandscapeSizes {
            let suite = "PostGenerationComposerLayoutTests-" + UUID().uuidString
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            let service = ControlledService()
            let store = ColoringViewModel(service: service, isMock: true, defaults: defaults)
            store.age = 6; store.description = "A dinosaur riding a bicycle in a flower garden"
            let host = UIHostingController(rootView: ContentView(store: store))
            container.addChild(host); container.view.addSubview(host.view)
            host.view.frame = CGRect(origin: .zero, size: size)
            host.didMove(toParent: container)
            try await Task.sleep(for: .milliseconds(100))
            store.generate()
            for _ in 0..<100 where service.pendingCount < ColoringViewModel.batchSize { try await Task.sleep(for: .milliseconds(10)) }
            service.succeed()
            try await Task.sleep(for: .milliseconds(400))
            XCTAssertNotNil(textInput(in: host.view), "A successful generation must leave the editor available on \(device)")
            assertMainPageDoesNotScroll(host)
            capture("Post-generation composer \(device)", view: host.view)
            host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
        }
    }
}
