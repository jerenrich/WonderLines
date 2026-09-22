import XCTest

final class GalleryUITests: XCTestCase {
    // Opt-in smoke check of the actual app, Keychain and deployed Worker. One
    // button tap only; never automatically retry a paid generation.
    @MainActor
    func testExplicitLiveGeneration() throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_LIVE_UI_CHECK"] == "one-batch" else {
            throw XCTSkip("Live UI generation requires explicit opt-in.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 10))
        subject.tap()
        subject.typeText("Baby on moon")
        app.buttons["dismissKeyboard"].tap()
        app.buttons["age"].tap()
        app.buttons["18 years"].tap()
        app.buttons["generate"].tap()

        let complete = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["generationProgress"])
        XCTAssertEqual(XCTWaiter.wait(for: [complete], timeout: 240), .completed)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Live iPad generation result"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(app.staticTexts["sheetPosition"].exists, "At least one live sheet must reach the gallery: \(app.debugDescription)")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "configuration update")).firstMatch.exists)
    }

    @MainActor
    func testSwipingAndArrowsSelectSheetsAndEditingRetainsGallery() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchArguments = ["--mock"]
        app.launch()

        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        subject.typeText("Dinosaur riding a bike on the moon")
        app.buttons["dismissKeyboard"].tap()
        app.buttons["age"].tap()
        app.buttons["6 years"].tap()
        app.buttons["generate"].tap()

        let position = app.staticTexts["sheetPosition"]
        func expectPage(_ number: Int) {
            let expectation = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label == %@", "Sheet \(number) of 5"), object: position)
            XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 8), .completed)
        }
        expectPage(1)
        XCTAssertTrue(app.buttons["expandComposer"].exists)
        XCTAssertFalse(app.buttons["previousSheet"].isEnabled)
        let gallery = app.descendants(matching: .any).matching(identifier: "sheetGallery").firstMatch
        XCTAssertTrue(gallery.exists)
        gallery.swipeLeft()
        expectPage(2)
        gallery.swipeRight()
        expectPage(1)
        app.buttons["nextSheet"].tap()
        expectPage(2)
        gallery.swipeLeft()
        expectPage(3)
        gallery.swipeLeft()
        expectPage(4)
        gallery.swipeLeft()
        expectPage(5)
        gallery.swipeLeft()
        expectPage(5)
        XCTAssertFalse(app.buttons["nextSheet"].isEnabled)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Five-sheet landscape gallery"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        app.buttons["expandComposer"].tap()
        subject.tap()
        subject.typeText(" with stars")
        expectPage(5)
        XCTAssertTrue(gallery.exists)
        app.buttons["dismissKeyboard"].tap()
        app.buttons["minimizeComposer"].tap()
        expectPage(5)
        XCTAssertTrue(app.buttons["expandComposer"].label.contains("with stars"))
        app.buttons["previousSheet"].tap()
        expectPage(4)
    }
}
