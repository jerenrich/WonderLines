import SwiftUI

struct ContentView: View {
    @ObservedObject var store: ColoringViewModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var descriptionFocused: Bool
    @State private var composerMinimized = false
    @State private var export: ExportItem?
    @State private var retainedExport: ExportItem?
    @State private var exportError: String?
    @State private var photoSaveConfirmation: String?
    @State private var isSavingPhoto = false
    @State private var showUsage = false
    @State private var showAbout = false
    @State private var detailMessage: String?
    private let ink = Color(red: 0.12, green: 0.25, blue: 0.29)

    var body: some View {
        GeometryReader { geometry in
            let narrow = geometry.size.width < 600 || typeSize.isAccessibilitySize
            let inset: CGFloat = narrow ? 12 : 24
            VStack(spacing: 12) {
                header(narrow: narrow)
                preview
            }
            .padding(.horizontal, inset)
            .padding(.top, 8)
            // SwiftUI lifts this inset with the system keyboard. The preview and
            // editor keep their identity throughout focus and size changes.
            .safeAreaInset(edge: .bottom, spacing: 12) {
                composer(narrow: narrow)
                    .padding(.horizontal, inset)
                    .padding(.bottom, 8)
            }
            .foregroundStyle(ink)
        }
        .background(Color(red: 0.97, green: 0.96, blue: 0.92).ignoresSafeArea())
        .tint(ink)
        .preferredColorScheme(.light)
        .onChange(of: scenePhase) { _, phase in if phase == .background { store.enteredBackground() } }
        .onChange(of: store.results.first?.id) { _, firstID in
            // Do not interrupt a new description being typed as a request finishes.
            if firstID != nil && !descriptionFocused { setComposerMinimized(true) }
        }
        .sheet(item: $export, onDismiss: cleanExport) { item in
            switch item.kind {
            case .share: ShareSheet(item: item, finish: finishExport)
            case .print: PrintSheet(item: item, finish: finishExport).interactiveDismissDisabled()
            }
        }
        .popover(isPresented: $showUsage) {
            usageSheet.presentationCompactAdaptation(.popover)
        }
        .alert("About generation", isPresented: $showAbout) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.isMock
                 ? "Demo mode makes \(ColoringViewModel.batchSize) sample pictures with illustrative usage. No paid request is sent. Swipe between them to choose a sheet."
                 : "Each tap generates \(ColoringViewModel.batchSize) sheets in parallel using paid API credit for all \(ColoringViewModel.batchSize). Swipe to choose a sheet; Share, Save to Photos, and Print use the visible sheet. Age stays on this iPad. Keep the app open while generating; stopping or leaving it may still result in charges.")
        }
        .alert("Generation details", isPresented: Binding(get: { detailMessage != nil }, set: { if !$0 { detailMessage = nil } })) {
            Button("OK", role: .cancel) { detailMessage = nil }
        } message: { Text(detailMessage ?? "") }
        .alert("Export unavailable", isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })) {
            Button("OK") { exportError = nil }
        } message: { Text(exportError ?? "") }
        .alert("Saved to Photos", isPresented: Binding(get: { photoSaveConfirmation != nil }, set: { if !$0 { photoSaveConfirmation = nil } })) {
            Button("OK") { photoSaveConfirmation = nil }
        } message: { Text(photoSaveConfirmation ?? "") }
    }

    private func header(narrow: Bool) -> some View {
        HStack(spacing: 12) {
            if !narrow {
                Label("Coloring Sheets", systemImage: "pencil.and.outline").font(.headline)
                Spacer(minLength: 0)
            }
            if !store.results.isEmpty { galleryNavigation }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { exportButtons; usageButton }
                HStack(spacing: 8) { exportButtons; usageButton }.labelStyle(.iconOnly)
            }
            .buttonStyle(.bordered)
            .disabled(store.result == nil)
            if narrow { Spacer(minLength: 0) }
        }
        .frame(minHeight: 44)
    }

    private var galleryNavigation: some View {
        HStack(spacing: 0) {
            Button { movePage(by: -1) } label: {
                Image(systemName: "chevron.left").frame(width: 44, height: 44)
            }
            .disabled(store.selectedIndex == 0)
            .accessibilityLabel("Previous sheet")
            .accessibilityIdentifier("previousSheet")
            Text("\(store.selectedIndex + 1) of \(store.results.count)")
                .font(.subheadline.weight(.medium)).monospacedDigit()
                .fixedSize()
                .accessibilityLabel("Sheet \(store.selectedIndex + 1) of \(store.results.count)")
                .accessibilityIdentifier("sheetPosition")
            Button { movePage(by: 1) } label: {
                Image(systemName: "chevron.right").frame(width: 44, height: 44)
            }
            .disabled(store.selectedIndex == store.results.count - 1)
            .accessibilityLabel("Next sheet")
            .accessibilityIdentifier("nextSheet")
        }
        .buttonStyle(.plain)
    }

    private func movePage(by offset: Int) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
            store.selectResult(at: store.selectedIndex + offset)
        }
    }

    private func setComposerMinimized(_ minimized: Bool) {
        if minimized { descriptionFocused = false }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
            composerMinimized = minimized
        }
    }

    private func composer(narrow: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if composerMinimized {
                HStack(spacing: 12) {
                    Button {
                        setComposerMinimized(false)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "square.and.pencil")
                            Text(minimizedPrompt)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Edit description: \(minimizedPrompt)")
                    .accessibilityHint("Opens the description editor")
                    .accessibilityIdentifier("expandComposer")
                    Button {
                        store.description = ""
                        setComposerMinimized(false)
                        descriptionFocused = true
                    } label: {
                        Label("New sheet", systemImage: "plus")
                            .foregroundStyle(.white).frame(minHeight: 32)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.isGenerating)
                    .accessibilityIdentifier("newSheet")
                }
            } else {
                controls(narrow: narrow)
            }
            generationStatus
        }
        .padding(.horizontal, 16)
        .padding(.vertical, composerMinimized ? 6 : 12)
        .background(.white, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(ink.opacity(0.12)))
        .shadow(color: ink.opacity(0.06), radius: 8, y: 3)
    }

    static func minimizedPrompt(from description: String) -> String {
        let firstLine = description
            .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map(String.init) ?? ""
        return firstLine.isEmpty ? "Edit description" : firstLine
    }

    private var minimizedPrompt: String { Self.minimizedPrompt(from: store.description) }

    private func controls(narrow: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("What shall we draw?").font(.subheadline.weight(.semibold))
                Spacer(minLength: 4)
                if descriptionFocused {
                    Button("Done") { descriptionFocused = false }
                        .accessibilityIdentifier("dismissKeyboard")
                } else if store.result != nil {
                    Button { setComposerMinimized(true) } label: {
                        Label("Minimize", systemImage: "chevron.down")
                    }
                    .accessibilityIdentifier("minimizeComposer")
                }
            }
            .frame(minHeight: 32)

            // Never swap this field's parent when focus or window width changes.
            HStack(alignment: .center, spacing: 12) {
                TextField("Describe your coloring sheet…", text: $store.description, axis: .vertical)
                    .lineLimit(1...3)
                    .focused($descriptionFocused)
                    .padding(.vertical, 8)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Description")
                    .accessibilityIdentifier("subject")
                Button {
                    descriptionFocused = false
                    store.generate()
                } label: {
                    Group {
                        if narrow {
                            Image(systemName: "sparkles").frame(minWidth: 28, minHeight: 32)
                        } else {
                            Label(store.isMock ? "Make \(ColoringViewModel.batchSize) demo sheets" : "Generate \(ColoringViewModel.batchSize) sheets", systemImage: "sparkles")
                                .frame(minHeight: 32)
                        }
                    }
                    .foregroundStyle(store.isGenerating || store.validationMessage != nil ? ink : .white)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isGenerating || store.validationMessage != nil)
                .accessibilityLabel(store.isMock ? "Make \(ColoringViewModel.batchSize) demo sheets" : "Generate \(ColoringViewModel.batchSize) coloring sheets")
                .accessibilityIdentifier("generate")
            }
            Divider()
            HStack(spacing: 8) {
                Text("Child’s age").font(.subheadline)
                Picker("Child’s age", selection: $store.age) {
                    Text("Choose").tag(0)
                    ForEach(3...18, id: \.self) { age in Text("\(age) years").tag(age) }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("age")
                Spacer(minLength: 0)
                if store.isMock && !narrow { Text("DEMO · NO CHARGES").font(.caption) }
                else if let remaining = store.access.freeGenerationsRemaining, !narrow {
                    Text("\(remaining) free today").font(.caption).foregroundStyle(.secondary)
                }
                Button { showAbout = true } label: {
                    Image(systemName: "info.circle").frame(width: 44, height: 44)
                }
                .accessibilityLabel("About age and generation costs")
            }
        }
    }

    @ViewBuilder private var generationStatus: some View {
        if store.isGenerating {
            HStack {
                ProgressView()
                Text(store.progressText).font(.callout)
                    .accessibilityIdentifier("generationProgress")
                Spacer()
                Button("Stop waiting", role: .cancel, action: store.cancel)
            }
            .accessibilityHint("Keep the app open. Generation may take a few minutes.")
        } else if let message = store.batchMessage {
            Button { detailMessage = message + "\n\nTemporary rate limits are retried automatically up to \(WorkerClient.maximumRateLimitRetries) times." } label: {
                Label("\(store.results.count) sheets available · Details", systemImage: "exclamationmark.circle")
                    .font(.footnote)
            }
        } else if case .error(let message) = store.phase {
            Button { detailMessage = message + "\n\nTemporary rate limits are retried automatically up to \(WorkerClient.maximumRateLimitRetries) times." } label: {
                Label("Generation needs attention", systemImage: "exclamationmark.circle")
                    .font(.footnote)
            }
        } else if let message = store.validationMessage, !composerMinimized {
            Button { detailMessage = message } label: {
                Label(validationSummary, systemImage: "info.circle")
                    .font(.footnote).lineLimit(1)
            }.accessibilityIdentifier("validation")
        }
    }

    private var validationSummary: String {
        if store.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Enter a description to begin" }
        if store.age == 0 { return "Choose a child’s age" }
        return "Shorten the description · Details"
    }

    private var preview: some View {
        GeometryReader { canvas in
            let page = store.pageFormat.fittedSize(in: canvas.size)
            Group {
                if !store.results.isEmpty {
                    TabView(selection: $store.selectedResultID) {
                        ForEach(store.results) { result in
                            Image(uiImage: result.image).resizable().scaledToFit()
                                .frame(width: page.width, height: page.height)
                                .background(.white)
                                .shadow(color: ink.opacity(0.08), radius: 6, y: 2)
                                .frame(width: canvas.size.width, height: canvas.size.height)
                                .accessibilityLabel("Generated coloring sheet preview")
                                .accessibilityHint("Swipe left or right to choose a sheet")
                                .accessibilityIdentifier("sheetPreview")
                                .tag(Optional(result.id))
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .accessibilityIdentifier("sheetGallery")
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "pencil.and.outline").font(.system(size: 40, weight: .ultraLight))
                        Text("\(ColoringViewModel.batchSize) sheets to choose from.\nDescribe an idea below to begin.").font(.callout).multilineTextAlignment(.center)
                    }.padding(16).foregroundStyle(.secondary)
                        .frame(width: page.width, height: page.height)
                        .background(.white)
                        .shadow(color: ink.opacity(0.08), radius: 6, y: 2)
                }
            }
            .frame(width: canvas.size.width, height: canvas.size.height)
            .onAppear { updateGenerationSize(canvas.size) }
            .onChange(of: canvas.size) { _, size in updateGenerationSize(size) }
            .onChange(of: displayScale) { _, _ in updateGenerationSize(canvas.size) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func updateGenerationSize(_ size: CGSize) {
        // The keyboard changes only the display, not the next image's resolution.
        guard !descriptionFocused else { return }
        store.updatePreview(size: size, displayScale: displayScale)
    }

    private var usageButton: some View {
        Button { showUsage = true } label: {
            Image(systemName: "chart.bar.xaxis")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
            .buttonStyle(.plain)
            .accessibilityLabel("Usage and estimated cost")
    }
    private var usageSheet: some View {
        NavigationStack {
            List {
                Section("Gallery") {
                    metric("Sheets available", "\(store.results.count)")
                    let estimates = store.results.compactMap { $0.metrics?.estimatedTotalUsd }
                    metric("Returned estimates combined", estimates.isEmpty ? "Unavailable" : String(format: "$%.6f USD", estimates.reduce(0, +)))
                    Text("Only returned image estimates are included. Failed or unfinished generations may also be charged.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let result = store.result {
                    Section("Selected sheet · \(store.selectedIndex + 1) of \(store.results.count)") {
                        metric("Model", result.requestedModel.label)
                        metric("Model sent to OpenAI", result.metrics?.requestedModel ?? "Unavailable")
                        metric("Requested pixels", result.metrics?.requestedSize ?? "Unavailable")
                        metric("Image pixels", "\(result.image.cgImage?.width ?? 0) × \(result.image.cgImage?.height ?? 0)")
                        metric("Input tokens", count(result.metrics?.inputTokens))
                        metric("Text / image input tokens", "\(count(result.metrics?.textInputTokens)) / \(count(result.metrics?.imageInputTokens))")
                        metric("Output tokens", count(result.metrics?.outputTokens))
                        metric("Total tokens", count(result.metrics?.totalTokens))
                        metric("Duration", result.metrics?.elapsedMs.map { String(format: "%.1f seconds", $0 / 1000) } ?? "Unavailable")
                        metric("Estimated cost", result.metrics?.estimatedTotalUsd.map { String(format: "$%.6f USD", $0) } ?? "Unavailable")
                        Text(result.metrics?.estimateBasis ?? "Usage details were not returned. This does not mean the generation was free.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Usage & estimated cost")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showUsage = false } } }
        }
        .frame(minWidth: 420, idealWidth: 460, minHeight: 520)
    }
    @ViewBuilder private var exportButtons: some View {
        Button { beginExport(.share) } label: { Label("Share", systemImage: "square.and.arrow.up") }
        Button(action: saveToPhotos) {
            Label(isSavingPhoto ? "Saving…" : "Save to Photos", systemImage: "photo.badge.arrow.down")
        }
        .disabled(isSavingPhoto)
        Button { beginExport(.print) } label: { Label("Print", systemImage: "printer") }
    }
    private func count(_ value: Int?) -> String { value.map(String.init) ?? "Unavailable" }
    private func metric(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) { Text(label).foregroundStyle(.secondary); Spacer(); Text(value).multilineTextAlignment(.trailing) }.font(.callout)
    }
    private func beginExport(_ kind: ExportItem.Kind) {
        descriptionFocused = false
        guard let result = store.result else { return }
        do { let item = try ExportItem(kind: kind, result: result); retainedExport = item; export = item }
        catch { exportError = "The PNG could not be prepared. Please try again." }
    }
    private func finishExport(_ message: String?) { export = nil; if let message { exportError = message } }
    private func cleanExport() { retainedExport?.cleanUp(); retainedExport = nil }
    private func saveToPhotos() {
        descriptionFocused = false
        guard let data = store.result?.data, !isSavingPhoto else { return }
        isSavingPhoto = true
        PhotoLibrarySaver.save(data) { result in
            isSavingPhoto = false
            switch result {
            case .success: photoSaveConfirmation = "The coloring sheet is now in your Photos library."
            case .failure(let error): exportError = error.localizedDescription
            }
        }
    }
}
