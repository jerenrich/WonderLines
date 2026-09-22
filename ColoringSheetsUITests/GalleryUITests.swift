import XCTest

final class GalleryUITests: XCTestCase {
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
