import XCTest
import UIKit
@testable import ColoringSheets

final class GenerationTests: XCTestCase {
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

    func testLimitFailuresPreserveCategoryAndRequestID() {
        let rateResponse = response(429, type: "text/plain", headers: [
            "X-OpenAI-Error-Category": "rate_limit", "Retry-After": "4", "X-OpenAI-Request-ID": "req_rate_123"
        ])
        XCTAssertThrowsError(try WorkerClient.parse(Data(), response: rateResponse, requestedModel: .flare)) {
            XCTAssertEqual($0 as? GenerationError, .limit(.temporaryRateLimit, retryAfter: 4, requestID: "req_rate_123"))
            XCTAssertTrue($0.localizedDescription.contains("4 seconds"))
        }
        let creditResponse = response(429, type: "text/plain", headers: [
            "X-OpenAI-Error-Category": "credit_balance_exhausted", "X-OpenAI-Request-ID": "req_credit_123"
        ])
        XCTAssertThrowsError(try WorkerClient.parse(Data(), response: creditResponse, requestedModel: .flare)) {
            XCTAssertEqual($0 as? GenerationError, .limit(.creditBalanceExhausted, retryAfter: nil, requestID: "req_credit_123"))
            XCTAssertTrue($0.localizedDescription.contains("credit"))
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
    func testOnePOSTAndNoRetryForBothModelsAndTimeout() async throws {
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
        XCTAssertEqual(calls, 2)
        MockURLProtocol.handler = { _ in calls += 1; throw URLError(.timedOut) }
        do { _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error as? GenerationError, .uncertain) }
        XCTAssertEqual(calls, 3)
    }
    func testRetriesOnlyTemporaryRateLimitsAtMostTwice() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let client = WorkerClient(credential: "synthetic-dummy", session: session, retryJitter: { 0 })
        var calls = 0
        MockURLProtocol.handler = { request in
            calls += 1
            if calls <= WorkerClient.maximumRateLimitRetries {
                return (HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: [
                    "Content-Type": "text/plain", "X-OpenAI-Error-Category": "rate_limit", "Retry-After": "1", "X-OpenAI-Request-ID": "req_\(calls)"
                ])!, Data())
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, MockGenerator.sampleImage().pngData()!)
        }
        _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .flare))
        XCTAssertEqual(calls, WorkerClient.maximumRateLimitRetries + 1)

        calls = 0
        MockURLProtocol.handler = { request in
            calls += 1
            return (HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: [
                "Content-Type": "text/plain", "X-OpenAI-Error-Category": "credit_balance_exhausted"
            ])!, Data())
        }
        do { _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)); XCTFail("Expected credit failure") }
        catch { XCTAssertEqual(error as? GenerationError, .limit(.creditBalanceExhausted, retryAfter: nil, requestID: nil)) }
        XCTAssertEqual(calls, 1)

        calls = 0
        MockURLProtocol.handler = { request in
            calls += 1
            return (HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: [
                "Content-Type": "text/plain", "X-OpenAI-Error-Category": "rate_limit", "Retry-After": "1"
            ])!, Data())
        }
        do { _ = try await client.generate(GenerationRequest(description: "Synthetic flower", age: 8, model: .flare)); XCTFail("Expected rate limit failure") }
        catch { XCTAssertEqual(error as? GenerationError, .limit(.temporaryRateLimit, retryAfter: 1, requestID: nil)) }
        XCTAssertEqual(calls, WorkerClient.maximumRateLimitRetries + 1)
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
    func succeed(at index: Int) {
        let image = MockGenerator.sampleImage(variation: index % ColoringViewModel.batchSize)
        continuations.removeValue(forKey: index)?.resume(returning: ColoringResult(data: image.pngData()!, image: image, requestedModel: .sunburst, metrics: nil))
    }
    func fail() {
        for index in continuations.keys.sorted() { fail(at: index) }
    }
    func fail(at index: Int) { continuations.removeValue(forKey: index)?.resume(throwing: GenerationError.uncertain) }
}

@MainActor
final class StateTests: XCTestCase {
    func waitFor(_ condition: @escaping () -> Bool) async {
        for _ in 0..<100 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("State did not settle")
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
        XCTAssertEqual(ColoringViewModel.batchSize, 5)
        XCTAssertEqual(Set(service.captured.map(\.subject)).count, 5)
        XCTAssertTrue(service.captured.allSatisfy {
            $0.subject.hasPrefix("Synthetic flower\n\n") && $0.subject.contains("very simple") &&
            $0.model == .sunburst && $0.width == 1200 && $0.height == 848
        })
        XCTAssertEqual(Set(service.captured.map(\.subject)), Set(SheetComposition.allCases.map {
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
        XCTAssertEqual(store.result?.data, previous)
        if case .error(let message) = store.phase { XCTAssertTrue(message.contains("charge")) } else { XCTFail("Expected uncertainty") }
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
        await waitFor { store.results.count == 1 }
        let first = try XCTUnwrap(store.result)
        XCTAssertTrue(store.isGenerating)
        XCTAssertEqual(store.readyCount, 1)
        service.succeed(at: 1)
        await waitFor { store.results.count == 2 }
        XCTAssertEqual(store.result?.id, first.id, "An arriving image must not change the selected sheet")
        store.selectResult(at: 1)
        let second = try XCTUnwrap(store.result)
        XCTAssertNotEqual(first.data, second.data)
        service.fail(at: 0)
        service.fail(at: 3)
        service.fail(at: 4)
        await waitFor { !store.isGenerating }
        XCTAssertEqual(store.phase, .result)
        XCTAssertEqual(store.results.count, 2)
        XCTAssertEqual(store.completedCount, ColoringViewModel.batchSize)
        XCTAssertEqual(store.failedCount, 3)
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
        service.succeed(at: 2)
        await waitFor { store.results.count == 1 }
        let retainedID = store.result?.id
        store.cancel()
        XCTAssertFalse(store.isGenerating)
        XCTAssertNotNil(store.batchMessage)
        XCTAssertEqual(store.result?.id, retainedID)

        store.generate()
        await waitFor { service.calls == ColoringViewModel.batchSize * 2 }
        for index in [0, 1, 3, 4] { service.succeed(at: index) }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.completedCount, 0, "Cancelled responses cannot enter a new batch")
        XCTAssertEqual(store.result?.id, retainedID)
        service.succeed(at: ColoringViewModel.batchSize + 1)
        await waitFor { store.completedCount == 1 }
        XCTAssertEqual(store.results.count, 1)
        XCTAssertNotEqual(store.result?.id, retainedID)
        let newID = store.result?.id
        store.enteredBackground()
        service.succeed()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.result?.id, newID)
        XCTAssertEqual(store.results.count, 1)
        XCTAssertEqual(store.completedCount, 1)
        XCTAssertEqual(service.calls, ColoringViewModel.batchSize * 2)
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
        let longest = try XCTUnwrap(SheetComposition.allCases.max { $0.guidance.utf16.count < $1.guidance.utf16.count })
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

    func testSuccessfulGenerationMinimizesComposerButNeverInterruptsTyping() async throws {
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
        XCTAssertNil(textInput(in: host.view), "Success should collapse an unfocused composer")
        XCTAssertEqual(store.description, "Synthetic flower")
        XCTAssertEqual(service.calls, ColoringViewModel.batchSize * 3)
        capture("Landscape sheet with minimized composer", view: window)
    }

    func testMinimizedPromptUsesOnlyItsFirstLine() {
        XCTAssertEqual(ContentView.minimizedPrompt(from: "A dinosaur in a garden\nwith flowers"),
                       "A dinosaur in a garden")
        XCTAssertEqual(ContentView.minimizedPrompt(from: ""), "Edit description")
    }

    func testComposerFitsRecentIPadLandscapeSizesWithoutScrolling() async throws {
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

    func testMinimizedComposerFitsRecentIPadLandscapeSizesWithoutScrolling() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let container = UIViewController()
        window.rootViewController = container; window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKey() }

        for (device, size) in recentIPadLandscapeSizes {
            let suite = "MinimizedComposerLayoutTests-" + UUID().uuidString
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
            XCTAssertNil(textInput(in: host.view), "A successful generation must minimize the composer on \(device)")
            assertMainPageDoesNotScroll(host)
            capture("Minimized composer \(device)", view: host.view)
            host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
        }
    }
}
