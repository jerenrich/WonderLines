import SwiftUI
import Photos
import UIKit

struct ExportItem: Identifiable {
    enum Kind { case share, print }
    let id = UUID()
    let kind: Kind
    let url: URL
    let image: UIImage
    init(kind: Kind, result: ColoringResult) throws {
        self.kind = kind; image = result.image
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ColoringExports", isDirectory: true).appendingPathComponent(id.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("coloring-sheet.png")
        try result.data.write(to: url, options: [.atomic, .completeFileProtection])
    }
    func cleanUp() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    static func cleanAbandonedExports() {
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("ColoringExports"))
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let item: ExportItem
    let finish: (String?) -> Void
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [item.url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, error in finish(error == nil ? nil : "Sharing could not finish. Please try exporting again.") }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

enum PhotoSaveError: LocalizedError {
    case accessDenied, writeFailed
    var errorDescription: String? {
        switch self {
        case .accessDenied:
            return "Photos access is off. Allow Coloring Sheets to add photos in Settings, then try again."
        case .writeFailed:
            return "The coloring sheet could not be saved to Photos. Please try again."
        }
    }
}

enum PhotoLibrarySaver {
    static func save(_ data: Data, completion: @escaping (Result<Void, PhotoSaveError>) -> Void) {
        let finish: (Result<Void, PhotoSaveError>) -> Void = { result in
            DispatchQueue.main.async { completion(result) }
        }
        authorize { allowed in
            guard allowed else { finish(.failure(.accessDenied)); return }
            PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
            } completionHandler: { success, _ in
                finish(success ? .success(()) : .failure(.writeFailed))
            }
        }
    }

    private static func authorize(completion: @escaping (Bool) -> Void) {
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized, .limited:
            completion(true)
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                completion(status == .authorized || status == .limited)
            }
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }
}

final class ColoringPrintRenderer: UIPrintPageRenderer {
    let image: UIImage
    init(image: UIImage) { self.image = image; super.init() }
    override var numberOfPages: Int { 1 }
    static func fittedRect(imageSize: CGSize, printable: CGRect) -> CGRect {
        let margins = printable.insetBy(dx: 18, dy: 18)
        let scale = min(margins.width / imageSize.width, margins.height / imageSize.height)
        let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        return CGRect(x: margins.midX - size.width / 2, y: margins.midY - size.height / 2, width: size.width, height: size.height)
    }
    override func drawContentForPage(at pageIndex: Int, in contentRect: CGRect) {
        image.draw(in: Self.fittedRect(imageSize: image.size, printable: printableRect))
    }
}

struct PrintSheet: UIViewControllerRepresentable {
    let item: ExportItem
    let finish: (String?) -> Void
    func makeUIViewController(context: Context) -> PrintHost { PrintHost(image: item.image, finish: finish) }
    func updateUIViewController(_ controller: PrintHost, context: Context) {}
    final class PrintHost: UIViewController {
        let image: UIImage
        let finish: (String?) -> Void
        var presented = false
        init(image: UIImage, finish: @escaping (String?) -> Void) { self.image = image; self.finish = finish; super.init(nibName: nil, bundle: nil) }
        required init?(coder: NSCoder) { fatalError("Not used") }
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard !presented else { return }; presented = true
            guard UIPrintInteractionController.isPrintingAvailable else { finish("Printing is unavailable on this device."); return }
            let controller = UIPrintInteractionController.shared
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = "Coloring sheet"; info.outputType = .general
            info.orientation = image.size.width > image.size.height ? .landscape : .portrait
            controller.printInfo = info
            controller.printPageRenderer = ColoringPrintRenderer(image: image)
            let completion: UIPrintInteractionController.CompletionHandler = { _, _, error in
                controller.printPageRenderer = nil
                self.finish(error == nil ? nil : "Printing could not finish. Please try again.")
            }
            let shown: Bool
            if traitCollection.userInterfaceIdiom == .pad {
                shown = controller.present(from: CGRect(x: view.bounds.midX, y: 24, width: 1, height: 1), in: view, animated: true, completionHandler: completion)
            } else {
                shown = controller.present(animated: true, completionHandler: completion)
            }
            if !shown { finish("The print dialog could not open.") }
        }
    }
}
