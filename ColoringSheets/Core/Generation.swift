import Foundation
import UIKit

enum ImageModel: String, CaseIterable, Codable, Identifiable {
    case flare = "gpt-image-2.5-flare"
    case sunburst = "gpt-image-2.5-sunburst"
    var id: String { rawValue }
    var label: String { self == .flare ? "Flare" : "Sunburst" }
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

enum SheetComposition: CaseIterable {
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
         composition: SheetComposition? = nil) throws {
        guard size.isValid else { throw GenerationError.validation("The page size is unsupported. Choose a smaller page size.") }
        width = size.width; height = size.height
        let original = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !original.isEmpty else { throw GenerationError.validation("Describe what you’d like on the sheet.") }
        subject = original + "\n\n" + (try Self.guidance(age: age)) +
            (composition.map { "\n\n" + $0.guidance } ?? "")
        self.model = model
        guard subject.utf16.count <= 500 else {
            throw GenerationError.validation("Please shorten the description. It must fit within 500 characters including the complexity guidance.")
        }
        _ = try encoded()
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
    let metrics: GenerationMetrics?
    let access: AccessSnapshot?
    let generationID: UUID?

    init(data: Data, image: UIImage, requestedModel: ImageModel, metrics: GenerationMetrics?,
         access: AccessSnapshot? = nil, generationID: UUID? = nil) {
        self.data = data; self.image = image; self.requestedModel = requestedModel
        self.metrics = metrics; self.access = access; self.generationID = generationID
    }
}

enum GenerationError: LocalizedError, Equatable {
    case validation(String), configuration, allowance, upstream(String), server(Int), invalidImage, uncertain, cancelled
    var errorDescription: String? {
        switch self {
        case .validation(let message), .upstream(let message): return message
        case .configuration: return "The coloring service needs a configuration update. Contact the developer for an updated app."
        case .allowance: return "Today’s free sheet allowance has been used. Please try again after it resets."
        case .server(let status): return "The service could not complete the request (HTTP \(status)). Contact the developer if this continues."
        case .invalidImage: return "The service did not return a valid PNG. Generation may have been charged. Check usage before trying again."
        case .uncertain: return "The connection was interrupted or timed out. Generation may still finish and be charged. Check usage before choosing to generate again."
        case .cancelled: return "Stopped waiting. The server may still generate and charge for this sheet. Check usage before choosing to generate again."
        }
    }
}

protocol GenerationServing {
    func generate(_ request: GenerationRequest) async throws -> ColoringResult
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
    private let serviceURL: URL
    private let endpoint: URL
    // This exists solely for isolated legacy-parser/network tests. The app does not
    // bundle or use shared credentials.
    private let legacyCredential: String?
    private let identities: AnonymousIdentityStore?
    private let session: URLSession

    init(serviceURL: URL = defaultServiceURL, session: URLSession? = nil, identities: AnonymousIdentityStore = AnonymousIdentityStore()) {
        self.serviceURL = serviceURL
        self.endpoint = serviceURL.appending(path: "/v1/generations")
        self.legacyCredential = nil
        self.identities = identities
        self.session = Self.makeSession(session)
    }

    init(credential: String, session: URLSession? = nil) {
        self.serviceURL = Self.defaultServiceURL
        self.endpoint = Self.endpoint
        self.legacyCredential = credential
        self.identities = nil
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
        let authorization = try await authorization()
        let generationID = UUID()
        http.setValue("Bearer " + authorization, forHTTPHeaderField: "Authorization")
        http.setValue("application/json", forHTTPHeaderField: "Content-Type")
        http.setValue(generationID.uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        http.setValue("1", forHTTPHeaderField: "X-Coloring-API-Version")
        http.httpBody = try request.encoded()
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: http) }
        catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw GenerationError.cancelled }
            if legacyCredential != nil { throw GenerationError.uncertain }
            return try await recover(generationID, authorization: authorization, requestedModel: request.model)
        }
        guard let response = response as? HTTPURLResponse else { throw GenerationError.uncertain }
        if response.statusCode == 202 {
            return try await recover(generationID, authorization: authorization, requestedModel: request.model)
        }
        return try Self.parse(data, response: response, requestedModel: request.model)
    }

    private func recover(_ generationID: UUID, authorization: String, requestedModel: ImageModel) async throws -> ColoringResult {
        // Polling a recorded job never repeats the paid provider request. Three short
        // checks cover an interrupted foreground response without trapping the UI.
        for attempt in 0..<3 {
            if attempt > 0 {
                do { try await Task.sleep(for: .seconds(5)) }
                catch { throw GenerationError.cancelled }
            }
            var request = URLRequest(url: endpoint.appending(path: generationID.uuidString.lowercased()))
            request.setValue("Bearer " + authorization, forHTTPHeaderField: "Authorization")
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { continue }
                if http.statusCode == 202 { continue }
                return try Self.parse(data, response: http, requestedModel: requestedModel)
            } catch is CancellationError { throw GenerationError.cancelled }
            catch { continue }
        }
        throw GenerationError.uncertain
    }

    private func authorization() async throws -> String {
        if let legacyCredential, !legacyCredential.isEmpty { return legacyCredential }
        guard let identities else { throw GenerationError.configuration }
        let saved = try await identities.session { [serviceURL, session] in
            var request = URLRequest(url: serviceURL.appending(path: "/v1/installations"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
            let data: Data; let response: URLResponse
            do { (data, response) = try await session.data(for: request) }
            catch { throw GenerationError.uncertain }
            guard let http = response as? HTTPURLResponse, http.statusCode == 201,
                  let created = try? JSONDecoder().decode(InstallationResponse.self, from: data),
                  let accountID = UUID(uuidString: created.accountID), !created.accessToken.isEmpty else {
                throw GenerationError.configuration
            }
            return AnonymousSession(accountID: accountID, accessToken: created.accessToken,
                                    expiresAt: Date(timeIntervalSince1970: created.expiresAt))
        }
        return saved.accessToken
    }

    static func parse(_ data: Data, response: HTTPURLResponse, requestedModel: ImageModel) throws -> ColoringResult {
        let contentType = response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces)
        guard response.statusCode == 200 else {
            switch response.statusCode {
            case 401, 403, 404, 405, 415, 503: throw GenerationError.configuration
            case 429: throw GenerationError.allowance
            case 400, 413: throw GenerationError.validation("The service rejected the description or page size. Revise the description or check the app and Worker versions.")
            case 504: throw GenerationError.uncertain
            case 502:
                // Only display the known sanitized Worker messages, never arbitrary response text.
                let body = contentType == "text/plain" ? String(data: data.prefix(512), encoding: .utf8) ?? "" : ""
                if body.contains("insufficient credit or quota") || body.contains("rate or quota limit") {
                    throw GenerationError.upstream("OpenAI reports a credit or quota limit. Ask the developer to check API billing and limits before trying again.")
                }
                if body.contains("rejected the API key") || body.contains("denied model access") {
                    throw GenerationError.upstream("OpenAI access needs attention. Ask the developer to check the server’s API key and model access.")
                }
                throw GenerationError.upstream("OpenAI could not return a sheet. Review the description and service usage before trying again.")
            default: throw GenerationError.server(response.statusCode)
            }
        }
        guard contentType == "image/png", data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
              let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else {
            throw GenerationError.invalidImage
        }
        return ColoringResult(data: data, image: image, requestedModel: requestedModel,
                              metrics: .decode(response.value(forHTTPHeaderField: "X-Generation-Metrics")),
                              access: Self.decodeAccess(response.value(forHTTPHeaderField: "X-Access-Snapshot")),
                              generationID: response.value(forHTTPHeaderField: "X-Generation-ID").flatMap { UUID(uuidString: $0) })
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

private struct InstallationResponse: Decodable {
    let accountID: String
    let accessToken: String
    let expiresAt: TimeInterval

    enum CodingKeys: String, CodingKey {
        case accountID = "accountId"
        case accessToken, expiresAt
    }
}
