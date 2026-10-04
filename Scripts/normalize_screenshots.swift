// Bake simulator screenshot EXIF orientation into the pixels, preserving size.
// Usage: swift Scripts/normalize_screenshots.swift input.png output.png [...]
import Foundation
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

let arguments = Array(CommandLine.arguments.dropFirst())
guard !arguments.isEmpty, arguments.count.isMultiple(of: 2) else {
    fatalError("Provide input/output file pairs")
}
for index in stride(from: 0, to: arguments.count, by: 2) {
    let input = URL(fileURLWithPath: arguments[index])
    let output = URL(fileURLWithPath: arguments[index + 1])
    guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
              kCGImageSourceCreateThumbnailFromImageAlways: true,
              kCGImageSourceCreateThumbnailWithTransform: true,
              kCGImageSourceThumbnailMaxPixelSize: max(width, height)
          ] as CFDictionary),
          let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { fatalError("Cannot read or write screenshot: \(input.path)") }
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: 1] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fatalError("Failed to save \(output.path)") }
    print("\(output.lastPathComponent): \(image.width) × \(image.height)")
}
