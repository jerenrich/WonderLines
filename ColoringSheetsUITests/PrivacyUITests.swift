import XCTest

final class PrivacyUITests: XCTestCase {
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
        app.launchArguments = ["--mock", "--require-consent", "-aiSharingConsentVersion", "0", "-descriptionDraft", "A friendly flower", "-imageCount", "1"]
        app.launch()
        app.buttons["generate"].tap()
        XCTAssertTrue(app.buttons["cancelAIConsent"].waitForExistence(timeout: 5))
        capture("First generation consent")
        reveal(app.buttons["cancelAIConsent"], in: app)
        app.buttons["cancelAIConsent"].tap()
        XCTAssertFalse(app.images["sheetPreview"].exists)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "subject").firstMatch.value as? String, "A friendly flower")
        app.buttons["generate"].tap()
        reveal(app.buttons["agreeToAI"], in: app)
        app.buttons["agreeToAI"].tap()
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 10))
        app.terminate()
        app.launchArguments = ["--mock", "--require-consent", "-descriptionDraft", "A friendly flower", "-imageCount", "1"]
        app.launch()
        app.buttons["generate"].tap()
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["agreeToAI"].exists)
        app.buttons["settings"].tap()
        reveal(app.buttons["withdrawConsent"], in: app)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "privacyPolicy").firstMatch.exists)
        capture("Privacy settings")
        app.buttons["withdrawConsent"].tap()
        app.buttons["Withdraw consent"].tap()
        app.buttons["Done"].tap()
        app.buttons["generate"].tap()
        XCTAssertTrue(app.buttons["agreeToAI"].waitForExistence(timeout: 5))
        reveal(app.buttons["cancelAIConsent"], in: app)
        app.buttons["cancelAIConsent"].tap()
        app.buttons["settings"].tap()
        reveal(app.buttons["deleteAccount"], in: app)
        app.buttons["deleteAccount"].tap()
        capture("Delete confirmation")
        app.buttons.matching(NSPredicate(format: "label == %@", "Delete account and data")).allElementsBoundByIndex.last!.tap()
        XCTAssertTrue(app.alerts["Privacy & safety"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
        XCTAssertFalse(app.images["sheetPreview"].exists)
        XCTAssertFalse(app.buttons["generate"].isEnabled)
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
