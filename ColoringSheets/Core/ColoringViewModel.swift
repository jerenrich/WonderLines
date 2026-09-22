import SwiftUI

@MainActor
final class ColoringViewModel: ObservableObject {
    enum Phase: Equatable { case idle, generating, result, error(String) }
    static let generationModel: ImageModel = .sunburst
    static let batchSize = SheetComposition.allCases.count
    @Published var description = ""
    @Published var age: Int { didSet { defaults.set(age, forKey: "childAge") } }
    @Published var pageFormat: PageFormat = .a4Landscape
    private var previewSize = CGSize(width: 728, height: 512)
    private var displayScale: CGFloat = 2
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var results: [ColoringResult] = []
    @Published var selectedResultID: UUID?
    @Published private(set) var completedCount = 0
    @Published private(set) var failedCount = 0
    @Published private(set) var batchMessage: String?
    let isMock: Bool
    private let service: any GenerationServing
    private let defaults: UserDefaults
    private var tasks: [Task<Void, Never>] = []
    private var attempt = UUID()
    private var receivedFirstResult = false
    private var firstFailure: String?

    init(service: any GenerationServing, isMock: Bool, defaults: UserDefaults = .standard) {
        self.service = service; self.isMock = isMock; self.defaults = defaults
        let stored = defaults.integer(forKey: "childAge")
        age = (3...18).contains(stored) ? stored : 0
    }

    var isGenerating: Bool { phase == .generating }
    var result: ColoringResult? { results.first(where: { $0.id == selectedResultID }) ?? results.first }
    var selectedIndex: Int { results.firstIndex(where: { $0.id == selectedResultID }) ?? 0 }
    var readyCount: Int { completedCount - failedCount }
    var progressText: String {
        "Drawing \(Self.batchSize) sheets · \(readyCount) ready" + (failedCount > 0 ? " · \(failedCount) unavailable" : "")
    }

    func selectResult(at index: Int) {
        guard results.indices.contains(index) else { return }
        selectedResultID = results[index].id
    }
    var validationMessage: String? {
        do { _ = try requests(); return nil } catch { return error.localizedDescription }
    }
    private func requests() throws -> [GenerationRequest] {
        let size = pageFormat.imageSize(for: previewSize, displayScale: displayScale)
        return try SheetComposition.allCases.map { composition in
            try GenerationRequest(description: description, age: age, model: Self.generationModel,
                                  size: size, composition: composition)
        }
    }

    func updatePreview(size: CGSize, displayScale: CGFloat) {
        // Ignore transient zero-sized layouts while the window is resizing.
        guard size.width > 0, size.height > 0 else { return }
        previewSize = size; self.displayScale = displayScale
    }

    func generate() {
        guard !isGenerating else { return }
        let requests: [GenerationRequest]
        do { requests = try self.requests() } catch { phase = .error(error.localizedDescription); return }
        phase = .generating
        completedCount = 0; failedCount = 0; batchMessage = nil
        receivedFirstResult = false; firstFailure = nil
        let current = UUID(); attempt = current
        // Each task starts its own request without waiting for the other requests.
        // Validate and capture every composition before starting any paid request.
        // Editing/resizing cannot change the subject, age, or size of this batch.
        tasks = requests.map { request in
            Task { [weak self, service] in
                guard !Task.isCancelled else { return }
                let outcome: Result<ColoringResult, Error>
                do { outcome = .success(try await service.generate(request)) }
                catch { outcome = .failure(error) }
                guard !Task.isCancelled else { return }
                self?.receive(outcome, attempt: current)
            }
        }
    }

    private func receive(_ outcome: Result<ColoringResult, Error>, attempt current: UUID) {
        guard attempt == current, isGenerating else { return }
        completedCount += 1
        switch outcome {
        case .success(let image):
            // Keep the previous gallery until a replacement actually arrives.
            // Append in arrival order; later results never move the selected page.
            if !receivedFirstResult {
                receivedFirstResult = true
                results = [image]; selectedResultID = image.id
            } else {
                results.append(image)
            }
        case .failure(let error):
            failedCount += 1
            if firstFailure == nil {
                firstFailure = (error as? GenerationError)?.localizedDescription ?? GenerationError.uncertain.localizedDescription
            }
        }
        guard completedCount == Self.batchSize else { return }
        tasks = []
        if receivedFirstResult {
            if failedCount > 0 {
                batchMessage = "\(readyCount) of \(Self.batchSize) sheets are ready. \(failedCount) could not finish. " + (firstFailure ?? "")
            }
            phase = .result
        } else {
            phase = .error("None of the \(Self.batchSize) sheets could finish. " + (firstFailure ?? ""))
        }
    }

    func cancel() {
        guard isGenerating else { return }
        attempt = UUID()
        tasks.forEach { $0.cancel() }; tasks = []
        let message = "Stopped waiting. Any sheets already received are still available. The unfinished generations may still complete and be charged."
        if receivedFirstResult {
            batchMessage = message; phase = .result
        } else {
            phase = .error(message)
        }
    }
    func enteredBackground() { cancel() }
}
