import SwiftUI

struct ContentView: View {
    @ObservedObject var store: ColoringViewModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var descriptionFocused: Bool
    @State private var composerMinimized = false
    @State private var composerHeight: CGFloat = 240
    @State private var export: ExportItem?
    @State private var retainedExport: ExportItem?
    @State private var exportError: String?
    @State private var photoSaveConfirmation: String?
    @State private var isSavingPhoto = false
    @State private var showUsage = false
    @State private var showSettings = false
    @State private var detailMessage: String?
    private let ink = Color(red: 0.12, green: 0.25, blue: 0.29)
    private let accent = Color(red: 0.12, green: 0.45, blue: 0.49)
    private var sheetCountLabel: String { "\(store.imageCount) \(store.imageCount == 1 ? "sheet" : "sheets")" }
    private var demoCountLabel: String { "\(store.imageCount) demo \(store.imageCount == 1 ? "sheet" : "sheets")" }

    var body: some View {
        GeometryReader { geometry in
            let narrow = geometry.size.width < 600 || typeSize.isAccessibilitySize
            let inset: CGFloat = narrow ? 12 : 24
            let editingInShortWindow = descriptionFocused && geometry.size.height < 300
            let composerLimit = max(44, geometry.size.height - (editingInShortWindow ? 8 : 112))
            VStack(spacing: 12) {
                header(narrow: narrow || geometry.size.height < 400)
                    .frame(height: editingInShortWindow ? 0 : nil)
                    .clipped()
                    .accessibilityHidden(editingInShortWindow)
                preview
                    .clipped()
            }
            .padding(.horizontal, inset)
            .padding(.top, 8)
            // SwiftUI lifts this inset with the system keyboard. The preview and
            // editor keep their identity throughout focus and size changes.
            .safeAreaInset(edge: .bottom, spacing: 12) {
                // Keep one editor in the hierarchy across rotation and keyboard changes.
                // Scrolling is needed only when short windows or large text exhaust the space.
                ScrollView {
                    composer(narrow: narrow)
                        .background(GeometryReader { content in
                            Color.clear
                                .onAppear { composerHeight = content.size.height }
                                .onChange(of: content.size.height) { _, height in composerHeight = height }
                        })
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(composerHeight, composerLimit))
                .padding(.horizontal, inset)
                .padding(.bottom, 8)
            }
            .foregroundStyle(ink)
        }
        .background(LinearGradient(
            colors: [Color(red: 0.98, green: 0.97, blue: 0.94),
                     Color(red: 0.92, green: 0.96, blue: 0.96)],
            startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea())
        .tint(accent)
        .preferredColorScheme(.light)
        .onChange(of: scenePhase) { _, phase in if phase == .background { store.enteredBackground() } }
        .sheet(item: $export, onDismiss: cleanExport) { item in
            switch item.kind {
            case .share: ShareSheet(item: item, finish: finishExport)
            case .print: PrintSheet(item: item, finish: finishExport).interactiveDismissDisabled()
            }
        }
        .popover(isPresented: $showUsage) {
            usageSheet
                .presentationCompactAdaptation(.sheet)
        }
        .sheet(isPresented: $showSettings) { settingsSheet }
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
            if narrow {
                Spacer(minLength: 0)
                Menu {
                    exportButtons
                    Button { showUsage = true } label: {
                        Label("Usage and estimated cost", systemImage: "chart.bar.xaxis")
                    }
                    .accessibilityIdentifier("usage")
                } label: {
                    Image(systemName: "ellipsis.circle").frame(width: 44, height: 44)
                }
                .disabled(store.result == nil)
                .accessibilityLabel("Sheet actions")
                .accessibilityIdentifier("sheetActions")
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { exportButtons; usageButton }
                    HStack(spacing: 8) { exportButtons; usageButton }.labelStyle(.iconOnly)
                }
                .buttonStyle(.bordered)
                .disabled(store.result == nil)
            }
            Button {
                descriptionFocused = false
                showSettings = true
            } label: {
                Image(systemName: "gearshape").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settings")
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
                .lineLimit(1)
                .minimumScaleFactor(0.5)
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
                        descriptionFocused = true
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
                    .accessibilityHint("Opens the keyboard to edit the description")
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
        .overlay(RoundedRectangle(cornerRadius: 18)
            .strokeBorder(accent.opacity(descriptionFocused ? 0.45 : 0.15)))
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
            // Never swap this field's parent when focus or window width changes.
            HStack(alignment: .center, spacing: 12) {
                HStack(spacing: 0) {
                    TextField("Description", text: $store.description,
                              prompt: Text(descriptionFocused ? "" : "Describe your coloring sheet…")
                                .foregroundStyle(.secondary), axis: .vertical)
                        .lineLimit(2, reservesSpace: true)
                        .focused($descriptionFocused)
                        .padding(10)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .accessibilityLabel("Description")
                        .accessibilityIdentifier("subject")
                    Button {
                        store.description = ""
                        descriptionFocused = true
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear description")
                    .accessibilityIdentifier("clearDescription")
                    // Reserve the button's space so clearing never resizes the field.
                    .opacity(store.description.isEmpty ? 0 : 1)
                    .disabled(store.description.isEmpty)
                    .accessibilityHidden(store.description.isEmpty)
                }
                .background(accent.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
                Button {
                    descriptionFocused = false
                    store.generate()
                } label: {
                    Group {
                        if narrow {
                            Image(systemName: "sparkles").frame(minWidth: 28, minHeight: 32)
                        } else {
                            Label(store.isMock ? "Make \(demoCountLabel)" : "Generate \(sheetCountLabel)", systemImage: "sparkles")
                                .frame(minHeight: 32)
                        }
                    }
                    .foregroundStyle(store.isGenerating || store.validationMessage != nil ? ink : .white)
                }
                .fixedSize(horizontal: true, vertical: false)
                .buttonStyle(.borderedProminent)
                .disabled(store.isGenerating || store.validationMessage != nil)
                .accessibilityLabel(store.isMock ? "Make \(demoCountLabel)" : "Generate \(sheetCountLabel)")
                .accessibilityIdentifier("generate")
                Button {
                    if descriptionFocused { descriptionFocused = false }
                    else { setComposerMinimized(true) }
                } label: {
                    Image(systemName: descriptionFocused ? "keyboard.chevron.compact.down" : "chevron.down")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(descriptionFocused ? "Done" : "Minimize description")
                .accessibilityIdentifier(descriptionFocused ? "dismissKeyboard" : "minimizeComposer")
                .opacity(descriptionFocused || store.result != nil ? 1 : 0)
                .disabled(!descriptionFocused && store.result == nil)
                .accessibilityHidden(!descriptionFocused && store.result == nil)
            }
            Group {
                if store.age == 0 {
                    Button {
                        descriptionFocused = false
                        showSettings = true
                    } label: {
                        Label("Choose an age in Settings", systemImage: "slider.horizontal.3")
                            .font(.footnote)
                            .frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("validation")
                } else if !store.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                          let message = store.validationMessage {
                    Button { detailMessage = message } label: {
                        Label("Shorten the description", systemImage: "exclamationmark.circle")
                            .font(.footnote)
                            .frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("validation")
                }
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
            Button { detailMessage = message } label: {
                Label("\(store.results.count) \(store.results.count == 1 ? "sheet" : "sheets") available · Details", systemImage: "exclamationmark.circle")
                    .font(.footnote)
            }
        } else if case .error(let message) = store.phase {
            Button { detailMessage = message } label: {
                Label("Generation needs attention", systemImage: "exclamationmark.circle")
                    .font(.footnote)
            }
        }
    }

    private var preview: some View {
        GeometryReader { canvas in
            let page = store.pageFormat.fittedSize(in: canvas.size)
            Group {
                if !store.results.isEmpty {
                    // Page-style TabView can report its first page while rotation and
                    // the keyboard collapse its canvas. Keep the selection while editing.
                    TabView(selection: Binding(
                        get: { store.selectedResultID },
                        set: { if !descriptionFocused { store.selectedResultID = $0 } })) {
                        ForEach(Array(store.results.enumerated()), id: \.element.id) { index, result in
                            Image(uiImage: result.image).resizable().scaledToFit()
                                .frame(width: page.width, height: page.height)
                                .background(.white)
                                .shadow(color: ink.opacity(0.08), radius: 6, y: 2)
                                .frame(width: canvas.size.width, height: canvas.size.height)
                                .accessibilityLabel("Generated coloring sheet preview")
                                .accessibilityValue("Sheet \(index + 1) of \(store.results.count)")
                                .accessibilityHint("Swipe left or right to choose a sheet")
                                .accessibilityIdentifier("sheetPreview")
                                .tag(Optional(result.id))
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .allowsHitTesting(!descriptionFocused)
                    .accessibilityIdentifier("sheetGallery")
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "pencil.and.outline")
                            .font(.system(size: min(40, page.height * 0.4), weight: .ultraLight))
                        if page.height >= 140 {
                            Text("\(sheetCountLabel) to choose from.\nDescribe an idea below to begin.")
                                .font(.callout).multilineTextAlignment(.center)
                        }
                    }.padding(8).foregroundStyle(.secondary)
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
            .accessibilityIdentifier("usage")
    }
    private var settingsSheet: some View {
        NavigationStack {
            Form {
                Section("Age difficulty") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(store.age == 0 ? "Choose an age" : "\(store.age) years")
                            .font(.headline)
                            .accessibilityIdentifier("ageSettingValue")
                        Slider(value: Binding(
                            get: { Double(max(3, store.age)) },
                            set: { store.age = Int($0) }), in: 3...18, step: 1) {
                            Text("Age difficulty")
                        } minimumValueLabel: {
                            Text("3")
                        } maximumValueLabel: {
                            Text("18")
                        } onEditingChanged: { editing in
                            if editing && store.age == 0 { store.age = 3 }
                        }
                        .accessibilityValue(store.age == 0 ? "Choose an age" : "\(store.age) years")
                        .accessibilityIdentifier("ageSetting")
                    }
                    Text("Younger ages use simpler shapes and larger coloring areas. Older ages add finer details. Your choice stays on this device and applies to the next batch.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Generation") {
                    Picker("Model", selection: $store.model) {
                        ForEach(ImageModel.allCases) { model in
                            Text(model.label).tag(model)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("modelSetting")
                    Text(store.model.detail)
                        .font(.footnote).foregroundStyle(.secondary)
                    Picker("Images per generation", selection: Binding(
                        get: { store.imageCount }, set: { store.setImageCount($0) })) {
                        ForEach(1...ColoringViewModel.batchSize, id: \.self) { count in
                            Text("\(count)").tag(count)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("imageCountSetting")
                    Text("Each image uses one generation. Changes apply to the next batch.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showSettings = false } } }
        }
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
                        metric("Provider", result.metrics?.provider ?? "Unavailable")
                        metric("Model used", result.metrics?.upstreamModel ?? result.metrics?.requestedModel ?? "Unavailable")
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
        .frame(idealWidth: 460, idealHeight: 520)
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
