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
            XCTAssertEqual(json["width"] as? Int, 1024)
            XCTAssertEqual(json["height"] as? Int, 1456)
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
    func response(_ status: Int = 200, type: String = "image/png", metrics: String? = nil) -> HTTPURLResponse {
        var headers = ["Content-Type": type]
        if let metrics { headers["x-generation-metrics"] = metrics }
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
        for status in [302, 400, 413, 429, 500, 502, 504] {
            XCTAssertThrowsError(try WorkerClient.parse(Data("<html>private diagnostics</html>".utf8), response: response(status, type: "text/html"), requestedModel: .flare)) {
                XCTAssertFalse($0.localizedDescription.contains("private diagnostics"))
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
    var continuation: CheckedContinuation<ColoringResult, Error>?
    func generate(_ request: GenerationRequest) async throws -> ColoringResult {
        calls += 1; captured.append(request)
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func succeed() {
        let image = MockGenerator.sampleImage()
        continuation?.resume(returning: ColoringResult(data: image.pngData()!, image: image, requestedModel: .flare, metrics: nil)); continuation = nil
    }
    func fail() { continuation?.resume(throwing: GenerationError.uncertain); continuation = nil }
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
        store.age = 3; store.description = "Synthetic flower"
        store.updatePreview(size: CGSize(width: 600, height: 700), displayScale: 2)
        XCTAssertEqual(ColoringViewModel(service: service, isMock: true, defaults: defaults).age, 3)
        store.generate(); store.generate()
        await waitFor { service.calls == 1 }
        XCTAssertEqual(service.captured[0].model, .sunburst)
        XCTAssertEqual(service.captured[0].width, 992)
        XCTAssertEqual(service.captured[0].height, 1408)
        store.updatePreview(size: CGSize(width: 380, height: 890), displayScale: 2)
        XCTAssertEqual(service.captured[0].width, 992, "Resizing must not change an in-flight request")
        store.age = 18; store.description = "Synthetic tree"
        XCTAssertTrue(service.captured[0].subject.contains("very simple"))
        service.succeed()
        await waitFor { store.phase == .result }
        let previous = store.result?.data
        store.generate(); await waitFor { service.calls == 2 }
        XCTAssertEqual(service.captured[1].width, 768)
        XCTAssertEqual(service.captured[1].height, 1072)
        service.fail(); await waitFor { !store.isGenerating }
        XCTAssertEqual(store.result?.data, previous)
        XCTAssertEqual(store.description, "Synthetic tree")
        store.generate(); await waitFor { service.calls == 3 }
        store.enteredBackground(); service.succeed()
        await waitFor { !store.isGenerating }
        XCTAssertEqual(service.calls, 3)
        XCTAssertEqual(store.result?.data, previous)
        if case .error(let message) = store.phase { XCTAssertTrue(message.contains("charge")) } else { XCTFail("Expected uncertainty") }
        defaults.set(99, forKey: "childAge")
        XCTAssertEqual(ColoringViewModel(service: service, isMock: true, defaults: defaults).age, 0)
    }
}

import SwiftUI

@MainActor
final class KeyboardFocusTests: XCTestCase {
    private func textInput(in view: UIView) -> UIView? {
        if view is UITextField { return view }
        if let text = view as? UITextView, text.isEditable { return text }
        return view.subviews.lazy.compactMap { self.textInput(in: $0) }.first
    }

    func testDescriptionRetainsResponderWhenKeyboardChangesLayout() async throws {
        let suite = "KeyboardFocusTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ColoringViewModel(service: MockGenerator(), isMock: true, defaults: defaults)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: ContentView(store: store))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKey() }
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        let input = try XCTUnwrap(textInput(in: host.view))

        XCTAssertTrue(input.becomeFirstResponder())
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertTrue(input === textInput(in: host.view), "Keyboard layout must preserve the same text input")
        XCTAssertTrue(input.isFirstResponder, "The field must retain focus after the layout changes")
        let keyboardInput = try XCTUnwrap(input as? UIKeyInput)
        keyboardInput.insertText("Synthetic scene")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(store.description, "Synthetic scene")

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
}
