import SwiftUI

// Keep the current gallery and opaque recovery context together in one atomic file.
// Prompts and credentials are never part of this snapshot.
struct GallerySnapshot: Codable {
    struct Sheet: Codable {
        let id: UUID
        let data: Data
        let model: ImageModel
        let metrics: GenerationMetrics?
        let access: AccessSnapshot?
        let generationID: UUID?

        init(_ result: ColoringResult) {
            id = result.id; data = result.data; model = result.requestedModel
            metrics = result.metrics; access = result.access; generationID = result.generationID
        }
        var result: ColoringResult? {
            guard let image = UIImage(data: data) else { return nil }
            return ColoringResult(data: data, image: image, requestedModel: model, metrics: metrics,
                                  access: access, generationID: generationID, id: id)
        }
    }
    let sheets: [Sheet]
    let waitingToReveal: [Sheet]
    let selectedID: UUID?
    let hasRevealedResults: Bool
    let generationBatchID: UUID?
    let recoveringIDs: Set<UUID>?
    let shouldResume: Bool
}

final class GalleryStore {
    let url: URL
    init(url: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("WonderLines/gallery.json")) { self.url = url }
    func load() -> GallerySnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(GallerySnapshot.self, from: data)
    }
    func remove() throws {
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    func save(_ snapshot: GallerySnapshot) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(snapshot).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

@MainActor
final class ColoringViewModel: ObservableObject {
    enum Phase: Equatable { case idle, generating, result, error(String) }
    static let batchSize = 3
    // Drawing complexity is a preference, not a prerequisite for first use.
    static let defaultAge = 6
    @Published var description: String {
        didSet { defaults.set(description, forKey: "descriptionDraft") }
    }
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
    @Published private(set) var activeBatchSize = 0
    @Published private(set) var isRecovering = false
    @Published private(set) var batchMessage: String?
    @Published private(set) var unfinishedSheets: [PendingGeneration] = []
    @Published private(set) var access: AccessSnapshot = .free
    @Published var showsConsent = false
    @Published private(set) var hasConsent: Bool
    @Published private(set) var isDeletingAccount = false
    @Published private(set) var deletionPending: Bool
    @Published private(set) var isReporting = false
    @Published var privacyMessage: String?
    private let requiresConsent: Bool
    private var consentForRecovery = false
    var consentActionTitle: String { consentForRecovery ? "Agree and Continue" : "Agree and Generate" }
    var canUseService: Bool { (!requiresConsent || hasConsent) && !deletionPending }
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
    private var resumesAfterBackground = false
    private var isInBackground = false
    private var revealsImmediately = false
    private var generationBatchID: UUID?
    private var recoveringIDs: Set<UUID>?
    private let galleryStore: GalleryStore?
    private var acknowledgedResultIDs: Set<UUID> = []
    private var localSaveFailed = false
    private static let saveFailureMessage = "The sheets could not be saved on this device. Keep the app open; received jobs remain available for recovery."

    init(service: any GenerationServing, isMock: Bool, defaults: UserDefaults = .standard,
         galleryStore: GalleryStore? = nil, requiresConsent: Bool? = nil) {
        self.service = service; self.isMock = isMock; self.defaults = defaults
        self.requiresConsent = requiresConsent ?? !isMock
        hasConsent = defaults.integer(forKey: PrivacyConsent.key) == PrivacyConsent.currentVersion
        deletionPending = defaults.bool(forKey: PrivacyConsent.deletionKey)
        description = defaults.string(forKey: "descriptionDraft") ?? ""
        self.galleryStore = galleryStore ?? (!isMock && defaults === UserDefaults.standard ? GalleryStore() : nil)
        let stored = defaults.integer(forKey: "childAge")
        age = (3...18).contains(stored) ? stored : Self.defaultAge
        let storedModel = defaults.string(forKey: "generationModel")
        model = ImageModel.selectable.first(where: { $0.rawValue == storedModel }) ?? .sunburst
        let storedCount = defaults.object(forKey: "imageCount") == nil ? Self.batchSize : defaults.integer(forKey: "imageCount")
        imageCount = min(max(storedCount, 1), Self.batchSize)
        if let saved = self.galleryStore?.load() {
            results = saved.sheets.compactMap(\.result)
            selectedResultID = results.first(where: { $0.id == saved.selectedID })?.id ?? results.first?.id
            pendingResults = saved.waitingToReveal.compactMap(\.result)
            hasRevealedResults = saved.hasRevealedResults
            generationBatchID = saved.generationBatchID
            recoveringIDs = saved.recoveringIDs
            resumesAfterBackground = saved.shouldResume
            revealsImmediately = saved.shouldResume
            acknowledgeSavedResults()
            revealPendingResults()
            phase = results.isEmpty ? .idle : .result
        }
    }

    @discardableResult
    private func persistState() -> Bool {
        do {
            try galleryStore?.save(GallerySnapshot(sheets: results.map(GallerySnapshot.Sheet.init),
                waitingToReveal: pendingResults.map(GallerySnapshot.Sheet.init), selectedID: selectedResultID,
                hasRevealedResults: hasRevealedResults, generationBatchID: generationBatchID,
                recoveringIDs: recoveringIDs, shouldResume: isGenerating || resumesAfterBackground))
            acknowledgeSavedResults()
            if localSaveFailed {
                localSaveFailed = false
                if batchMessage == Self.saveFailureMessage { batchMessage = nil }
            }
            return true
        } catch {
            localSaveFailed = true
            batchMessage = Self.saveFailureMessage
            DiagnosticLog.shared.record("Gallery", "local save failed; recovery IDs retained", error: error)
            return false
        }
    }

    private func acknowledgeSavedResults() {
        let savedIDs = Set((results + pendingResults).compactMap(\.generationID))
        let newIDs = savedIDs.subtracting(acknowledgedResultIDs)
        guard !newIDs.isEmpty else { return }
        acknowledgedResultIDs.formUnion(newIDs)
        // A later successful save may include sheets whose earlier save failed.
        // Relaunch also closes a termination between saving and acknowledgement.
        Task { [service] in
            for id in newIDs { await service.acknowledgeResult(id) }
        }
    }

    var isGenerating: Bool { phase == .generating }
    var result: ColoringResult? { results.first(where: { $0.id == selectedResultID }) ?? results.first }
    var selectedIndex: Int { results.firstIndex(where: { $0.id == selectedResultID }) ?? 0 }
    var readyCount: Int { completedCount - failedCount }
    private var activeSheetLabel: String { "\(activeBatchSize) \(activeBatchSize == 1 ? "sheet" : "sheets")" }
    var progressText: String {
        (isRecovering ? "Checking \(activeSheetLabel)" : "Drawing \(activeSheetLabel)") + " · \(readyCount) ready" + (failedCount > 0 ? " · \(failedCount) unavailable" : "")
    }

    func acceptConsent() {
        defaults.set(PrivacyConsent.currentVersion, forKey: PrivacyConsent.key)
        hasConsent = true; showsConsent = false
        if consentForRecovery { recoverUnfinishedSheets() } else { generate() }
    }

    func withdrawConsent() {
        cancel()
        resumesAfterBackground = false
        defaults.removeObject(forKey: PrivacyConsent.key)
        hasConsent = false; showsConsent = false
        persistState()
    }

    func deleteAccountAndData() async {
        guard !isDeletingAccount, !isReporting else { return }
        isDeletingAccount = true
        deletionPending = true
        defaults.set(true, forKey: PrivacyConsent.deletionKey)
        defer { isDeletingAccount = false }
        // Drain any registration/submission already started before removing its
        // credential. Cancellation alone does not finish an async registration.
        let running = tasks
        cancel()
        for task in running { await task.value }
        do {
            try await service.deleteAccount()
            try galleryStore?.remove()
            results = []; pendingResults = []; unfinishedSheets = []
            selectedResultID = nil; acknowledgedResultIDs = []
            resumesAfterBackground = false; recoveringIDs = nil; generationBatchID = nil
            hasRevealedResults = false; localSaveFailed = false; batchMessage = nil
            completedCount = 0; failedCount = 0; activeBatchSize = 0; isRecovering = false
            access = .free; firstFailure = nil; receivedFirstResult = false
            description = ""; age = Self.defaultAge; model = .sunburst; imageCount = Self.batchSize
            for key in ["descriptionDraft", "childAge", "generationModel", "imageCount", PrivacyConsent.key, PrivacyConsent.deletionKey] {
                defaults.removeObject(forKey: key)
            }
            DiagnosticLog.shared.clear()
            hasConsent = false; deletionPending = false; showsConsent = false
            phase = .idle
            privacyMessage = "Your service account, saved sheets and app history have been deleted. Copies you exported remain where you saved or shared them. Provider logs follow the retention described in the privacy policy."
        } catch {
            privacyMessage = "Deletion could not be confirmed. Your saved account is kept so you can retry. Generation stays paused until deletion finishes. Please check your connection and tap Delete account and data again."
        }
    }

    func reportSelectedSheet(reason: SheetReportReason) async {
        guard !isReporting, !deletionPending, let selected = result else { return }
        guard let generationID = selected.generationID else {
            privacyMessage = "This sheet has no service reference. Please contact support using the link in Settings."
            return
        }
        isReporting = true
        defer { isReporting = false }
        do {
            try await service.reportSheet(generationID, reason: reason.rawValue)
            results.removeAll { $0.id == selected.id }
            selectedResultID = results.first?.id
            phase = results.isEmpty ? .idle : .result
            persistState()
            privacyMessage = "Report received. This sheet has been removed from your gallery and recovery. Support will review it."
        } catch {
            privacyMessage = "Your report could not be sent. Please try again, or contact support in Settings."
        }
    }

    func setImageCount(_ count: Int) {
        imageCount = min(max(count, 1), Self.batchSize)
    }

    func selectResult(at index: Int) {
        guard results.indices.contains(index) else { return }
        selectedResultID = results[index].id
        persistState()
    }
    func selectResult(id: UUID?) {
        guard let index = results.firstIndex(where: { $0.id == id }) else { return }
        selectResult(at: index)
    }
    var validationMessage: String? {
        do { _ = try requests(); return nil } catch { return error.localizedDescription }
    }
    private func requests(batchID: UUID? = nil) throws -> [GenerationRequest] {
        let size = pageFormat.imageSize(for: previewSize, displayScale: displayScale)
        return try SheetComposition.allCases.prefix(imageCount).map { composition in
            try GenerationRequest(description: description, age: age, model: model,
                                  size: size, composition: composition, batchID: batchID)
        }
    }

    func updatePreview(size: CGSize, displayScale: CGFloat) {
        // Ignore transient zero-sized layouts while the window is resizing.
        guard size.width > 0, size.height > 0 else { return }
        previewSize = size; self.displayScale = displayScale
    }

    func generate() {
        guard !isGenerating, !deletionPending, !isReporting else { return }
        guard canUseService else { consentForRecovery = false; showsConsent = true; return }
        let current = UUID()
        let requests: [GenerationRequest]
        do { requests = try self.requests(batchID: current) } catch { phase = .error(error.localizedDescription); return }
        phase = .generating
        isRecovering = false
        activeBatchSize = requests.count
        completedCount = 0; failedCount = 0; batchMessage = nil
        receivedFirstResult = false; firstFailure = nil
        revealTask?.cancel(); revealTask = nil
        pendingResults = []; hasRevealedResults = false
        attempt = current
        generationBatchID = current
        recoveringIDs = nil
        resumesAfterBackground = false
        revealsImmediately = false
        batchStarted = .now
        persistState()
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
        defer { persistState() }
        completedCount += 1
        switch outcome {
        case .success(let image):
            if let access = image.access { self.access = access }
            pendingResults.append(image)
            // Start one window at the first success; later arrivals do not reset it.
            if !receivedFirstResult {
                receivedFirstResult = true
                if !revealsImmediately {
                    revealTask = Task { [weak self] in
                        do { try await Task.sleep(for: .seconds(5)) }
                        catch { return }
                        guard let self, !Task.isCancelled, self.attempt == current, self.isGenerating else { return }
                        self.revealPendingResults()
                        self.revealTask = nil
                    }
                }
            }
            if hasRevealedResults || revealsImmediately {
                revealPendingResults(save: false)
            }
        case .failure(let error):
            failedCount += 1
            if firstFailure == nil {
                firstFailure = (error as? GenerationError)?.localizedDescription ?? GenerationError.uncertain.localizedDescription
            }
        }
        guard completedCount == activeBatchSize else { return }
        logBatchSummary("completed")
        Task {
            await refreshUnfinishedSheets()
            if resumesAfterBackground && !isInBackground { await enteredForeground() }
        }
        tasks = []
        revealTask?.cancel(); revealTask = nil
        revealPendingResults(save: false)
        if receivedFirstResult {
            if failedCount > 0 {
                batchMessage = "\(readyCount) of \(activeSheetLabel) are ready. \(failedCount) could not finish. " + (firstFailure ?? "")
            }
            phase = .result
        } else {
            phase = .error(activeBatchSize == 1
                           ? "The sheet could not finish. " + (firstFailure ?? "")
                           : "None of the \(activeSheetLabel) could finish. " + (firstFailure ?? ""))
        }
    }

    private func revealPendingResults(save: Bool = true) {
        var seen = Set(hasRevealedResults ? results.compactMap(\.generationID) : [])
        pendingResults = pendingResults.filter { image in
            guard let id = image.generationID else { return true }
            return seen.insert(id).inserted
        }
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
        if save { persistState() }
    }

    private func logBatchSummary(_ reason: String) {
        let duration = batchStarted.duration(to: .now).components
        let elapsed = duration.seconds * 1000 + duration.attoseconds / 1_000_000_000_000_000
        DiagnosticLog.shared.record("Batch summary", "\(reason); requested=\(activeBatchSize); succeeded=\(readyCount); failed=\(failedCount); unfinished=\(activeBatchSize - completedCount); elapsedMs=\(elapsed)", batchID: attempt)
    }

    func cancel() {
        resumesAfterBackground = false
        cancel(reason: "user stopped waiting")
    }

    private func cancel(reason: String) {
        guard isGenerating else { return }
        logBatchSummary(reason)
        attempt = UUID()
        tasks.forEach { $0.cancel() }; tasks = []
        Task { await refreshUnfinishedSheets() }
        revealTask?.cancel(); revealTask = nil
        revealPendingResults()
        let message = "Stopped waiting. Any sheets already received are still available. The unfinished generations may still complete and be charged."
        if receivedFirstResult {
            batchMessage = message; phase = .result
        } else {
            phase = .error(message)
        }
        persistState()
    }
    func enteredBackground() {
        isInBackground = true
        if isGenerating {
            resumesAfterBackground = true
            revealsImmediately = true
            logBatchSummary("app entered background; requests retained")
            revealTask?.cancel(); revealTask = nil
            revealPendingResults()
            persistState()
        } else if localSaveFailed {
            // A completed batch has no more arrivals to retry a failed save.
            persistState()
        }
        DiagnosticLog.shared.flush()
    }

    func enteredForeground() async {
        guard canUseService else { await refreshUnfinishedSheets(); return }
        let returningFromBackground = isInBackground
        isInBackground = false
        if localSaveFailed { persistState() }
        let interruptedAttempt = attempt
        if returningFromBackground && isGenerating {
            isRecovering = true
            revealsImmediately = true
            revealTask?.cancel(); revealTask = nil
            revealPendingResults()
            DiagnosticLog.shared.record("App foreground", "resuming existing checks; requested=\(activeBatchSize); ready=\(readyCount)", batchID: interruptedAttempt)
            DiagnosticLog.shared.flush()
            await service.resumePolling()
        }
        await refreshUnfinishedSheets()
        guard attempt == interruptedAttempt, resumesAfterBackground else { return }
        if isGenerating {
            // Keep the original upload/poll tasks and counters. Starting a new
            // recovery here would cancel submissions which are still in flight.
            persistState()
            return
        }
        resumesAfterBackground = false
        let pending = unfinishedSheets.filter { entry in
            if let recoveringIDs { return recoveringIDs.contains(entry.id) }
            return generationBatchID != nil && entry.batchID == generationBatchID
        }
        // Before the first new sheet arrives, the gallery still belongs to the
        // previous batch. Preserve replacement versus append across every unlock.
        recover(pending, appending: hasRevealedResults)
        persistState()
    }

    func refreshUsage() async {
        guard canUseService, let selected = result, selected.requestedModel == .redmond, let generationID = selected.generationID else { return }
        do {
            guard let metrics = try await service.generationMetrics(generationID),
                  let index = results.firstIndex(where: { $0.id == selected.id }) else { return }
            results[index].metrics = metrics
            persistState()
        } catch { /* Keep the saved estimate if the read-only billing lookup fails. */ }
    }

    func refreshUnfinishedSheets() async {
        let currentAttempt = attempt
        let entries = await service.pendingGenerations()
        guard !deletionPending, currentAttempt == attempt else { return }
        let displayed = Set(results.compactMap(\.generationID))
        unfinishedSheets = entries.filter { !displayed.contains($0.id) }
    }

    func recoverUnfinishedSheets() {
        guard !deletionPending else { return }
        guard canUseService else { consentForRecovery = true; showsConsent = true; return }
        resumesAfterBackground = false
        recover(unfinishedSheets, appending: true)
    }

    private func recover(_ entries: [PendingGeneration], appending: Bool) {
        guard !isGenerating, canUseService else { return }
        let displayed = Set(appending ? results.compactMap(\.generationID) : [])
        var seen = displayed
        let pending = entries.filter { seen.insert($0.id).inserted }
        guard !pending.isEmpty else { return }
        recoveringIDs = Set(pending.map(\.id))
        phase = .generating
        isRecovering = true
        revealsImmediately = true
        activeBatchSize = pending.count
        completedCount = 0; failedCount = 0; batchMessage = nil
        receivedFirstResult = false; firstFailure = nil
        revealTask?.cancel(); revealTask = nil
        pendingResults = []; hasRevealedResults = appending
        let current = UUID(); attempt = current
        batchStarted = .now
        persistState()
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
