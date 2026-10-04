import Foundation
import OSLog
import UIKit

enum ImageModel: String, CaseIterable, Codable, Identifiable {
    case flare = "gpt-image-2.5-flare"
    case sunburst = "gpt-image-2.5-sunburst"
    case fluxKlein4B = "flux-2-klein-4b"
    case fluxKlein9B = "flux-2-klein-9b"
    case fluxDev = "flux-2-dev"
    case fluxSchnell = "flux-1-schnell"
    case lucidOrigin = "lucid-origin"
    case phoenix = "phoenix-1.0"
    case sdxl = "stable-diffusion-xl-base-1.0"
    case sdxlLightning = "stable-diffusion-xl-lightning"
    case dreamShaper = "dreamshaper-8-lcm"
    case redmond = "coloringbook-redmond-v2"
    // Keep older cases decodable so unfinished generations can still be recovered.
    static let selectable: [ImageModel] = [
        .flare, .sunburst, .fluxKlein4B, .fluxKlein9B, .phoenix, .redmond
    ]
    var id: String { rawValue }
    var label: String {
        switch self {
        case .redmond: return "ColoringBook.Redmond V2 (Beta)"
        case .flare: return "Flare"
        case .sunburst: return "Sunburst"
        case .fluxKlein4B: return "FLUX.2 Klein 4B"
        case .fluxKlein9B: return "FLUX.2 Klein 9B"
        case .fluxDev: return "FLUX.2 Dev"
        case .fluxSchnell: return "FLUX.1 Schnell"
        case .lucidOrigin: return "Lucid Origin"
        case .phoenix: return "Phoenix 1.0"
        case .sdxl: return "Stable Diffusion XL (Beta)"
        case .sdxlLightning: return "SDXL Lightning (Beta)"
        case .dreamShaper: return "DreamShaper 8 LCM"
        }
    }
    var detail: String {
        switch self {
        case .redmond: return "A specialist coloring-page style. Sheets may wait in a queue before drawing starts."
        case .flare, .sunburst: return "Uses OpenAI image generation."
        case .fluxKlein4B: return "A quick option for trying out coloring-page ideas."
        case .fluxKlein9B: return "A larger version of Klein for comparing detail and composition."
        case .fluxDev: return "Try for detailed scenes. Generation can take longer."
        case .fluxSchnell: return "A quick alternative that uses a fixed image size. The whole image fits on the printed page."
        case .lucidOrigin: return "Try for illustrated scenes and specific style instructions."
        case .phoenix: return "Try for scenes with several objects and detailed instructions."
        case .sdxl: return "A classic illustration alternative. Available in beta."
        case .sdxlLightning: return "A faster Stable Diffusion alternative. Available in beta."
        case .dreamShaper: return "An alternative to compare for imaginative subjects and illustration styles."
        }
    }
}

// App-owned page policy: a future format picker only needs to bind pageFormat.
enum PageFormat: CaseIterable {
    case a4Portrait, a4Landscape, square
    var aspectRatio: CGFloat {
        switch self {
        case .a4Portrait: return 210.0 / 297.0
        case .a4Landscape: return 297.0 / 210.0
        case .square: return 1
        }
    }
    func fittedSize(in available: CGSize) -> CGSize {
        let width = max(0, min(available.width, available.height * aspectRatio))
        return CGSize(width: width, height: width / aspectRatio)
    }
    func imageSize(for available: CGSize, displayScale: CGFloat) -> GenerationSize {
        let page = fittedSize(in: available)
        guard page.width.isFinite, page.height.isFinite, page.width > 0, page.height > 0,
              displayScale.isFinite, displayScale > 0 else {
            return imageSize(for: CGSize(width: 1024, height: 1456), displayScale: 1)
        }
        let targetWidth = min(page.width, 10000) * min(displayScale, 4)
        let targetHeight = targetWidth / aspectRatio
        let targetPixels = targetWidth * targetHeight
        let pixels = min(CGFloat(GenerationSize.maxPixels), max(CGFloat(GenerationSize.minPixels), targetPixels))
        let factor = sqrt(pixels / targetPixels)
        let width = targetWidth * factor, height = targetHeight * factor
        func aligned(_ value: CGFloat, _ rule: FloatingPointRoundingRule) -> Int {
            Int((value / 16).rounded(rule)) * 16
        }
        var size = GenerationSize(width: aligned(width, .toNearestOrAwayFromZero), height: aligned(height, .toNearestOrAwayFromZero))
        if size.width * size.height < GenerationSize.minPixels {
            size = GenerationSize(width: aligned(width, .up), height: aligned(height, .up))
        } else if size.width * size.height > GenerationSize.maxPixels {
            size = GenerationSize(width: aligned(width, .down), height: aligned(height, .down))
        }
        return size
    }
}

struct GenerationSize: Equatable {
    static let minPixels = 655360, maxPixels = 3686400
    static let a4Default = GenerationSize(width: 1456, height: 1024)
    let width: Int
    let height: Int
    var isValid: Bool {
        guard (16...3840).contains(width), (16...3840).contains(height) else { return false }
        return width % 16 == 0 && height % 16 == 0 &&
            width <= height * 3 && height <= width * 3 &&
            (Self.minPixels...Self.maxPixels).contains(width * height)
    }
    var cgSize: CGSize { CGSize(width: width, height: height) }
}

enum SheetComposition: String, CaseIterable {
    case side, front, wide, close, elevated
    var guidance: String {
        let view: String
        switch self {
        case .side: view = "side view, full subject in profile"
        case .front: view = "front view, subject facing the viewer"
        case .wide: view = "wide view, smaller subject within its surroundings"
        case .close: view = "close view, subject filling most of the page, no cropping"
        case .elevated: view = "elevated view, looking down at the scene"
        }
        return "Composition preference: \(view). Preserve the subject; explicit user instructions take priority."
    }
}

struct GenerationRequest: Encodable, Equatable {
    let subject: String
    let originalDescription: String
    let age: Int
    let composition: SheetComposition?
    let batchID: UUID?
    let model: ImageModel
    let width: Int
    let height: Int

    static func guidance(age: Int) throws -> String {
        switch age {
        case 3...5: return "Complexity: very simple outlines, a few large enclosed coloring areas, few objects, minimal background detail."
        case 6...8: return "Complexity: simple clear outlines, large enclosed coloring areas, several objects, light background detail."
        case 9...12: return "Complexity: moderately detailed outlines, varied medium coloring areas, several objects and a detailed background."
        case 13...18: return "Complexity: intricate outlines, smaller enclosed coloring areas, many fine details and a rich, layered scene."
        default: throw GenerationError.validation("Choose a child’s age from 3 to 18.")
        }
    }

    init(description: String, age: Int, model: ImageModel, size: GenerationSize = .a4Default,
         composition: SheetComposition? = nil, batchID: UUID? = nil) throws {
        guard size.isValid else { throw GenerationError.validation("The page size is unsupported. Choose a smaller page size.") }
        width = size.width; height = size.height
        let original = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !original.isEmpty else { throw GenerationError.validation("Describe what you’d like on the sheet.") }
        originalDescription = original; self.age = age; self.composition = composition; self.batchID = batchID
        subject = original + "\n\n" + (try Self.guidance(age: age)) +
            (composition.map { "\n\n" + $0.guidance } ?? "")
        self.model = model
        guard subject.utf16.count <= 500 else {
            throw GenerationError.validation("Please shorten the description. It must fit within 500 characters including the complexity guidance.")
        }
        _ = try encoded()
    }

    private enum CodingKeys: String, CodingKey { case subject, description, age, composition, batchID, model, width, height }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let batchID {
            guard let composition else { throw GenerationError.configuration }
            try container.encode(originalDescription, forKey: .description)
            try container.encode(age, forKey: .age)
            try container.encode(composition.rawValue, forKey: .composition)
            try container.encode(batchID.uuidString.lowercased(), forKey: .batchID)
        } else {
            try container.encode(subject, forKey: .subject)
        }
        try container.encode(model, forKey: .model)
        try container.encode(width, forKey: .width)
        try container.encode(height, forKey: .height)
    }

    func encoded() throws -> Data {
        let data = try JSONEncoder().encode(self)
        guard data.count <= 4096 else { throw GenerationError.validation("Please shorten the description; the request is too large.") }
        return data
    }
}

struct GenerationMetrics: Decodable {
    let requestedSize: String?
    let size: String?
    let requestedModel: String?
    let provider: String?
    let upstreamModel: String?
    let viaGateway: Bool?
    let inputTokens: Int?
    let textInputTokens: Int?
    let imageInputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let estimatedInputUsd: Double?
    let estimatedOutputUsd: Double?
    let estimatedTotalUsd: Double?
    let elapsedMs: Double?
    let estimateBasis: String?
    let ratesChecked: String?
    let seed: Int?
    let modelRevision: String?
    let inferenceMs: Double?
    let providerRequestID: String?
    let billableUnits: Double?
    let unitPriceUsd: Double?
    let billingUnit: String?
    let reportedCostUsd: Double?
    let costStatus: String?
    let costCheckedAt: String?
    let inferenceSteps: Int?

    static func decode(_ header: String?) -> Self? {
        guard let text = header?.removingPercentEncoding, let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}

struct ColoringResult: Identifiable {
    let id = UUID()
    let data: Data
    let image: UIImage
    let requestedModel: ImageModel
    var metrics: GenerationMetrics?
    let access: AccessSnapshot?
    let generationID: UUID?

    init(data: Data, image: UIImage, requestedModel: ImageModel, metrics: GenerationMetrics?,
         access: AccessSnapshot? = nil, generationID: UUID? = nil) {
        self.data = data; self.image = image; self.requestedModel = requestedModel
        self.metrics = metrics; self.access = access; self.generationID = generationID
    }
}

enum GenerationError: LocalizedError, Equatable {
    case validation(String), configuration, deviceVerification, deviceRejected, allowance, serviceBudget, upstream(String), server(Int), invalidImage, uncertain, cancelled
    var errorDescription: String? {
        switch self {
        case .validation(let message), .upstream(let message): return message
        case .configuration: return "The coloring service needs a configuration update. Contact the developer for an updated app."
        case .deviceVerification: return "Secure device verification failed before the generation request was sent. Check Settings → Diagnostics for the failing step and code."
        case .deviceRejected: return "The service rejected secure device verification before image generation. Check Diagnostics for the Worker error code."
        case .allowance: return "Today’s image allowance has been used. Please try again after midnight UTC."
        case .serviceBudget: return "The coloring service has reached today’s limit. Please try again after it resets."
        case .server(let status): return "The service could not complete the request (HTTP \(status)). Contact the developer if this continues."
        case .invalidImage: return "The service did not return a valid PNG. Generation may have been charged. Check usage before trying again."
        case .uncertain: return "The connection was interrupted or timed out. Generation may still finish and be charged. Check usage before choosing to generate again."
        case .cancelled: return "Stopped waiting. The server may still generate and charge for this sheet. Check usage before choosing to generate again."
        }
    }
}

struct PendingGeneration: Codable, Identifiable {
    let id: UUID
    let model: ImageModel
    let createdAt: Date
}

// Only opaque IDs and model selections are retained; no prompts or credentials.
actor PendingGenerationStore {
    static let shared = PendingGenerationStore()
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    func list(scope: String) -> [PendingGeneration] {
        guard let data = defaults.data(forKey: "pendingGenerations." + scope),
              let entries = try? JSONDecoder().decode([PendingGeneration].self, from: data) else { return [] }
        return entries.filter { $0.createdAt > Date().addingTimeInterval(-86400) }
    }
    func add(_ entry: PendingGeneration, scope: String) throws {
        var entries = list(scope: scope).filter { $0.id != entry.id }
        entries.append(entry)
        defaults.set(try JSONEncoder().encode(entries), forKey: "pendingGenerations." + scope)
    }
    func remove(_ id: UUID, scope: String) {
        let entries = list(scope: scope).filter { $0.id != id }
        defaults.set(try? JSONEncoder().encode(entries), forKey: "pendingGenerations." + scope)
    }
}

protocol GenerationServing {
    func generate(_ request: GenerationRequest) async throws -> ColoringResult
    func generationMetrics(_ id: UUID) async throws -> GenerationMetrics?
    func pendingGenerations() async -> [PendingGeneration]
    func recoverPending(_ pending: PendingGeneration) async throws -> ColoringResult
}
extension GenerationServing {
    func generationMetrics(_ id: UUID) async throws -> GenerationMetrics? { nil }
    func pendingGenerations() async -> [PendingGeneration] { [] }
    func recoverPending(_ pending: PendingGeneration) async throws -> ColoringResult { throw GenerationError.configuration }
}

// Deny every redirect, including same-host redirects: never forward this bearer credential.
final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class WorkerClient: GenerationServing {
    static let defaultServiceURL = URL(string: "https://coloring-sheets-api.jordan-erenrich.workers.dev")!
    static let endpoint = defaultServiceURL.appending(path: "/v1/generations")
    private static let logger = Logger(subsystem: "com.jordan.family.ColoringSheets", category: "WorkerClient")
    private let serviceURL: URL
    private let endpoint: URL
    // This exists solely for isolated legacy-parser/network tests. The app does not
    // bundle or use shared credentials.
    private let legacyCredential: String?
    private let identities: AnonymousIdentityStore?
    private let appAttest = AppAttestClient()
    private let session: URLSession
    private let pendingStore: PendingGenerationStore
    private let recoverySleep: @Sendable (Duration) async throws -> Void

    init(serviceURL: URL = defaultServiceURL, session: URLSession? = nil, identities: AnonymousIdentityStore = AnonymousIdentityStore(),
         pendingStore: PendingGenerationStore = .shared,
         recoverySleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.serviceURL = serviceURL
        self.endpoint = serviceURL.appending(path: "/v1/generations")
        self.legacyCredential = nil
        self.identities = identities
        self.pendingStore = pendingStore
        self.recoverySleep = recoverySleep
        self.session = Self.makeSession(session)
    }

    init(credential: String, session: URLSession? = nil) {
        self.serviceURL = Self.defaultServiceURL
        self.endpoint = Self.endpoint
        self.legacyCredential = credential
        self.identities = nil
        self.pendingStore = .shared
        self.recoverySleep = { try await Task.sleep(for: $0) }
        self.session = Self.makeSession(session)
    }

    private static func makeSession(_ supplied: URLSession?) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 240
        config.timeoutIntervalForResource = 240
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.waitsForConnectivity = false
        return supplied ?? URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    func generate(_ request: GenerationRequest) async throws -> ColoringResult {
        var http = URLRequest(url: endpoint)
        http.httpMethod = "POST"
        let authToken: String
        do { authToken = try await authorization() }
        catch {
            await DiagnosticLog.shared.record("Account", "failed before generation", model: request.model, error: error)
            throw error
        }
        // Shared identity registration/renewal can finish after this caller stops waiting.
        guard !Task.isCancelled else { throw GenerationError.cancelled }
        let generationID = UUID()
        await DiagnosticLog.shared.record("Generation", "started", generationID: generationID, model: request.model)
        http.setValue("Bearer " + authToken, forHTTPHeaderField: "Authorization")
        http.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let idempotencyKey = generationID.uuidString.lowercased()
        http.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        http.setValue("1", forHTTPHeaderField: "X-Coloring-API-Version")
        let requestBody = try request.encoded()
        http.httpBody = requestBody
        if legacyCredential == nil, let accountID = await identities?.session()?.accountID {
            do {
                let headers = try await appAttest.proof(accountID: accountID, token: authToken,
                                                        serviceURL: serviceURL, session: session,
                                                        idempotencyKey: idempotencyKey, body: requestBody)
                for (name, value) in headers ?? [:] { http.setValue(value, forHTTPHeaderField: name) }
            } catch {
                await DiagnosticLog.shared.record("Device verification", "failed before generation POST",
                                                  generationID: generationID, model: request.model, error: error)
                throw GenerationError.deviceVerification
            }
        }
        if request.model == .redmond, let scope = await pendingScope() {
            try await pendingStore.add(PendingGeneration(id: generationID, model: request.model, createdAt: Date()), scope: scope)
        }
        if Task.isCancelled {
            if let scope = await pendingScope() { await pendingStore.remove(generationID, scope: scope) }
            throw GenerationError.cancelled
        }
        let data: Data
        let response: URLResponse
        await DiagnosticLog.shared.record("Generation POST", "sending", generationID: generationID, model: request.model)
        do { (data, response) = try await session.data(for: http) }
        catch {
            Self.logger.error("Generation transport failed id=\(generationID.uuidString, privacy: .public) urlError=\((error as? URLError)?.errorCode ?? 0)")
            await DiagnosticLog.shared.record("Generation POST", "transport failed; checking existing job",
                                              generationID: generationID, model: request.model, error: error)
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw GenerationError.cancelled }
            if legacyCredential != nil { throw GenerationError.uncertain }
            return try await recover(generationID, authorization: authToken, requestedModel: request.model)
        }
        guard let response = response as? HTTPURLResponse else { throw GenerationError.uncertain }
        Self.logResponse("generation", data: data, response: response, generationID: generationID)
        await DiagnosticLog.shared.record("Generation POST", "response", generationID: generationID,
                                          model: request.model, httpStatus: response.statusCode,
                                          workerCode: Self.workerErrorCode(data, response: response))
        if let outcome = Self.moderationDiagnostic(data, response: response) {
            await DiagnosticLog.shared.record("Content moderation", outcome, generationID: generationID,
                                              model: request.model, httpStatus: response.statusCode,
                                              workerCode: Self.workerErrorCode(data, response: response))
        }
        if response.statusCode == 202 {
            return try await recover(generationID, authorization: authToken, requestedModel: request.model)
        }
        // A configuration rejection happens before the server reserves a job.
        if response.statusCode == 503, ["service_unavailable", "moderation_unavailable"].contains(Self.workerErrorCode(data, response: response) ?? ""),
           let scope = await pendingScope() {
            await pendingStore.remove(generationID, scope: scope)
        }
        return try await parseRecovered(data, response: response, generationID: generationID, requestedModel: request.model)
    }

    private func recover(_ generationID: UUID, authorization: String, requestedModel: ImageModel) async throws -> ColoringResult {
        let started = ContinuousClock.now
        var completedAttempts = 0
        var lastState: String?
        var exhausted = false
        func summary(_ outcome: String, error: Error? = nil) async {
            let duration = started.duration(to: .now).components
            let elapsed = duration.seconds * 1000 + duration.attoseconds / 1_000_000_000_000_000
            await DiagnosticLog.shared.record("Recovery summary", "\(outcome); attempts=\(completedAttempts); elapsedMs=\(elapsed)", generationID: generationID, model: requestedModel, error: error)
        }
        let attempts = requestedModel == .redmond ? 40 : 3
        do {
            for attempt in 0..<attempts {
                try Task.checkCancellation()
                if attempt > 0 {
                    try await recoverySleep(.seconds(requestedModel == .redmond ? min(15, attempt * 5) : 5))
                }
                var request = URLRequest(url: endpoint.appending(path: generationID.uuidString.lowercased()))
                request.timeoutInterval = 30
                request.setValue("Bearer " + authorization, forHTTPHeaderField: "Authorization")
                completedAttempts += 1
                do {
                    let (data, response) = try await session.data(for: request)
                    guard let http = response as? HTTPURLResponse else { continue }
                    let code = Self.workerErrorCode(data, response: http)
                    let state = "HTTP \(http.statusCode):\(code ?? "none")"
                    if state != lastState {
                        Self.logResponse("recovery", data: data, response: http, generationID: generationID)
                        await DiagnosticLog.shared.record("Recovery", "state changed; attempt=\(attempt + 1)", generationID: generationID, model: requestedModel, httpStatus: http.statusCode, workerCode: code)
                        lastState = state
                    }
                    if http.statusCode == 202 { continue }
                    let result = try await parseRecovered(data, response: http, generationID: generationID, requestedModel: requestedModel)
                    await summary("recovered")
                    return result
                } catch is CancellationError { throw GenerationError.cancelled }
                catch let error as GenerationError { throw error }
                catch {
                    if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw GenerationError.cancelled }
                    let nsError = error as NSError
                    let state = "\(nsError.domain):\(nsError.code)"
                    if state != lastState {
                        await DiagnosticLog.shared.record("Recovery", "transport failed; attempt=\(attempt + 1)", generationID: generationID, model: requestedModel, error: error)
                        lastState = state
                    }
                }
            }
            exhausted = true
            await summary("attempts exhausted")
            throw GenerationError.uncertain
        } catch {
            if error is CancellationError || Self.isCancelled(error) {
                await summary("cancelled")
                throw GenerationError.cancelled
            }
            if !exhausted {
                await summary("failed", error: error)
            }
            throw error
        }
    }

    private static func isCancelled(_ error: Error) -> Bool {
        if case GenerationError.cancelled = error { return true }
        return false
    }
    func generationMetrics(_ id: UUID) async throws -> GenerationMetrics? {
        var request = URLRequest(url: endpoint.appending(path: id.uuidString.lowercased()).appending(path: "usage"))
        request.setValue("Bearer " + (try await authorization()), forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count <= 16384 else { return nil }
        struct UsageResponse: Decodable { let metrics: GenerationMetrics? }
        return try JSONDecoder().decode(UsageResponse.self, from: data).metrics
    }

    private func pendingScope() async -> String? {
        guard let saved = await identities?.session() else { return nil }
        return serviceURL.absoluteString + "/" + saved.accountID.uuidString.lowercased()
    }

    func pendingGenerations() async -> [PendingGeneration] {
        guard let scope = await pendingScope() else { return [] }
        return await pendingStore.list(scope: scope)
    }

    func recoverPending(_ pending: PendingGeneration) async throws -> ColoringResult {
        let credential = try await authorization()
        guard await pendingGenerations().contains(where: { $0.id == pending.id }) else { throw GenerationError.configuration }
        return try await recover(pending.id, authorization: credential, requestedModel: pending.model)
    }

    private func parseRecovered(_ data: Data, response: HTTPURLResponse, generationID: UUID,
                                requestedModel: ImageModel) async throws -> ColoringResult {
        guard !Task.isCancelled else { throw GenerationError.cancelled }
        do {
            let result = try Self.parse(data, response: response, requestedModel: requestedModel)
            await DiagnosticLog.shared.record("Generation result", "ready", generationID: generationID, model: requestedModel)
            if let scope = await pendingScope() { await pendingStore.remove(generationID, scope: scope) }
            return result
        } catch {
            if response.statusCode == 200, let reason = Self.imageValidationFailure(data, response: response) {
                await DiagnosticLog.shared.record("Response validation", reason, generationID: generationID, model: requestedModel)
            }
            await DiagnosticLog.shared.record("Generation result", "unusable", generationID: generationID,
                                              model: requestedModel, error: error)
            // Keep interrupted, authentication and transient failures recoverable.
            let terminal = [400, 410, 422, 429].contains(response.statusCode) ||
                (response.statusCode == 502 && Self.workerErrorCode(data, response: response) != nil)
            if terminal, let scope = await pendingScope() { await pendingStore.remove(generationID, scope: scope) }
            throw error
        }
    }

    private func authorization() async throws -> String {
        if let legacyCredential, !legacyCredential.isEmpty { return legacyCredential }
        guard let identities else { throw GenerationError.configuration }
        let saved = try await identities.session(
            register: { [self] in try await installationSession() },
            renew: { [self] saved in try await installationSession(renewing: saved) })
        return saved.accessToken
    }

    private func installationSession(renewing saved: AnonymousSession? = nil) async throws -> AnonymousSession {
        let path = saved == nil ? "/v1/installations" : "/v1/installations/renew"
        var request = URLRequest(url: serviceURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let saved { request.setValue("Bearer " + saved.accessToken, forHTTPHeaderField: "Authorization") }
        request.httpBody = Data("{}".utf8)
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            Self.logger.error("Installation transport failed urlError=\((error as? URLError)?.errorCode ?? 0)")
            await DiagnosticLog.shared.record(saved == nil ? "Account registration" : "Account renewal",
                                              "transport failed", error: error)
            throw GenerationError.uncertain
        }
        if let http = response as? HTTPURLResponse {
            Self.logResponse(saved == nil ? "installation" : "renewal", data: data, response: http)
            await DiagnosticLog.shared.record(saved == nil ? "Account registration" : "Account renewal",
                                              "response", httpStatus: http.statusCode,
                                              workerCode: Self.workerErrorCode(data, response: http))
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == (saved == nil ? 201 : 200),
              let created = try? JSONDecoder().decode(InstallationResponse.self, from: data),
              let accountID = UUID(uuidString: created.accountID), !created.accessToken.isEmpty else {
            throw GenerationError.configuration
        }
        return AnonymousSession(accountID: accountID, accessToken: created.accessToken,
                                expiresAt: Date(timeIntervalSince1970: created.expiresAt))
    }

    // Only log protocol fields. A response can contain a token, prompt, or image,
    // so never print its body, headers, URL, or localized error text.
    static func workerErrorCode(_ data: Data, response: HTTPURLResponse) -> String? {
        let contentType = response.value(forHTTPHeaderField: "Content-Type")?.lowercased()
            .split(separator: ";").first?.trimmingCharacters(in: .whitespaces)
        guard response.statusCode >= 400,
              contentType == "application/json",
              data.count <= 4096,
              let body = try? JSONDecoder().decode(WorkerErrorBody.self, from: data) else { return nil }
        let code = body.error.code
        guard !code.isEmpty, code.utf8.count <= 64,
              code.utf8.allSatisfy({ ($0 >= 97 && $0 <= 122) || $0 == 95 }) else { return nil }
        return code
    }

    static func moderationDiagnostic(_ data: Data, response: HTTPURLResponse) -> String? {
        let code = workerErrorCode(data, response: response)
        if code == "moderation_unavailable", response.statusCode == 503 {
            return "safety check unavailable; allowanceUsed=false"
        }
        guard code == "description_not_suitable", response.statusCode == 400 else { return nil }
        // Only fixed server-owned reason codes may enter the shared report.
        let known: Set<String> = ["sexual", "violence", "hate", "adult", "frightening", "bypass", "uncertain"]
        let reasons = ((try? JSONDecoder().decode(WorkerErrorBody.self, from: data))?.error.reasonCodes ?? [])
            .filter { known.contains($0) }
        let codes = Set(reasons).sorted().joined(separator: ",")
        return "description rejected; reasons=\(codes.isEmpty ? "unspecified" : codes); allowanceUsed=false"
    }

    private static func logResponse(_ stage: String, data: Data, response: HTTPURLResponse, generationID: UUID? = nil) {
        let code = workerErrorCode(data, response: response) ?? "none"
        let id = generationID?.uuidString ?? "none"
        if response.statusCode >= 400 {
            logger.error("Worker \(stage, privacy: .public) response id=\(id, privacy: .public) status=\(response.statusCode) code=\(code, privacy: .public)")
        } else {
            logger.notice("Worker \(stage, privacy: .public) response id=\(id, privacy: .public) status=\(response.statusCode)")
        }
    }

    // The Worker translates provider failures into bounded, user-facing messages.
    // Accept that contract, not arbitrary HTML/text from a proxy or provider.
    private static func workerErrorMessage(_ data: Data, response: HTTPURLResponse) -> String? {
        guard let code = workerErrorCode(data, response: response) else { return nil }
        let expectedStatus: Int
        switch code {
        case "upstream_failed", "result_save_failed", "provider_daily_quota_exhausted",
             "provider_quota_exhausted", "provider_content_rejected", "provider_authentication_failed",
             "provider_access_denied", "provider_model_unavailable", "provider_rate_limited",
             "provider_timeout", "provider_unavailable", "provider_request_rejected",
             "provider_connection_failed", "provider_invalid_response", "provider_image_conversion_failed":
            expectedStatus = 502
        case "service_unavailable", "moderation_unavailable": expectedStatus = 503
        case "invalid_request", "description_not_suitable": expectedStatus = 400
        case "result_unavailable": expectedStatus = 410
        default: return nil
        }
        guard response.statusCode == expectedStatus,
              let body = try? JSONDecoder().decode(WorkerErrorBody.self, from: data),
              let message = body.error.message?.trimmingCharacters(in: .whitespacesAndNewlines),
              !message.isEmpty, message.count <= 800,
              !message.contains("<"), !message.contains(">"),
              !message.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return message
    }

    static func parse(_ data: Data, response: HTTPURLResponse, requestedModel: ImageModel) throws -> ColoringResult {
        let contentType = response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces)
        guard response.statusCode == 200 else {
            if response.statusCode == 403,
               ["invalid_assertion", "app_attest_required"].contains(workerErrorCode(data, response: response) ?? "") {
                throw GenerationError.deviceRejected
            }
            if let message = workerErrorMessage(data, response: response) {
                throw response.statusCode == 400 ? GenerationError.validation(message) : GenerationError.upstream(message)
            }
            switch response.statusCode {
            case 401, 403, 404, 405, 415, 503: throw GenerationError.configuration
            case 429:
                if workerErrorCode(data, response: response) == "service_budget_exhausted" {
                    throw GenerationError.serviceBudget
                }
                throw GenerationError.allowance
            case 400, 413: throw GenerationError.validation("The service rejected the description or page size. Revise the description or check the app and Worker versions.")
            case 504: throw GenerationError.uncertain
            case 502:
                // Only display the known sanitized Worker messages, never arbitrary response text.
                let body = contentType == "text/plain" ? String(data: data.prefix(512), encoding: .utf8) ?? "" : ""
                if body.contains("insufficient credit or quota") || body.contains("rate or quota limit") {
                    throw GenerationError.upstream("The image provider reports a credit or quota limit. Ask the developer to check API billing and limits before trying again.")
                }
                if body.contains("rejected the API key") || body.contains("denied model access") {
                    throw GenerationError.upstream("Image provider access needs attention. Ask the developer to check the server’s API key and model access.")
                }
                throw GenerationError.upstream("The image provider could not return a sheet. Review the description and service usage before trying again.")
            default: throw GenerationError.server(response.statusCode)
            }
        }
        guard contentType == "image/png", data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
              let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else { throw GenerationError.invalidImage }
        return ColoringResult(data: data, image: image, requestedModel: requestedModel,
                              metrics: .decode(response.value(forHTTPHeaderField: "X-Generation-Metrics")),
                              access: Self.decodeAccess(response.value(forHTTPHeaderField: "X-Access-Snapshot")),
                              generationID: response.value(forHTTPHeaderField: "X-Generation-ID").flatMap { UUID(uuidString: $0) })
    }

    static func imageValidationFailure(_ data: Data, response: HTTPURLResponse) -> String? {
        let type = response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces)
        guard type == "image/png" else { return "unexpected_content_type" }
        guard data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) else { return "invalid_png_signature" }
        guard let image = UIImage(data: data) else { return "image_decode_failed" }
        guard image.size.width > 0, image.size.height > 0 else { return "invalid_image_dimensions" }
        return nil
    }

    private static func decodeAccess(_ header: String?) -> AccessSnapshot? {
        guard let header, let data = header.removingPercentEncoding?.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid allowance reset date")
            }
            return date
        }
        return try? decoder.decode(AccessSnapshot.self, from: data)
    }
}

private struct WorkerErrorBody: Decodable {
    struct Detail: Decodable {
        let code: String
        let message: String?
        let reasonCodes: [String]?
        enum CodingKeys: String, CodingKey { case code, message, reasonCodes }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            code = try values.decode(String.self, forKey: .code)
            message = try values.decodeIfPresent(String.self, forKey: .message)
            reasonCodes = try? values.decode([String].self, forKey: .reasonCodes)
        }
    }
    let error: Detail
}

private struct InstallationResponse: Decodable {
    let accountID: String
    let accessToken: String
    let expiresAt: TimeInterval

    enum CodingKeys: String, CodingKey {
        case accountID = "accountId"
        case accessToken, expiresAt
    }
}
