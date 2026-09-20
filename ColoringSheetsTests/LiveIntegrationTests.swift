import XCTest
@testable import ColoringSheets

/// Opt-in only. Standard test runs skip this test and never send paid requests.
final class LiveIntegrationTests: XCTestCase {
    func testExplicitTwoGenerationCheck() async throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_LIVE_CHECK"] == "two-generations" else {
            throw XCTSkip("Paid integration check requires explicit opt-in.")
        }
        let configuration = AppConfiguration.load()
        guard !configuration.mock, !configuration.credential.isEmpty else {
            XCTFail("Live build configuration is required.")
            return
        }
        let client = WorkerClient(credential: configuration.credential)
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
