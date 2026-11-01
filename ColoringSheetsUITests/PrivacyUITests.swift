import XCTest

final class PrivacyUITests: XCTestCase {
    @MainActor
    func testTypeSafeNoticeRequiresRenewedConsent() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "--require-consent", "--fixed-parental-gate", "-aiSharingConsentVersion", "1",
                               "-descriptionDraft", "A friendly dinosaur riding a bicycle on the moon", "-imageCount", "1"]
        app.launch()
        app.buttons["generate"].tap()
        // A wrong answer replaces the question and never reveals the notice.
        answerGate("12", in: app)
        XCTAssertTrue(app.staticTexts["parentalGateWrong"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["agreeToAI"].exists)
        capture("Parental gate")
        answerGate("98", in: app)
        XCTAssertTrue(app.buttons["cancelAIConsent"].waitForExistence(timeout: 5))
        let disclosure = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Cloudflare and TypeSafe AI")).firstMatch
        XCTAssertTrue(disclosure.exists, "Updated disclosure must name both safety providers.")
        XCTAssertTrue(app.staticTexts["supervisionNotice"].exists, "The notice asks for a parent or guardian.")
        capture("Build 9 TypeSafe sharing notice")
        reveal(app.buttons["cancelAIConsent"], in: app)
        app.buttons["cancelAIConsent"].tap()
        XCTAssertTrue(app.buttons["generate"].isEnabled)
        app.buttons["generate"].tap()
        answerGate("98", in: app)
        XCTAssertTrue(disclosure.waitForExistence(timeout: 5), "Cancel must not accept the revised notice.")
        reveal(app.buttons["agreeToAI"], in: app)
        app.buttons["agreeToAI"].tap()
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["agreeToAI"].exists)
        capture("Build 9 sheet after updated consent")
    }
    @MainActor
    private func answerGate(_ value: String, in app: XCUIApplication) {
        let field = app.textFields["parentalGateAnswer"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText(value)
        app.buttons["parentalGateContinue"].tap()
    }
    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<7 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
    }
    @MainActor
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    @MainActor
    func testConsentIsOneOffAndSettingsAllowWithdrawalAndDeletion() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "--require-consent", "--fixed-parental-gate", "-aiSharingConsentVersion", "0", "-descriptionDraft", "A friendly flower", "-imageCount", "1"]
        app.launch()
        app.buttons["generate"].tap()
        XCTAssertTrue(app.buttons["cancelAIConsent"].waitForExistence(timeout: 5))
        capture("First generation consent")
        reveal(app.buttons["cancelAIConsent"], in: app)
        app.buttons["cancelAIConsent"].tap()
        XCTAssertFalse(app.images["sheetPreview"].exists)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "subject").firstMatch.value as? String, "A friendly flower")
        app.buttons["generate"].tap()
        answerGate("98", in: app)
        reveal(app.buttons["agreeToAI"], in: app)
        app.buttons["agreeToAI"].tap()
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 10))
        app.terminate()
        app.launchArguments = ["--mock", "--require-consent", "--fixed-parental-gate", "-descriptionDraft", "A friendly flower", "-imageCount", "1"]
        app.launch()
        app.buttons["generate"].tap()
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["agreeToAI"].exists)
        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        reveal(app.buttons["withdrawConsent"], in: app)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "privacyPolicy").firstMatch.exists)
        capture("Privacy settings")
        app.buttons["withdrawConsent"].tap()
        app.buttons["Withdraw consent"].tap()
        app.buttons["Done"].tap()
        app.buttons["generate"].tap()
        answerGate("98", in: app)
        XCTAssertTrue(app.buttons["agreeToAI"].waitForExistence(timeout: 5))
        reveal(app.buttons["cancelAIConsent"], in: app)
        app.buttons["cancelAIConsent"].tap()
        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        reveal(app.buttons["deleteAccount"], in: app)
        app.buttons["deleteAccount"].tap()
        capture("Delete confirmation")
        app.buttons.matching(NSPredicate(format: "label == %@", "Delete account and data")).allElementsBoundByIndex.last!.tap()
        XCTAssertTrue(app.alerts["Privacy & safety"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
        XCTAssertFalse(app.images["sheetPreview"].exists)
        XCTAssertTrue(app.buttons["surpriseMe"].isEnabled)
    }
    @MainActor
    func testReportSheetRemovesItOnlyAfterSending() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "A friendly flower", "-imageCount", "1"]
        app.launch()
        app.buttons["generate"].tap()
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 10))
        if !app.buttons["reportSheet"].isHittable { app.buttons["sheetActions"].tap() }
        app.buttons["reportSheet"].tap()
        XCTAssertTrue(app.navigationBars["Report sheet"].waitForExistence(timeout: 5))
        capture("Report sheet")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.images["sheetPreview"].exists)
        if !app.buttons["reportSheet"].isHittable { app.buttons["sheetActions"].tap() }
        app.buttons["reportSheet"].tap()
        reveal(app.buttons["sendSheetReport"], in: app)
        app.buttons["sendSheetReport"].tap()
        XCTAssertTrue(app.alerts["Privacy & safety"].waitForExistence(timeout: 5))
        capture("Report received")
        app.alerts.buttons["OK"].tap()
        XCTAssertFalse(app.images["sheetPreview"].exists)
    }
}
