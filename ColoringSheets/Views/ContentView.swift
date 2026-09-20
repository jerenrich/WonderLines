import SwiftUI

struct ContentView: View {
    @ObservedObject var store: ColoringViewModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.displayScale) private var displayScale
    @FocusState private var descriptionFocused: Bool
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
            let compact = geometry.size.height < 600 || geometry.size.width < 700 || descriptionFocused || typeSize.isAccessibilitySize
            let horizontal = geometry.size.width >= 700 || descriptionFocused
            let layout = horizontal
                ? AnyLayout(HStackLayout(alignment: .top, spacing: 24))
                : AnyLayout(VStackLayout(spacing: 16))
            // Preserve the text field's identity while focus or window size changes.
            // Replacing its parent branch on focus destroys the active responder.
            layout {
                controls(compact: compact)
                    .frame(width: descriptionFocused
                           ? min(640, geometry.size.width - 32)
                           : horizontal ? min(340, geometry.size.width * 0.36) : nil)
                if !descriptionFocused { preview }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(compact ? 16 : 24)
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
            .background(Color(red: 0.97, green: 0.96, blue: 0.92))
            .foregroundStyle(ink)
        }
        .tint(ink)
        .preferredColorScheme(.light)
        .onChange(of: scenePhase) { _, phase in if phase == .background { store.enteredBackground() } }
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
                 ? "Demo mode uses a sample picture and illustrative usage. No paid request is sent."
                 : "Age stays on this iPad. We send a description of the level of detail. Each generation uses paid API credit. Review the sheet before sharing it with your child. Keep the app open while generating; stopping or leaving it may still result in a charge.")
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

    private func controls(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 18) {
            HStack {
                Text("What shall we draw?").font(.headline)
                Spacer(minLength: 4)
                if descriptionFocused {
                    Button("Done") { descriptionFocused = false }.font(.headline)
                } else {
                    Button { showAbout = true } label: { Image(systemName: "info.circle") }
                        .accessibilityLabel("About age and generation costs")
                }
            }
            if store.isMock { Text("DEMO · NO CHARGES").font(.caption.bold()) }
            TextField("Describe your coloring sheet…", text: $store.description, axis: .vertical)
                .lineLimit(compact ? 2 : 4, reservesSpace: true)
                .focused($descriptionFocused)
                .padding(12).background(.white, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("subject")
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("Child’s age").font(.headline)
                    Spacer()
                    Text(store.age == 0 ? "Slide to choose" : "\(store.age) years").monospacedDigit()
                }
                Slider(value: Binding(
                    get: { Double(max(3, store.age)) },
                    set: { store.age = Int($0.rounded()) }
                ), in: 3...18, step: 1, onEditingChanged: { editing in
                    if editing && store.age == 0 { store.age = 3 }
                })
                .accessibilityLabel("Child’s age")
                .accessibilityValue(store.age == 0 ? "Not selected" : "\(store.age) years")
                .accessibilityIdentifier("age")
                if !compact {
                    HStack { Text("3 years"); Spacer(); Text("18 years") }
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Button {
                descriptionFocused = false
                store.generate()
            } label: {
                Label(store.isMock ? "Make a demo sheet" : "Generate coloring sheet", systemImage: "sparkles")
                    .foregroundStyle(store.isGenerating || store.validationMessage != nil ? ink : .white)
                    .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .disabled(store.isGenerating || store.validationMessage != nil)
            .accessibilityIdentifier("generate")
            if store.isGenerating {
                HStack {
                    ProgressView()
                    Text("Drawing…").font(.callout)
                    Spacer()
                    Button("Stop waiting", role: .cancel, action: store.cancel)
                }
                .accessibilityHint("Keep the app open. Generation may take a few minutes.")
            } else if case .error(let message) = store.phase {
                Button { detailMessage = message + "\n\nNo automatic retry was made." } label: {
                    Label("Generation needs attention", systemImage: "exclamationmark.circle")
                        .font(.footnote)
                }
            } else if let message = store.validationMessage {
                Button { detailMessage = message } label: {
                    Label(validationSummary, systemImage: "info.circle")
                        .font(.footnote).lineLimit(1)
                }.accessibilityIdentifier("validation")
            }
        }
    }

    private var validationSummary: String {
        if store.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Enter a description to begin" }
        if store.age == 0 { return "Choose a child’s age" }
        return "Shorten the description · Details"
    }

    private var preview: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your coloring sheet").font(.headline)
            GeometryReader { canvas in
                let page = store.pageFormat.fittedSize(in: canvas.size)
                ZStack {
                    Rectangle().fill(.white)
                    if let result = store.result {
                        Image(uiImage: result.image).resizable().scaledToFit()
                            .frame(width: page.width, height: page.height)
                            .accessibilityLabel("Generated coloring sheet preview")
                    } else {
                        VStack(spacing: 12) {
                            Image(systemName: "pencil.and.outline").font(.system(size: 40, weight: .ultraLight))
                            Text("Your sheet will appear here.").font(.callout).multilineTextAlignment(.center)
                        }.padding(16).foregroundStyle(.secondary)
                    }
                }
                .frame(width: page.width, height: page.height)
                .frame(width: canvas.size.width, height: canvas.size.height)
                .onAppear { store.updatePreview(size: canvas.size, displayScale: displayScale) }
                .onChange(of: canvas.size) { _, size in store.updatePreview(size: size, displayScale: displayScale) }
                .onChange(of: displayScale) { _, scale in store.updatePreview(size: canvas.size, displayScale: scale) }
            }
            // Reserve the toolbar before generation so the displayed page keeps its size.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { exportButtons; Spacer(minLength: 0); usageButton }
                HStack(spacing: 8) { exportButtons; Spacer(minLength: 0); usageButton }.labelStyle(.iconOnly)
            }
            .buttonStyle(.bordered).controlSize(.regular)
            .frame(minHeight: 44)
            .opacity(store.result == nil ? 0 : 1)
            .disabled(store.result == nil)
            .accessibilityHidden(store.result == nil)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
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
                if let result = store.result {
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
