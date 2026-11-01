import SwiftUI

/// An adult-level task shown before the AI sharing notice can be accepted, so a
/// parent or guardian, not a child, makes the data-sharing choice.
struct ParentalGateQuestion: Equatable {
    let left: Int, right: Int
    var answer: Int { left * right }
    var prompt: String { "What is \(left) × \(right)?" }
    static func random() -> Self {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--fixed-parental-gate") { return Self(left: 14, right: 7) }
        #endif
        return Self(left: Int.random(in: 12...19), right: Int.random(in: 3...9))
    }
}

struct AIConsentView: View {
    @ObservedObject var store: ColoringViewModel
    @State private var gatePassed = false
    @State private var question = ParentalGateQuestion.random()
    @State private var answer = ""
    @State private var wrongAnswer = false
    @FocusState private var answerFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if gatePassed { notice } else { gate }
                }.padding(24).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }
            .navigationTitle(gatePassed ? "AI generation" : "For grown-ups")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    @ViewBuilder private var gate: some View {
        Text("Ask a grown-up").font(.title2.bold())
        Text("Before the first sheet, a parent or guardian needs to read and accept how Wonder Lines uses descriptions.")
        Text(question.prompt).font(.title3.weight(.semibold))
            .accessibilityIdentifier("parentalGateQuestion")
        TextField("Answer", text: $answer)
            .keyboardType(.numberPad)
            .textFieldStyle(.roundedBorder)
            .focused($answerFocused)
            .frame(maxWidth: 200)
            .accessibilityIdentifier("parentalGateAnswer")
        if wrongAnswer {
            Text("That isn’t right. Here’s a new question.").font(.footnote).foregroundStyle(.red)
                .accessibilityIdentifier("parentalGateWrong")
        }
        Button("Continue") { check() }
            .buttonStyle(.borderedProminent)
            .disabled(answer.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("parentalGateContinue")
        Button("Cancel", role: .cancel) { store.showsConsent = false }
            .accessibilityIdentifier("cancelAIConsent")
    }

    @ViewBuilder private var notice: some View {
        Text("Before the first sheet").font(.title2.bold())
        Text("Children should use Wonder Lines with a parent or guardian.").font(.headline)
            .accessibilityIdentifier("supervisionNotice")
        Text("To create a sheet, Wonder Lines sends the description to Cloudflare and TypeSafe AI for safety checks. The description, drawing difficulty and model choice are also sent to Cloudflare for processing and to the selected image provider: OpenAI, Cloudflare Workers AI or fal.ai. These requests don’t include a name, account or device identifier.")
        Text("Sheets are kept on our service for 24 hours so an interrupted one can be recovered, then deleted. The app uses an anonymous account with no name or sign-in, which is deleted after 180 days without use. These services may keep request logs under their own terms. Descriptions are screened for personal details, such as full names or addresses, by an automated filter, and rejected when it finds them. The filter can miss things, so please remind children to leave them out.")
        PrivacyPolicyLink(title: "Read the privacy policy")
        Text("Your choice is remembered. You can withdraw consent or delete the account and its data in Settings.")
            .font(.footnote).foregroundStyle(.secondary)
        Button(store.consentActionTitle) { store.acceptConsent() }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("agreeToAI")
        Button("Cancel", role: .cancel) { store.showsConsent = false }
            .accessibilityIdentifier("cancelAIConsent")
    }

    private func check() {
        if Int(answer.trimmingCharacters(in: .whitespaces)) == question.answer {
            answerFocused = false
            gatePassed = true
        } else {
            wrongAnswer = true
            answer = ""
            question = ParentalGateQuestion.random()
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
                    PrivacyPolicyLink()
                    Link("Contact support", destination: PrivacyConsent.supportURL)
                }
            }
            .navigationTitle("Report sheet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(store.isReporting) } }
        }.interactiveDismissDisabled(store.isReporting)
    }
}
