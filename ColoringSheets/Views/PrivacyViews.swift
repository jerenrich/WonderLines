import SwiftUI

struct AIConsentView: View {
    @ObservedObject var store: ColoringViewModel
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Before your first sheet").font(.title2.bold())
                    Text("To create your sheet, Wonder Lines sends your description to Cloudflare and TypeSafe AI for safety checks. Your description, drawing difficulty and model choice are also sent to Cloudflare for processing and to the selected image provider: OpenAI, Cloudflare Workers AI or fal.ai.")
                    Text("These services may retain request logs. Wonder Lines stores generated sheets and an anonymous service account so you can recover unfinished work. Please leave names and other personal information out of descriptions.")
                    Link("Read the privacy policy", destination: PrivacyConsent.policyURL)
                    Text("Your choice is remembered. You can withdraw consent or delete your account and data in Settings.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button(store.consentActionTitle) { store.acceptConsent() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("agreeToAI")
                    Button("Cancel", role: .cancel) { store.showsConsent = false }
                        .accessibilityIdentifier("cancelAIConsent")
                }.padding(24).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }
            .navigationTitle("AI generation")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct SheetReportView: View {
    @ObservedObject var store: ColoringViewModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Send this sheet to Wonder Lines support for review. Support can inspect the saved sheet and its generation details. A successfully reported sheet is removed from your gallery and recovery.")
                    Button(store.isReporting ? "Sending…" : "Send report") {
                        Task {
                            await store.reportSelectedSheet(reason: .other)
                            dismiss()
                        }
                    }
                    .disabled(store.isReporting)
                    .accessibilityIdentifier("sendSheetReport")
                    Link("Privacy policy", destination: PrivacyConsent.policyURL)
                    Link("Contact support", destination: PrivacyConsent.supportURL)
                }
            }
            .navigationTitle("Report sheet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(store.isReporting) } }
        }.interactiveDismissDisabled(store.isReporting)
    }
}
