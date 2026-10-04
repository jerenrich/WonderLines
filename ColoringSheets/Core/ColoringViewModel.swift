import SwiftUI

@MainActor
final class ColoringViewModel: ObservableObject {
    enum Phase: Equatable { case idle, generating, result, error(String) }
    static let batchSize = 3
    @Published var description = ""
    @Published var age: Int { didSet { defaults.set(age, forKey: "childAge") } }
    @Published var model: ImageModel { didSet { defaults.set(model.rawValue, forKey: "generationModel") } }
    @Published private(set) var imageCount: Int { didSet { defaults.set(imageCount, forKey: "imageCount") } }
    @Published var pageFormat: PageFormat = .a4Landscape
    private var previewSize = CGSize(width: 728, height: 512)
    private var displayScale: CGFloat = 2
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var results: [ColoringResult] = []
    @Published var selectedResultID: UUID?
    @Published private(set) var completedCount = 0
    @Published private(set) var failedCount = 0
    @Published private(set) var descriptionRejectedCount = 0
    @Published private(set) var imageRejectedCount = 0
    @Published private(set) var activeBatchSize = 0
    @Published private(set) var batchMessage: String?
    @Published private(set) var unfinishedSheets: [PendingGeneration] = []
    @Published private(set) var access: AccessSnapshot = .free
    let isMock: Bool
    private let service: any GenerationServing
    private let defaults: UserDefaults
    private var tasks: [Task<Void, Never>] = []
    private var attempt = UUID()
    private var receivedFirstResult = false
    private var pendingResults: [ColoringResult] = []
    private var revealTask: Task<Void, Never>?
    private var hasRevealedResults = false
    private var batchStarted = ContinuousClock.now
    private var firstFailure: String?

    init(service: any GenerationServing, isMock: Bool, defaults: UserDefaults = .standard) {
        self.service = service; self.isMock = isMock; self.defaults = defaults
        let stored = defaults.integer(forKey: "childAge")
        age = (3...18).contains(stored) ? stored : 0
        let storedModel = defaults.string(forKey: "generationModel")
        model = ImageModel.selectable.first(where: { $0.rawValue == storedModel }) ?? .sunburst
        let storedCount = defaults.object(forKey: "imageCount") as? Int ?? Self.batchSize
        imageCount = min(max(storedCount, 1), Self.batchSize)
    }

    var isGenerating: Bool { phase == .generating }
    var result: ColoringResult? { results.first(where: { $0.id == selectedResultID }) ?? results.first }
    var selectedIndex: Int { results.firstIndex(where: { $0.id == selectedResultID }) ?? 0 }
    var readyCount: Int { completedCount - failedCount }
    var moderationRejectedCount: Int { descriptionRejectedCount + imageRejectedCount }
    var moderationStatus: String? {
        guard moderationRejectedCount > 0 else { return nil }
        return "\(moderationRejectedCount) \(moderationRejectedCount == 1 ? "sheet" : "sheets") rejected by content moderation"
    }
    private var failureDetails: String {
        var parts: [String] = []
        if let moderationStatus { parts.append(moderationStatus + ".") }
        if descriptionRejectedCount > 0 { parts.append(GenerationError.descriptionRejected.localizedDescription) }
        if imageRejectedCount > 0 { parts.append(GenerationError.imageRejected.localizedDescription) }
        if let firstFailure { parts.append(firstFailure) }
        return parts.joined(separator: " ")
    }
    private var activeSheetLabel: String { "\(activeBatchSize) \(activeBatchSize == 1 ? "sheet" : "sheets")" }
    var progressText: String {
        "Drawing \(activeSheetLabel) · \(readyCount) ready" +
            (moderationStatus.map { " · " + $0 } ?? "") +
            (failedCount > moderationRejectedCount ? " · \(failedCount - moderationRejectedCount) unavailable" : "")
    }

    func setImageCount(_ count: Int) {
        imageCount = min(max(count, 1), Self.batchSize)
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
        return try SheetComposition.allCases.prefix(imageCount).map { composition in
            try GenerationRequest(description: description, age: age, model: model,
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
        activeBatchSize = requests.count
        completedCount = 0; failedCount = 0; batchMessage = nil
        descriptionRejectedCount = 0; imageRejectedCount = 0
        receivedFirstResult = false; firstFailure = nil
        revealTask?.cancel(); revealTask = nil
        pendingResults = []; hasRevealedResults = false
        let current = UUID(); attempt = current
        batchStarted = .now
        DiagnosticLog.shared.record("Batch", "started; requested=\(activeBatchSize); mode=\(isMock ? "mock" : "live")", batchID: current)
        // Each task starts its own request without waiting for the other requests.
        // Validate and capture every composition before starting any paid request.
        // Editing/resizing cannot change the subject, age, or size of this batch.
        tasks = requests.map { request in
            Task { [weak self, service] in
                guard !Task.isCancelled else { return }
                let outcome: Result<ColoringResult, Error>
                do { outcome = .success(try await DiagnosticContext.$batchID.withValue(current) { try await service.generate(request) }) }
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
            if let access = image.access { self.access = access }
            pendingResults.append(image)
            // Start one window at the first success; later arrivals do not reset it.
            if !receivedFirstResult {
                receivedFirstResult = true
                revealTask = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(5)) }
                    catch { return }
                    guard let self, !Task.isCancelled, self.attempt == current, self.isGenerating else { return }
                    self.revealPendingResults()
                    self.revealTask = nil
                }
            }
            if hasRevealedResults {
                revealPendingResults()
            }
        case .failure(let error):
            failedCount += 1
            if (error as? GenerationError) == .descriptionRejected {
                descriptionRejectedCount += 1
            } else if (error as? GenerationError) == .imageRejected {
                imageRejectedCount += 1
            } else if firstFailure == nil {
                firstFailure = (error as? GenerationError)?.localizedDescription ?? GenerationError.uncertain.localizedDescription
            }
        }
        guard completedCount == activeBatchSize else { return }
        logBatchSummary("completed")
        Task { await refreshUnfinishedSheets() }
        tasks = []
        revealTask?.cancel(); revealTask = nil
        revealPendingResults()
        if receivedFirstResult {
            if failedCount > 0 {
                batchMessage = "\(readyCount) of \(activeSheetLabel) are ready. \(failedCount) could not finish. " + failureDetails
            }
            phase = .result
        } else {
            phase = .error(activeBatchSize == 1
                           ? failureDetails
                           : "None of the \(activeSheetLabel) could finish. " + failureDetails)
        }
    }

    private func revealPendingResults() {
        guard let first = pendingResults.first else { return }
        if hasRevealedResults {
            // Append in arrival order without moving the selected page.
            results.append(contentsOf: pendingResults)
            if selectedResultID == nil { selectedResultID = first.id }
        } else {
            // Keep the old gallery until the new batch is ready to browse.
            results = pendingResults
            selectedResultID = first.id
            hasRevealedResults = true
        }
        pendingResults = []
    }

    private func logBatchSummary(_ reason: String) {
        let duration = batchStarted.duration(to: .now).components
        let elapsed = duration.seconds * 1000 + duration.attoseconds / 1_000_000_000_000_000
        DiagnosticLog.shared.record("Batch summary", "\(reason); requested=\(activeBatchSize); succeeded=\(readyCount); failed=\(failedCount); descriptionRejected=\(descriptionRejectedCount); imageRejected=\(imageRejectedCount); unfinished=\(activeBatchSize - completedCount); elapsedMs=\(elapsed)", batchID: attempt)
    }

    func cancel() { cancel(reason: "user stopped waiting") }

    private func cancel(reason: String) {
        guard isGenerating else { return }
        logBatchSummary(reason)
        attempt = UUID()
        tasks.forEach { $0.cancel() }; tasks = []
        Task { await refreshUnfinishedSheets() }
        revealTask?.cancel(); revealTask = nil
        revealPendingResults()
        let message = "Stopped waiting. Any sheets already received are still available. The unfinished generations may still complete and be charged. " + failureDetails
        if receivedFirstResult {
            batchMessage = message; phase = .result
        } else {
            phase = .error(message)
        }
    }
    func enteredBackground() {
        cancel(reason: "app entered background")
        DiagnosticLog.shared.flush()
    }

    func refreshUsage() async {
        guard let selected = result, selected.requestedModel == .redmond, let generationID = selected.generationID else { return }
        do {
            guard let metrics = try await service.generationMetrics(generationID),
                  let index = results.firstIndex(where: { $0.id == selected.id }) else { return }
            results[index].metrics = metrics
        } catch { /* Keep the saved estimate if the read-only billing lookup fails. */ }
    }

    func refreshUnfinishedSheets() async {
        unfinishedSheets = await service.pendingGenerations()
    }

    func recoverUnfinishedSheets() {
        guard !isGenerating, !unfinishedSheets.isEmpty else { return }
        let pending = unfinishedSheets
        phase = .generating
        activeBatchSize = pending.count
        completedCount = 0; failedCount = 0; batchMessage = nil
        descriptionRejectedCount = 0; imageRejectedCount = 0
        receivedFirstResult = false; firstFailure = nil
        revealTask?.cancel(); revealTask = nil
        pendingResults = []; hasRevealedResults = true // Recovery appends to the existing gallery.
        let current = UUID(); attempt = current
        batchStarted = .now
        DiagnosticLog.shared.record("Batch", "recovery started; requested=\(activeBatchSize); mode=\(isMock ? "mock" : "live")", batchID: current)
        tasks = pending.map { entry in
            Task { [weak self, service] in
                let outcome: Result<ColoringResult, Error>
                do { outcome = .success(try await DiagnosticContext.$batchID.withValue(current) { try await service.recoverPending(entry) }) }
                catch { outcome = .failure(error) }
                guard !Task.isCancelled else { return }
                self?.receive(outcome, attempt: current)
            }
        }
    }
}
