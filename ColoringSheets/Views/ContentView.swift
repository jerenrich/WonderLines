import SwiftUI

struct ContentView: View {
    @ObservedObject var store: ColoringViewModel
    @ObservedObject private var diagnostics = DiagnosticLog.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var descriptionFocused: Bool
    @State private var composerHeight: CGFloat = 240
    @State private var export: ExportItem?
    @State private var retainedExport: ExportItem?
    @State private var exportError: String?
    @State private var photoSaveConfirmation: String?
    @State private var isSavingPhoto = false
    @State private var showUsage = false
    @State private var showSettings = false
    @State private var showDiagnostics = false
    @State private var showReport = false
    @State private var confirmDeletion = false
    @State private var confirmWithdrawal = false
    @State private var detailMessage: String?
    private let ink = Color(red: 0.12, green: 0.25, blue: 0.29)
    private let accent = Color(red: 0.12, green: 0.45, blue: 0.49)
    private var sheetCountLabel: String { "\(store.imageCount) \(store.imageCount == 1 ? "sheet" : "sheets")" }
    private var demoCountLabel: String { "\(store.imageCount) demo \(store.imageCount == 1 ? "sheet" : "sheets")" }
    private var needsIdea: Bool { store.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var generateTitle: String { store.isMock ? "Make \(demoCountLabel)" : "Generate \(sheetCountLabel)" }
    private var primaryActionTitle: String {
        if store.isRefreshingModels && store.availableModels.isEmpty { return "Loading models…" }
        return store.isGenerating ? "STOP" : (needsIdea ? "Surprise me" : generateTitle)
    }
    private var primaryActionSymbol: String { store.isGenerating ? "stop.fill" : (needsIdea ? "shuffle" : "sparkles") }

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
                if store.deletionPending {
                    HStack(spacing: 10) {
                        if store.isDeletingAccount { ProgressView() }
                        Text(store.isDeletingAccount ? "Deleting your account and saved sheets…" : "Deletion is unfinished. Generation is paused until you retry.")
                            .font(.callout)
                        if !store.isDeletingAccount {
                            Button("Retry") { Task { await store.deleteAccountAndData() } }
                        }
                    }
                    .padding(12).background(.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("deletionStatus")
                }
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
                // Leave room for the floating keyboard toolbar while editing.
                .padding(.bottom, descriptionFocused ? 44 : 8)
            }
            .foregroundStyle(ink)
        }
        .background(LinearGradient(
            colors: [Color(red: 0.98, green: 0.97, blue: 0.94),
                     Color(red: 0.92, green: 0.96, blue: 0.96)],
            startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea())
        .tint(accent)
        .preferredColorScheme(.light)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { descriptionFocused = false }
                    .accessibilityIdentifier("dismissKeyboard")
            }
        }
        .task { await store.enteredForeground() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                guard !Task.isCancelled else { return }
                await store.refreshModelCatalogue()
            }
        }
        .onChange(of: store.sessionID) { _, _ in
            descriptionFocused = false
            showSettings = false
            showUsage = false
            detailMessage = nil
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                // The system can dismiss the keyboard while suspended. Start
                // the next editing session from a known, unfocused state.
                descriptionFocused = false
                store.enteredBackground()
            }
            if phase == .active { Task { await store.enteredForeground() } }
        }
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
        .sheet(isPresented: $store.showsConsent) { AIConsentView(store: store) }
        .sheet(isPresented: $showReport) { SheetReportView(store: store) }
        .alert("Privacy & safety", isPresented: Binding(get: { store.privacyMessage != nil && !showReport }, set: { if !$0 { store.privacyMessage = nil } })) {
            Button("OK") { store.privacyMessage = nil }
        } message: { Text(store.privacyMessage ?? "") }
        .sheet(isPresented: $showSettings) { settingsSheet }
        .sheet(isPresented: $showDiagnostics) {
            NavigationStack {
                diagnosticsSheet
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showDiagnostics = false }
                        }
                    }
            }
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
                Label("Wonder Lines", systemImage: "pencil.and.outline").font(.headline)
                Spacer(minLength: 0)
            }
            if !store.results.isEmpty { galleryNavigation }
            if narrow {
                Spacer(minLength: 0)
                Menu {
                    exportButtons
                    reportButton
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
                    HStack(spacing: 8) { exportButtons; reportButton.labelStyle(.iconOnly); usageButton }
                    HStack(spacing: 8) { exportButtons; reportButton; usageButton }.labelStyle(.iconOnly)
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

    private func composer(narrow: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            controls(narrow: narrow)
            generationStatus
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.white, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18)
            .strokeBorder(accent.opacity(descriptionFocused ? 0.45 : 0.15))
            .allowsHitTesting(false))
        .shadow(color: ink.opacity(0.06), radius: 8, y: 3)
    }

    private func clearDescriptionButton() -> some View {
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
        // Reserve a separate target; only an explicit tap here clears text.
        .opacity(store.description.isEmpty ? 0 : 1)
        .allowsHitTesting(!store.description.isEmpty)
        .disabled(store.description.isEmpty)
        .accessibilityHidden(store.description.isEmpty)
    }

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
                    clearDescriptionButton()
                }
                .background(accent.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
                Button {
                    if store.isGenerating {
                        descriptionFocused = false
                        store.cancel()
                    } else if needsIdea {
                        useSurpriseIdea()
                    } else {
                        descriptionFocused = false
                        store.generate()
                    }
                } label: {
                    Group {
                        if narrow {
                            Image(systemName: primaryActionSymbol)
                                .frame(minWidth: 28, minHeight: 32)
                        } else {
                            // Reserve the same space for all three actions.
                            ZStack {
                                Label(generateTitle, systemImage: "sparkles")
                                Label("Surprise me", systemImage: "shuffle")
                            }
                            .opacity(0)
                            .overlay { Label(primaryActionTitle, systemImage: primaryActionSymbol) }
                            .frame(minHeight: 32)
                        }
                    }
                    .foregroundStyle(store.isGenerating || (!needsIdea && store.validationMessage != nil) ? ink : .white)
                }
                .fixedSize(horizontal: true, vertical: false)
                .buttonStyle(.borderedProminent)
                .tint(store.isGenerating ? Color(uiColor: .systemGray5) : accent)
                .disabled((!store.isGenerating && !needsIdea && store.validationMessage != nil) || store.deletionPending || store.isReporting || (store.isRefreshingModels && store.availableModels.isEmpty))
                .accessibilityLabel(store.isGenerating ? "Stop waiting" : primaryActionTitle)
                .accessibilityHint(store.isGenerating ? "Stops waiting for results. Sheets already requested may still finish." : (needsIdea ? "Fills the description so you can edit it before generating" : ""))
                .accessibilityIdentifier(store.isGenerating ? "stopGeneration" : (needsIdea ? "surpriseMe" : "generate"))
            }
            Group {
                if !store.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   let message = store.validationMessage {
                    Button { detailMessage = message } label: {
                        Label("Review generation settings", systemImage: "exclamationmark.circle")
                            .font(.footnote)
                            .frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("validation")
                }
            }
        }
    }

    @ViewBuilder private var generationStatus: some View {
        if !store.isGenerating, let message = store.batchMessage {
            Button { detailMessage = message } label: {
                Label("\(store.results.count) \(store.results.count == 1 ? "sheet" : "sheets") available · Details", systemImage: "exclamationmark.circle")
                    .font(.footnote)
            }
        } else if case .error(let message) = store.phase {
            HStack(alignment: .top, spacing: 8) {
                Button { detailMessage = message } label: {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "exclamationmark.circle")
                        Text(message).fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.footnote)
                }
                .accessibilityHint("Show the error and suggested next steps")
                Button("Diagnostics") { showDiagnostics = true }
                    .font(.footnote).underline()
                    .accessibilityIdentifier("failureDiagnostics")
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
                        set: { if !descriptionFocused { store.selectResult(id: $0) } })) {
                        ForEach(Array(store.results.enumerated()), id: \.element.id) { index, result in
                            ZoomableSheetPreview(image: result.image, pageSize: page,
                                                 isSelected: store.selectedResultID == result.id,
                                                 position: "Sheet \(index + 1) of \(store.results.count)")
                                .frame(width: canvas.size.width, height: canvas.size.height)
                                .tag(Optional(result.id))
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .allowsHitTesting(!descriptionFocused)
                    .opacity(store.isShowingPreviousBatch ? 0.3 : 1)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: store.isShowingPreviousBatch)
                    .accessibilityIdentifier("sheetGallery")
                    .accessibilityValue(store.isShowingPreviousBatch ? "Previous sheets, waiting for new results" : "Current sheets")
                } else if store.isGenerating {
                    VStack(spacing: 12) {
                        Image(systemName: "pencil.and.outline")
                            .font(.system(size: min(40, page.height * 0.4), weight: .ultraLight))
                        if page.height >= 140 {
                            Text("Your sheets will appear here.")
                                .font(.callout).multilineTextAlignment(.center)
                        }
                    }.padding(8).foregroundStyle(.secondary)
                        .frame(width: page.width, height: page.height)
                        .background(.white)
                        .shadow(color: ink.opacity(0.08), radius: 6, y: 2)
                } else {
                    starterIdeas(in: canvas.size)
                }
            }
            .frame(width: canvas.size.width, height: canvas.size.height)
            .overlay(alignment: .top) {
                if store.isGenerating {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(store.progressText)
                            .font(.callout)
                            .accessibilityIdentifier("generationProgress")
                    }
                    .padding(10)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .padding(8)
                    .allowsHitTesting(false)
                    .accessibilityHint("Keep the app open. Generation may take a few minutes.")
                }
            }
            .onAppear { updateGenerationSize(canvas.size) }
            .onChange(of: canvas.size) { _, size in updateGenerationSize(size) }
            .onChange(of: displayScale) { _, _ in updateGenerationSize(canvas.size) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func starterIdeas(in size: CGSize) -> some View {
        ScrollView {
            VStack(spacing: 18) {
                if size.height >= 340 && !typeSize.isAccessibilitySize {
                    VStack(spacing: 8) {
                        Image("StarterDinosaur")
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 360, maxHeight: min(220, size.height * 0.38))
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .accessibilityLabel("Example coloring sheet: a dinosaur riding a bicycle on the moon")
                        Text("Example: a dinosaur riding a bike on the moon")
                            .font(.caption)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    }
                }
                VStack(spacing: 6) {
                    Text("What shall we draw?")
                        .font(.title2.bold())
                    Text("Try a surprise, or describe your own below.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center)
                Button { useSurpriseIdea() } label: {
                    Label("Surprise me", systemImage: "shuffle")
                        .font(.callout.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .padding(.horizontal, 8)
                        .background(accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                        .contentShape(RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Fills the description so you can edit it before generating")
                .accessibilityIdentifier("starterIdea.surprise")
                .frame(maxWidth: 320)
            }
            .padding(20)
            .frame(maxWidth: .infinity, minHeight: size.height)
        }
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityIdentifier("starterIdeas")
    }

    private func useSurpriseIdea() {
        store.description = StarterIdeas.surprisePrompt
        descriptionFocused = true
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
                        Text("\(store.age) years")
                            .font(.headline)
                            .accessibilityIdentifier("ageSettingValue")
                        Slider(value: Binding(
                            get: { Double(store.age) },
                            set: { store.age = Int($0) }), in: 3...18, step: 1) {
                            Text("Age difficulty")
                        } minimumValueLabel: {
                            Text("3")
                        } maximumValueLabel: {
                            Text("18")
                        }
                        .accessibilityValue("\(store.age) years")
                        .accessibilityIdentifier("ageSetting")
                    }
                    Text("Younger ages use simpler shapes and larger coloring areas. Older ages add finer details.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Generation") {
                    Picker("Model", selection: $store.model) {
                        ForEach(store.availableModels) { model in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(model.label)
                                Text(model.priceSummary).font(.caption).foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("modelChoice.\(model.id.rawValue)")
                            .tag(model.id)
                        }
                    }
                    .pickerStyle(.navigationLink)
                    .disabled(store.availableModels.isEmpty)
                    .accessibilityIdentifier("modelSetting")
                    Text(store.selectedModel?.detail ?? "No image models are currently available.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(store.selectedModel?.price?.explanation ?? "Reference price unavailable.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("Reference prices are in US cents. Tiny nonzero costs show <¢0.01. Actual costs may vary; credits and other service charges are excluded.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let message = store.modelCatalogueMessage {
                        Text(message).font(.footnote).foregroundStyle(.secondary)
                    }
                    Button {
                        Task { await store.refreshModelCatalogue() }
                    } label: {
                        if store.isRefreshingModels { ProgressView("Refreshing models") }
                        else { Text("Refresh models") }
                    }
                    .disabled(store.isRefreshingModels || !store.canUseService)
                    .accessibilityIdentifier("refreshModels")
                    Picker("Images per generation", selection: Binding(
                        get: { store.imageCount }, set: { store.setImageCount($0) })) {
                        ForEach(1...ColoringViewModel.batchSize, id: \.self) { count in
                            Text("\(count)").tag(count)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("imageCountSetting")
                    Text("Generate up to 100 images per day. The daily limit resets at midnight UTC. Changes apply to the next batch.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Privacy & safety") {
                    Link("Privacy policy", destination: PrivacyConsent.policyURL)
                        .accessibilityIdentifier("privacyPolicy")
                    Link("Contact support", destination: PrivacyConsent.supportURL)
                    Link("Email support", destination: PrivacyConsent.emailURL)
                    Text("jordan.erenrich@gmail.com").font(.footnote).textSelection(.enabled)
                    Text(store.hasConsent ? "AI data sharing: agreed. Your choice is saved for future sheets." : "AI data sharing: not agreed. We’ll ask before your next generation.")
                        .font(.footnote)
                    if store.hasConsent {
                        Button("Withdraw AI consent", role: .destructive) { confirmWithdrawal = true }
                            .disabled(store.isDeletingAccount)
                            .accessibilityIdentifier("withdrawConsent")
                    }
                    Button(store.isDeletingAccount ? "Deleting…" : "Delete account and data", role: .destructive) { confirmDeletion = true }
                        .disabled(store.isDeletingAccount || store.isReporting)
                        .accessibilityIdentifier("deleteAccount")
                    if store.deletionPending {
                        Text("Deletion is pending. Generation is paused. Keep the app open while deleting, or retry if the connection was interrupted.")
                            .font(.footnote)
                    }
                    Text("Deletes the anonymous service account, server sheets, reports and local app history. Exported copies remain where you saved them. Provider logs follow the privacy policy.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Help") {
                    NavigationLink {
                        diagnosticsSheet
                    } label: {
                        Label("Diagnostics", systemImage: "waveform.path.ecg")
                    }
                    .accessibilityIdentifier("diagnostics")
                    Text("Recent connection and service events stay on this iPad. Descriptions, images, and credentials are never included.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .confirmationDialog("Delete account and data?", isPresented: $confirmDeletion, titleVisibility: .visible) {
                Button("Delete account and data", role: .destructive) {
                    showSettings = false
                    Task { await store.deleteAccountAndData() }
                }
            } message: { Text("This permanently deletes your service account, server sheets and reports, and your local gallery and history. Generation in progress will be stopped. Exported copies and provider logs are handled as described in the privacy policy.") }
            .confirmationDialog("Withdraw AI consent?", isPresented: $confirmWithdrawal, titleVisibility: .visible) {
                Button("Withdraw consent", role: .destructive) { store.withdrawConsent() }
            } message: { Text("New generation and recovery will pause. Requests already sent cannot be recalled. Your saved sheets remain available. Use Delete account and data to remove stored records.") }
            .navigationTitle("Settings")
            .task { await store.refreshModelCatalogue() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showSettings = false } } }
        }
    }

    private var diagnosticsSheet: some View {
        List {
            Section {
                Text("These events help identify where a generation stopped. Times use this device’s clock. Batch and generation IDs can be matched to service logs. Content moderation events show whether the description was rejected or the safety check was unavailable.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if diagnostics.events.isEmpty {
                ContentUnavailableView("No events yet", systemImage: "waveform.path.ecg",
                                       description: Text("The next generation will add diagnostic events here."))
            } else {
                Section("Recent events") {
                    ForEach(diagnostics.events.reversed()) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.text).font(.callout).textSelection(.enabled)
                            Text(event.date, format: .dateTime.year().month().day().hour().minute().second())
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Diagnostics")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink("Share report", item: diagnostics.report)
                    .disabled(diagnostics.events.isEmpty)
                    .accessibilityIdentifier("shareDiagnostics")
            }
        }
    }
    private var usageSheet: some View {
        NavigationStack {
            List {
                Section("Gallery") {
                    metric("Sheets available", "\(store.results.count)")
                    let estimates = store.results.compactMap { $0.metrics?.estimatedTotalUsd }
                    metric("Developer’s service cost", estimates.isEmpty ? "Unavailable" : PriceDisplay.cents(estimates.reduce(0, +)))
                    Text("Prices are in US cents (¢). Generation is free for you. These are provider costs paid by the developer, including estimates. Failed or unfinished requests may also incur costs for the developer.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let result = store.result {
                    Section("Selected sheet · \(store.selectedIndex + 1) of \(store.results.count)") {
                        metric(result.metrics?.costStatus == "reported" ? "Reported cost" : "Estimated cost",
                               result.metrics?.estimatedTotalUsd.map(PriceDisplay.cents) ?? "Unavailable")
                        metric("Model", result.displayModelLabel)
                        metric("Provider", result.metrics?.provider ?? "Unavailable")
                        metric("Model used", result.metrics?.upstreamModel ?? result.metrics?.requestedModel ?? "Unavailable")
                        metric("Requested pixels", result.metrics?.requestedSize ?? "Unavailable")
                        metric("Image pixels", "\(result.image.cgImage?.width ?? 0) × \(result.image.cgImage?.height ?? 0)")
                        metric("Input tokens", count(result.metrics?.inputTokens))
                        metric("Text / image input tokens", "\(count(result.metrics?.textInputTokens)) / \(count(result.metrics?.imageInputTokens))")
                        metric("Output tokens", count(result.metrics?.outputTokens))
                        metric("Total tokens", count(result.metrics?.totalTokens))
                        metric("Duration", result.metrics?.elapsedMs.map { String(format: "%.1f seconds", $0 / 1000) } ?? "Unavailable")
                        if result.metrics?.provider == "fal" || (result.metrics?.provider == nil && result.requestedModel.usesFalQueue) {
                            metric("Inference time", result.metrics?.inferenceMs.map { String(format: "%.3f seconds", $0 / 1000) } ?? "Unavailable")
                            metric("Billable units", result.metrics?.billableUnits.map { String(format: "%.6f", $0) } ?? "Not yet reported")
                            metric("Unit price", result.metrics?.unitPriceUsd.map {
                                PriceDisplay.cents($0) + " / " + (result.metrics?.billingUnit ?? "billing unit")
                            } ?? "Unavailable")
                            if let requestID = result.metrics?.providerRequestID {
                                metric("fal request ID", requestID)
                            }
                        }
                        Text(result.metrics?.estimateBasis.map(PriceDisplay.text) ?? "Provider cost details are unavailable. Generation is still free for you.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .task(id: store.result?.id) { await store.refreshUsage() }
            .refreshable { await store.refreshUsage() }
            .navigationTitle("Usage & cost")
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
    private var reportButton: some View {
        Button { showReport = true } label: { Label("Report sheet", systemImage: "flag") }
            .disabled(store.isGenerating || store.isReporting || store.deletionPending)
            .help("Report sheet")
            .accessibilityIdentifier("reportSheet")
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

private enum StarterIdeas {
    static var surprisePrompt: String {
        surprisePrompts.randomElement() ?? "A dragon baking cupcakes in a cozy kitchen"
    }

    private static let surprisePrompts = [
        "A dragon baking cupcakes in a cozy kitchen",
        "A stegosaurus wearing a chef hat and making pancakes",
        "A friendly T. rex playing a giant xylophone",
        "An octopus playing several musical instruments",
        "Penguins running an ice cream shop beside an igloo",
        "A robot band making music with pots and pans",
        "A giraffe painting a garden fence with a long brush",
        "A space whale swimming past planets and comets",
        "A sleepy moon reading a bedtime story to little stars",
        "A mouse living in a teacup house with a button door",
        "A cat flying a hot air balloon over a tiny village",
        "A dinosaur train passing a peaceful volcano",
        "A dinosaur blowing bubbles beside a lake",
        "A hippo in a tutu practicing ballet in a giant bubble bath",
        "A snail in a racing helmet driving a carrot-shaped race car",
        "A sheep barber giving fluffy clouds a haircut",
        "A crocodile brushing its enormous smile with a tiny toothbrush",
        "A flamingo trying on roller skates in a fancy shoe shop",
        "A walrus knitting a tiny sweater for a shivering teapot",
        "An octopus tangled in seven scarves while knitting an eighth",
        "A camel running a hat shop with hats balanced on both humps",
        "A kangaroo carrying a tiny brass band in its pouch",
        "A goose in a bow tie serving a fancy dinner inside a giant boot",
        "A llama racing a wheeled bathtub full of rubber ducks",
        "A raccoon astronaut washing cheesy moon dishes in a crater",
        "Fluffy clouds having a pillow fight while feathers drift past the moon",
        "A jellyfish wearing rain boots and splashing in underwater puddles",
        "An elephant drinking from a tiny teacup with its trunk curled politely",
        "A cheetah in slippers being overtaken by snails on tiny scooters",
        "A sloth conducting an orchestra of ringing alarm clocks",
        "A bat hanging upside down while decorating an upside-down birthday cake",
        "Seals balancing plates of wobbly jelly on their noses",
        "A pufferfish selling bubble balloons from a tiny underwater cart",
        "A polar bear in pajamas raiding a refrigerator full of snowballs",
        "A wombat driving a train made of sofa cushions and bedroom slippers",
        "A penguin lifeguard watching over a bathtub full of rubber ducks",
        "A giraffe trying to untangle a mountain of neckties at a tailor shop",
        "A peacock proudly displaying a tail made of patterned umbrellas",
        "A badger catching flying pancakes with an enormous butterfly net",
        "A beaver building a bridge out of giant pencils",
        "A frog juggling lily pads while riding a unicycle",
        "An axolotl wearing a crown and sitting on a throne of bubbles",
        "Ants holding tiny umbrellas beneath a shower of jellybeans",
        "A hamster lifting broccoli dumbbells at a tiny gym",
        "A tortoise moving house with wheels on its shell and socks on its chimney",
        "A magician pulling a very surprised rabbit out of a giant carrot",
        "A smiling cucumber dancing in moon boots beneath a disco ball",
        "A pineapple in sunglasses driving a bus full of giggling fruit",
        "A banana in pajamas brushing its teeth beside a smiling toothpaste tube",
        "A strawberry queen playing chess with marshmallow guards",
        "A slice of toast parachuting onto a breakfast plate with a butter-pat backpack",
        "Cupcakes visiting a barbershop to have their icing mustaches trimmed",
        "A stack of pancakes skiing downhill on two pats of butter",
        "A teapot pouring tiny stars into cups wearing sleeping caps",
        "A broccoli superhero posing proudly for a crowd of cheering peas",
        "A mushroom conducting a choir of singing raindrops",
        "A doughnut dog chasing its own sprinkle-covered tail",
        "An avocado rowing its stone like a boat across a bowl of soup",
        "A slice of pizza knitting a long scarf from stretchy cheese",
        "Marshmallows having a snowball fight in a pile of flour",
        "A pretzel teaching yoga to a class of very tangled pasta",
        "A spaghetti family combing their noodle hair with an enormous fork",
        "A space alien proudly wearing a different sock on each of its six ears",
        "A moon mail carrier delivering letters in a rocket-shaped bathtub",
        "The sun putting on sunscreen while clouds hold up a beach umbrella",
        "A planet practicing hula hoops with its rings while little moons cheer",
        "An astronaut wearing a fishbowl helmet while a goldfish inside blows bubbles",
        "A robot sneezing butterflies into a polka-dot handkerchief",
        "A robot eating nuts-and-bolts cereal with a screwdriver spoon",
        "A flying saucer going through a car wash run by very fluffy sheep",
        "A rocket in pajamas cuddling a teddy bear on a cloud",
        "An alien walking a pet vacuum cleaner on a leash",
        "A robot chef trying to comb spaghetti into a tidy hairstyle",
        "A robot knight riding a wind-up toaster with a tiny saddle",
        "A wizard chasing escaped bubbles with a vacuum cleaner",
        "A friendly witch teaching a broomstick to ride with training wheels",
        "A dragon blowing enormous soap bubbles full of tiny castles",
        "A unicorn untangling a rainbow caught around its horn",
        "A mermaid modeling rain boots for a panel of puzzled seahorses",
        "A fairy holding a giant umbrella over a giant wearing a tiny hat",
        "A giant knitting a rainbow scarf with two chimney-sized knitting needles",
        "A goblin serving tea in upside-down hats to very polite frogs",
        "A yeti getting its fluffy hair styled with a garden rake",
        "A baby dragon hiding behind a flowerpot with its tail sticking out",
        "A castle wearing enormous slippers and tiptoeing through a meadow",
        "A tiny king commanding a bathtub fleet of rubber ducks",
        "A knight in shiny armor riding a very proud hobby horse",
        "A pirate captain steering a ship made from a giant sandwich",
        "A caterpillar bus wearing a different sock on every foot",
        "A train made of teacups pulled by a whistling kettle",
        "A bicycle with square wheels being lifted along by cheerful umbrellas",
        "An airplane wearing a scarf and mittens while flying through fluffy clouds",
        "An octopus captain steering a goldfish-bowl submarine",
        "A giraffe wearing a lighthouse as a hat while tiny boats circle its feet",
        "A house riding a giant snail in a very slow race",
        "An umbrella taking a shower beneath a tiny rain cloud",
        "A grandfather clock wearing sneakers and chasing a runaway teacup",
        "A library where the books wear pajamas and nap in tiny bunk beds",
        "A T. rex using a grabber stick to put a party hat on its head",
        "An octopus waiter delivering a tower of pancakes on eight roller skates"
    ]
}

/// UIKit keeps the pinch centered under the fingers and bounds panning to the sheet.
private struct ZoomableSheetPreview: UIViewRepresentable {
    let image: UIImage
    let pageSize: CGSize
    let isSelected: Bool
    let position: String

    func makeUIView(context: Context) -> SheetZoomView { SheetZoomView() }

    func updateUIView(_ view: SheetZoomView, context: Context) {
        view.imageView.image = image
        view.position = position
        view.pageSize = pageSize
        if !isSelected { view.setZoomScale(1, animated: false) }
        view.setNeedsLayout()
        view.updateAccessibility()
    }
}

private final class SheetZoomView: UIScrollView, UIScrollViewDelegate {
    let imageView = UIImageView()
    var pageSize: CGSize = .zero
    var position = ""
    private var previousSize: CGSize = .zero
    private var previousPageSize: CGSize = .zero

    init() {
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 5
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        // At full size, one-finger swipes belong to the gallery.
        panGestureRecognizer.isEnabled = false
        imageView.contentMode = .scaleAspectFit
        imageView.backgroundColor = .white
        imageView.isAccessibilityElement = true
        imageView.accessibilityIdentifier = "sheetPreview"
        imageView.accessibilityLabel = "Generated coloring sheet preview"
        imageView.accessibilityHint = "Pinch to zoom, then drag to explore. Double-tap to zoom in or out. Swipe left or right at full size to choose a sheet."
        addSubview(imageView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0, pageSize.width > 0, pageSize.height > 0 else { return }
        if previousSize != bounds.size || previousPageSize != pageSize {
            previousSize = bounds.size
            previousPageSize = pageSize
            // Fit again after rotation, keyboard changes, or window resizing.
            setZoomScale(1, animated: false)
            imageView.frame = CGRect(origin: .zero, size: pageSize)
            contentSize = pageSize
        }
        centerSheet()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        panGestureRecognizer.isEnabled = zoomScale > 1
        centerSheet()
        updateAccessibility()
    }

    private func centerSheet() {
        imageView.center = CGPoint(x: max(contentSize.width, bounds.width) / 2,
                                   y: max(contentSize.height, bounds.height) / 2)
    }

    func updateAccessibility() {
        imageView.accessibilityValue = zoomScale > 1.01
            ? "\(position), \(Int((zoomScale * 100).rounded())) percent zoom"
            : position
    }

    @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
        let animated = !UIAccessibility.isReduceMotionEnabled
        if zoomScale > 1.01 {
            setZoomScale(1, animated: animated)
        } else {
            let point = gesture.location(in: imageView)
            let size = CGSize(width: bounds.width / 2, height: bounds.height / 2)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                            width: size.width, height: size.height), animated: animated)
        }
    }
}
