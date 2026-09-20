import SwiftUI

@MainActor
final class ColoringViewModel: ObservableObject {
    enum Phase: Equatable { case idle, generating, result, error(String) }
    @Published var description = ""
    @Published var age: Int { didSet { defaults.set(age, forKey: "childAge") } }
    @Published var model: ImageModel = .flare
    @Published var pageFormat: PageFormat = .a4Portrait
    private var previewSize = CGSize(width: 512, height: 728)
    private var displayScale: CGFloat = 2
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var result: ColoringResult?
    let isMock: Bool
    private let service: any GenerationServing
    private let defaults: UserDefaults
    private var task: Task<Void, Never>?
    private var attempt = UUID()

    init(service: any GenerationServing, isMock: Bool, defaults: UserDefaults = .standard) {
        self.service = service; self.isMock = isMock; self.defaults = defaults
        let stored = defaults.integer(forKey: "childAge")
        age = (3...18).contains(stored) ? stored : 0
    }

    var isGenerating: Bool { phase == .generating }
    var validationMessage: String? {
        do { _ = try request(); return nil } catch { return error.localizedDescription }
    }
    private func request() throws -> GenerationRequest {
        try GenerationRequest(description: description, age: age, model: model,
                              size: pageFormat.imageSize(for: previewSize, displayScale: displayScale))
    }

    func updatePreview(size: CGSize, displayScale: CGFloat) {
        // Retain the last visible page while the keyboard temporarily hides the preview.
        guard size.width > 0, size.height > 0 else { return }
        previewSize = size; self.displayScale = displayScale
    }

    func generate() {
        guard !isGenerating else { return }
        let request: GenerationRequest
        do { request = try self.request() } catch { phase = .error(error.localizedDescription); return }
        phase = .generating
        let current = UUID(); attempt = current
        task = Task {
            do {
                let image = try await service.generate(request)
                guard attempt == current, !Task.isCancelled else { return }
                result = image; phase = .result
            } catch {
                guard attempt == current else { return }
                phase = .error((error as? GenerationError)?.localizedDescription ?? GenerationError.uncertain.localizedDescription)
            }
            if attempt == current { task = nil }
        }
    }

    func cancel() {
        guard isGenerating else { return }
        attempt = UUID(); task?.cancel(); task = nil
        phase = .error(GenerationError.cancelled.localizedDescription)
    }
    func enteredBackground() { cancel() }
}
