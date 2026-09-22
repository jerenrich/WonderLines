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
            let landscape = size.width > size.height
            let canvas = landscape ? CGSize(width: 1536, height: 1024) : CGSize(width: 1024, height: 1536)
            let scale = min(CGFloat(size.width) / canvas.width, CGFloat(size.height) / canvas.height)
            context.cgContext.translateBy(x: (CGFloat(size.width) - canvas.width * scale) / 2,
                                          y: (CGFloat(size.height) - canvas.height * scale) / 2)
            context.cgContext.scaleBy(x: scale, y: scale)
            UIColor.black.setStroke()
            func ellipse(_ rect: CGRect) {
                let path = UIBezierPath(ovalIn: rect); path.lineWidth = 7; path.stroke()
            }
            // Deliberately hand-drawn deterministic fixture, not an AI generation.
            let sun = landscape ? CGPoint(x: 1280, y: 180) : CGPoint(x: 780, y: 210)
            let flower = landscape ? CGPoint(x: 768, y: 430) : CGPoint(x: 512, y: 620)
            ellipse(CGRect(x: sun.x - 70, y: sun.y - 70, width: 140, height: 140))
            for index in 0..<8 {
                let angle = CGFloat(index) * .pi / 4
                let ray = UIBezierPath()
                ray.move(to: CGPoint(x: sun.x + cos(angle) * 90, y: sun.y + sin(angle) * 90))
                ray.addLine(to: CGPoint(x: sun.x + cos(angle) * 120, y: sun.y + sin(angle) * 120))
                ray.lineWidth = 7; ray.stroke()
            }
            let hill = UIBezierPath()
            let ground: CGFloat = landscape ? 920 : 1280
            hill.move(to: CGPoint(x: 100, y: ground))
            hill.addCurve(to: CGPoint(x: canvas.width - 100, y: ground),
                          controlPoint1: CGPoint(x: canvas.width * 0.3, y: ground - 150),
                          controlPoint2: CGPoint(x: canvas.width * 0.7, y: ground - 150))
            hill.lineWidth = 7; hill.stroke()
            let stem = UIBezierPath(roundedRect: CGRect(x: flower.x - 19, y: flower.y + 110, width: 38, height: landscape ? 290 : 420), cornerRadius: 18)
            stem.lineWidth = 7; stem.stroke()
            ellipse(CGRect(x: flower.x - 192, y: flower.y + 220, width: 172, height: 90))
            ellipse(CGRect(x: flower.x + 20, y: flower.y + 310, width: 172, height: 90))
            for index in 0..<8 {
                let angle = CGFloat(index) * .pi / 4
                ellipse(CGRect(x: flower.x - 70 + cos(angle) * 160, y: flower.y - 70 + sin(angle) * 160, width: 140, height: 140))
            }
            UIColor.white.setFill()
            let center = UIBezierPath(ovalIn: CGRect(x: flower.x - 105, y: flower.y - 105, width: 210, height: 210))
            center.fill(); center.lineWidth = 7; center.stroke()
        }
    }
}
