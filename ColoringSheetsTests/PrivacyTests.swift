import XCTest
import UIKit
@testable import ColoringSheets

@MainActor
private final class PrivacyService: GenerationServing {
    var generations = 0
    var reports = 0
    var deletions = 0
    var failDeletion = false
    var failReport = false
    var pending: [PendingGeneration] = []
    func generate(_ request: GenerationRequest) async throws -> ColoringResult {
        generations += 1
        let image = MockGenerator.sampleImage()
        return ColoringResult(data: image.pngData()!, image: image, requestedModel: request.model, metrics: nil, generationID: UUID())
    }
    func deleteAccount() async throws {
        deletions += 1
        if failDeletion { throw URLError(.notConnectedToInternet) }
        pending = []
    }
    func reportSheet(_ id: UUID, reason: String) async throws {
        reports += 1
        if failReport { throw URLError(.notConnectedToInternet) }
    }
    func pendingGenerations() async -> [PendingGeneration] { pending }
}

@MainActor
final class PrivacyTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!
    override func setUp() {
        suite = "PrivacyTests-\(UUID())"
        defaults = UserDefaults(suiteName: suite)!
    }
    override func tearDown() { defaults.removePersistentDomain(forName: suite) }
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<150 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Privacy operation did not finish")
    }
    private func store(_ service: PrivacyService, file: GalleryStore? = nil) -> ColoringViewModel {
        let store = ColoringViewModel(service: service, isMock: false, defaults: defaults, galleryStore: file)
        store.description = "A friendly flower"; store.setImageCount(1)
        return store
    }
    func testConsentSendsNothingUntilAcceptedAndSurvivesRelaunch() async {
        let service = PrivacyService()
        let model = store(service)
        await model.enteredForeground()
        model.generate()
        XCTAssertTrue(model.showsConsent)
        model.showsConsent = false // Cancel or swipe dismissal.
        XCTAssertFalse(model.hasConsent)
        XCTAssertEqual(model.description, "A friendly flower")
        XCTAssertEqual(service.generations, 0)
        let active = store(service)
        active.generate(); XCTAssertEqual(service.generations, 0)
        active.acceptConsent()
        await waitFor { active.results.count == 1 }
        XCTAssertEqual(service.generations, 1)
        let relaunched = store(service)
        XCTAssertTrue(relaunched.hasConsent)
        relaunched.generate()
        await waitFor { relaunched.results.count == 1 }
        XCTAssertFalse(relaunched.showsConsent)
        XCTAssertEqual(service.generations, 2)
        relaunched.withdrawConsent()
        relaunched.generate()
        XCTAssertTrue(relaunched.showsConsent)
        XCTAssertEqual(service.generations, 2)
    }
    func testMaterialConsentVersionChangeRequiresNewPermission() {
        defaults.set(PrivacyConsent.currentVersion - 1, forKey: PrivacyConsent.key)
        let service = PrivacyService()
        let model = store(service)
        model.generate()
        XCTAssertTrue(model.showsConsent)
        XCTAssertFalse(model.hasConsent)
        XCTAssertEqual(service.generations, 0)
    }
    func testDeletionFailureKeepsDataAndRetrySurvivesRelaunch() async throws {
        defaults.set(PrivacyConsent.currentVersion, forKey: PrivacyConsent.key)
        let service = PrivacyService()
        let file = GalleryStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("privacy-\(UUID())/gallery.json"))
        defer { try? file.remove() }
        let model = store(service, file: file)
        model.generate(); await waitFor { model.results.count == 1 }
        XCTAssertNotNil(file.load())
        service.failDeletion = true
        await model.deleteAccountAndData()
        XCTAssertTrue(model.deletionPending)
        XCTAssertEqual(model.results.count, 1)
        let retry = store(service, file: file)
        retry.generate()
        XCTAssertTrue(retry.deletionPending)
        XCTAssertEqual(service.generations, 1)
        service.failDeletion = false
        await retry.deleteAccountAndData()
        XCTAssertEqual(service.deletions, 2)
        XCTAssertFalse(retry.deletionPending)
        XCTAssertTrue(retry.results.isEmpty)
        XCTAssertEqual(retry.description, "")
        XCTAssertFalse(retry.hasConsent)
        XCTAssertNil(file.load())
    }
    func testReportFailurePreservesSheetAndSuccessRemovesIt() async {
        defaults.set(PrivacyConsent.currentVersion, forKey: PrivacyConsent.key)
        let service = PrivacyService()
        let model = store(service)
        let active = model
        active.generate(); await waitFor { active.results.count == 1 }
        service.failReport = true
        await active.reportSelectedSheet(reason: .violence)
        XCTAssertEqual(active.results.count, 1)
        service.failReport = false
        await active.reportSelectedSheet(reason: .violence)
        XCTAssertTrue(active.results.isEmpty)
        XCTAssertEqual(service.reports, 2)
        XCTAssertEqual(service.generations, 1)
        XCTAssertTrue(active.hasConsent) // Saved choice remains unchanged by reporting.
    }
    func testWorkerDeletionUsesExpiredCredentialWithoutRegisteringAndRetainsItOnFailure() async throws {
        let identities = AnonymousIdentityStore(service: "privacy-keychain-\(UUID())")
        let saved = AnonymousSession(accountID: UUID(), accessToken: "synthetic-expired", expiresAt: .distantPast)
        try await identities.save(saved)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel(); MockURLProtocol.handler = nil }
        let client = WorkerClient(serviceURL: URL(string: "https://privacy.example")!, session: session, identities: identities)
        var methods: [String] = [], fail = true
        MockURLProtocol.handler = { request in
            methods.append(request.httpMethod!)
            XCTAssertEqual(request.url?.path, "/v1/account")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-expired")
            return (HTTPURLResponse(url: request.url!, statusCode: fail ? 503 : 200, httpVersion: nil, headerFields: nil)!, Data((fail ? "{}" : "{\"deleted\":true}").utf8))
        }
        do { try await client.deleteAccount(); XCTFail("Must not discard credentials before confirmation") } catch {}
        let retained = await identities.session()
        XCTAssertEqual(retained, saved)
        fail = false
        try await client.deleteAccount()
        let removed = await identities.session()
        XCTAssertNil(removed)
        XCTAssertEqual(methods, ["DELETE", "DELETE"])
        try await client.deleteAccount()
        XCTAssertEqual(methods.count, 2, "No saved account means no new registration just to delete")
    }
}
