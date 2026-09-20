import UIKit

struct MockGenerator: GenerationServing {
    func generate(_ request: GenerationRequest) async throws -> ColoringResult {
        try await Task.sleep(for: .seconds(1))
        try Task.checkCancellation()
        let image = Self.sampleImage(size: GenerationSize(width: request.width, height: request.height))
        let metrics = GenerationMetrics.decode("{\"requestedModel\":\"\(request.model.rawValue)\",\"inputTokens\":100,\"imageInputTokens\":0,\"outputTokens\":200,\"totalTokens\":300,\"estimatedTotalUsd\":0.0065,\"elapsedMs\":12000,\"estimateBasis\":\"Illustrative mock metrics only. No paid request was sent.\"}")
        return ColoringResult(data: image.pngData()!, image: image, requestedModel: request.model, metrics: metrics)
    }

    static func sampleImage(size: GenerationSize = .a4Default) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size.cgSize, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size.cgSize))
            let scale = min(CGFloat(size.width) / 1024, CGFloat(size.height) / 1536)
            context.cgContext.translateBy(x: (CGFloat(size.width) - 1024 * scale) / 2,
                                          y: (CGFloat(size.height) - 1536 * scale) / 2)
            context.cgContext.scaleBy(x: scale, y: scale)
            UIColor.black.setStroke()
            func ellipse(_ rect: CGRect) {
                let path = UIBezierPath(ovalIn: rect); path.lineWidth = 7; path.stroke()
            }
            // Deliberately hand-drawn deterministic fixture, not an AI generation.
            ellipse(CGRect(x: 710, y: 140, width: 140, height: 140))
            for index in 0..<8 {
                let angle = CGFloat(index) * .pi / 4
                let ray = UIBezierPath()
                ray.move(to: CGPoint(x: 780 + cos(angle) * 90, y: 210 + sin(angle) * 90))
                ray.addLine(to: CGPoint(x: 780 + cos(angle) * 120, y: 210 + sin(angle) * 120))
                ray.lineWidth = 7; ray.stroke()
            }
            let hill = UIBezierPath()
            hill.move(to: CGPoint(x: 100, y: 1280))
            hill.addCurve(to: CGPoint(x: 924, y: 1280), controlPoint1: CGPoint(x: 300, y: 1080), controlPoint2: CGPoint(x: 760, y: 1080))
            hill.lineWidth = 7; hill.stroke()
            let stem = UIBezierPath(roundedRect: CGRect(x: 493, y: 730, width: 38, height: 420), cornerRadius: 18)
            stem.lineWidth = 7; stem.stroke()
            ellipse(CGRect(x: 320, y: 880, width: 172, height: 90))
            ellipse(CGRect(x: 532, y: 1000, width: 172, height: 90))
            for index in 0..<8 {
                let angle = CGFloat(index) * .pi / 4
                ellipse(CGRect(x: 442 + cos(angle) * 160, y: 550 + sin(angle) * 160, width: 140, height: 140))
            }
            UIColor.white.setFill()
            let center = UIBezierPath(ovalIn: CGRect(x: 407, y: 515, width: 210, height: 210))
            center.fill(); center.lineWidth = 7; center.stroke()
        }
    }
}
