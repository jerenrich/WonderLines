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
    static let a4Default = GenerationSize(width: 1024, height: 1456)
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

    init(description: String, age: Int, model: ImageModel, size: GenerationSize = .a4Default) throws {
        guard size.isValid else { throw GenerationError.validation("The page size is unsupported. Choose a smaller page size.") }
        width = size.width; height = size.height
        let original = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !original.isEmpty else { throw GenerationError.validation("Describe what you’d like on the sheet.") }
        subject = original + "\n\n" + (try Self.guidance(age: age))
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

struct ColoringResult {
    let data: Data
    let image: UIImage
    let requestedModel: ImageModel
    let metrics: GenerationMetrics?
}

enum GenerationError: LocalizedError, Equatable {
    case validation(String), configuration, upstream(String), server(Int), invalidImage, uncertain, cancelled
    var errorDescription: String? {
        switch self {
        case .validation(let message), .upstream(let message): return message
        case .configuration: return "The coloring service needs a configuration update. Contact the developer for an updated app."
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
    static let endpoint = URL(string: "https://coloring-sheets-api.jordan-erenrich.workers.dev/generate")!
    private let credential: String
    private let session: URLSession

    init(credential: String, session: URLSession? = nil) {
        self.credential = credential
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 240
        config.timeoutIntervalForResource = 240
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.waitsForConnectivity = false
        self.session = session ?? URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    func generate(_ request: GenerationRequest) async throws -> ColoringResult {
        guard !credential.isEmpty else { throw GenerationError.configuration }
        var http = URLRequest(url: Self.endpoint)
        http.httpMethod = "POST"
        http.setValue("Bearer " + credential, forHTTPHeaderField: "Authorization")
        http.setValue("application/json", forHTTPHeaderField: "Content-Type")
        http.httpBody = try request.encoded()
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: http) }
        catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw GenerationError.cancelled }
            throw GenerationError.uncertain
        }
        guard let response = response as? HTTPURLResponse else { throw GenerationError.uncertain }
        return try Self.parse(data, response: response, requestedModel: request.model)
    }

    static func parse(_ data: Data, response: HTTPURLResponse, requestedModel: ImageModel) throws -> ColoringResult {
        let contentType = response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces)
        guard response.statusCode == 200 else {
            switch response.statusCode {
            case 401, 403, 404, 405, 415, 503: throw GenerationError.configuration
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
                              metrics: .decode(response.value(forHTTPHeaderField: "X-Generation-Metrics")))
    }
}
