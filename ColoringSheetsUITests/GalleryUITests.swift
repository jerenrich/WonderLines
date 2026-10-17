import XCTest

final class GalleryUITests: XCTestCase {
    @MainActor
    func testFirstLaunchGeneratesWithoutOpeningSettings() {
        continueAfterFailure = false
        let app = XCUIApplication()
        // Run on a newly installed app: do not supply an age preference.
        app.launchArguments = ["--mock", "-descriptionDraft", ""]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["generate"].isEnabled, "An empty description cannot generate")
        subject.tap()
        subject.typeText("A friendly dinosaur riding a bicycle on the moon")
        app.buttons["dismissKeyboard"].tap()
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "First launch after entering a description"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(app.buttons["generate"].isEnabled, "A fresh install must generate without a hidden Settings prerequisite")
        app.buttons["generate"].tap()
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["sheetPosition"].label, "Sheet 1 of 3")
    }

    @MainActor
    func testUnsetAgeAndInvalidDescriptionRecoverWithoutRelaunch() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-childAge", "0", "-imageCount", "1"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        app.buttons["settings"].tap()
        XCTAssertEqual(app.staticTexts["ageSettingValue"].label, "6 years")
        app.buttons["Done"].tap()
        subject.tap()
        subject.typeText(String(repeating: "flower ", count: 75))
        app.buttons["dismissKeyboard"].tap()
        XCTAssertFalse(app.buttons["generate"].isEnabled)
        app.buttons["validation"].tap()
        XCTAssertTrue(app.alerts["Generation details"].waitForExistence(timeout: 3))
        app.alerts.buttons["OK"].tap()
        app.buttons["clearDescription"].tap()
        subject.typeText("A flower")
        app.buttons["dismissKeyboard"].tap()
        XCTAssertTrue(app.buttons["generate"].isEnabled)
        app.buttons["generate"].tap()
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["sheetPosition"].label, "Sheet 1 of 1")
    }

    @MainActor
    func testBackgroundDuringSubmissionKeepsAllThreeSheets() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "--slow-mock", "-childAge", "8", "-imageCount", "3"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        subject.typeText("Synthetic background test flower")
        app.buttons["dismissKeyboard"].tap()
        app.buttons["generate"].tap()
        let progress = app.staticTexts["generationProgress"]
        XCTAssertTrue(progress.waitForExistence(timeout: 3))
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5))
        app.activate()
        XCTAssertTrue(progress.waitForExistence(timeout: 3))
        XCTAssertTrue(progress.label.hasPrefix("Checking 3 sheets"), "A resumed batch must show the recovery state while sheets are still pending")
        XCTAssertTrue(app.images["sheetPreview"].waitForExistence(timeout: 20))
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: progress)
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 5), .completed, "The remaining sheets must also finish")
        XCTAssertEqual(app.staticTexts["sheetPosition"].label, "Sheet 1 of 3")
    }

    @MainActor
    private func waitUntilHittable(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        // activate() can return while SpringBoard is still animating the app
        // into view. Its cached accessibility tree already exists at that point.
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed, file: file, line: line)
    }

    @MainActor
    func testMultilineDescriptionRemainsEditableAfterResume() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-childAge", "6"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        let draft = "A fox in a moonlit garden\nwith stars and flowers\nand a little pond"
        subject.typeText(draft)
        XCTAssertEqual(subject.value as? String, draft)
        app.buttons["dismissKeyboard"].tap()
        XCUIDevice.shared.press(.home)
        app.activate()
        waitUntilHittable(app.buttons["clearDescription"])
        XCTAssertTrue(app.buttons["clearDescription"].isHittable)
        for point in [CGVector(dx: 0.2, dy: 0.2), CGVector(dx: 0.5, dy: 0.5), CGVector(dx: 0.9, dy: 0.8)] {
            subject.coordinate(withNormalizedOffset: point).tap()
            XCTAssertEqual(subject.value as? String, draft, "Positioning the cursor must preserve every line")
        }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        // A tap chooses a native insertion point; it must not select and replace
        // the existing description when the next character is entered.
        subject.typeText("#")
        let edited = subject.value as? String
        XCTAssertTrue(edited?.contains("#") == true)
        XCTAssertEqual(edited?.replacingOccurrences(of: "#", with: ""), draft)
        app.buttons["clearDescription"].tap()
        XCTAssertEqual(subject.value as? String, "")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        subject.typeText("A garden")
        XCTAssertEqual(subject.value as? String, "A garden")
    }

    @MainActor
    func testDescriptionDraftSurvivesAppTermination() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-childAge", "6"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        subject.typeText("A fox with stars")
        app.terminate()

        // Remove the initial empty-draft override to exercise disk restoration.
        app.launchArguments = ["--mock", "-childAge", "6"]
        app.launch()
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        XCTAssertEqual(subject.value as? String, "A fox with stars")
        XCTAssertTrue(app.buttons["clearDescription"].isHittable)
        subject.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(subject.value as? String, "A fox with stars")
        app.buttons["clearDescription"].tap()
        app.terminate()
        app.launch()
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        XCTAssertEqual(subject.placeholderValue, "Describe your coloring sheet…")
        XCTAssertFalse(app.buttons["clearDescription"].exists)
        subject.tap()
        subject.typeText("A garden")
        XCTAssertEqual(subject.value as? String, "A garden")
    }

    @MainActor
    func testDescriptionRemainsEditableAndClearableAfterResume() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-childAge", "6"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        subject.typeText("A fox")

        // Exercise resume both with and without an active editor.
        for dismissBeforeBackground in [false, true, false] {
            if dismissBeforeBackground { app.buttons["dismissKeyboard"].tap() }
            XCUIDevice.shared.press(.home)
            app.activate()
            waitUntilHittable(app.buttons["clearDescription"])
            let resumed = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            resumed.name = "Description after resume, dismissed before background: \(dismissBeforeBackground)"
            resumed.lifetime = .keepAlways
            add(resumed)
            XCTAssertEqual(subject.value as? String, "A fox")
            XCTAssertTrue(app.buttons["clearDescription"].isHittable, app.debugDescription)
            // Tapping anywhere in the editable area must never act as Clear.
            for x in [0.1, 0.5, 0.9] {
                subject.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)).tap()
                XCTAssertEqual(subject.value as? String, "A fox")
            }
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        }

        subject.typeText(" with stars")
        XCTAssertEqual(subject.value as? String, "A fox with stars")
        app.buttons["clearDescription"].tap()
        XCTAssertEqual(subject.value as? String, "")
        XCTAssertFalse(app.buttons["clearDescription"].exists)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        subject.typeText("A garden")
        XCTAssertEqual(subject.value as? String, "A garden")
    }

    @MainActor
    func testMinimizedDescriptionPreservesTextAndOffersExplicitClear() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-childAge", "6", "-imageCount", "1"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        subject.typeText("A fox")
        app.buttons["dismissKeyboard"].tap()
        app.buttons["generate"].tap()
        XCTAssertTrue(app.staticTexts["sheetPosition"].waitForExistence(timeout: 10))
        let selectedSheet = app.staticTexts["sheetPosition"].label
        app.buttons["minimizeComposer"].tap()
        XCUIDevice.shared.press(.home)
        app.activate()
        waitUntilHittable(app.buttons["expandComposer"])
        XCTAssertTrue(app.buttons["clearDescription"].isHittable)
        app.buttons["expandComposer"].tap()
        let expanded = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        expanded.name = "Description reopened after resume"
        expanded.lifetime = .keepAlways
        add(expanded)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(subject.value as? String, "A fox")
        subject.typeText(" with stars")
        XCTAssertEqual(subject.value as? String, "A fox with stars")
        app.buttons["dismissKeyboard"].tap()
        app.buttons["minimizeComposer"].tap()
        app.buttons["clearDescription"].tap()
        XCTAssertEqual(subject.value as? String, "")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["sheetPosition"].label, selectedSheet)
        subject.typeText("A garden")
        XCTAssertEqual(subject.value as? String, "A garden")
    }

    @MainActor
    private func setAge(in app: XCUIApplication, position: CGFloat) {
        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        app.sliders["ageSetting"].adjust(toNormalizedSliderPosition: position)
        app.buttons["Done"].tap()
    }

    @MainActor
    func testSettingsScreenShowsAgeSliderModelAndImageCount() {
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-imageCount", "5", "-childAge", "0"]
        app.launch()
        XCTAssertFalse(app.sliders["ageSetting"].exists)
        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "modelSetting").firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "imageCountSetting").firstMatch.exists)
        for _ in 0..<6 {
            if app.buttons["diagnostics"].exists && app.buttons["diagnostics"].isHittable { break }
            app.swipeUp()
        }
        app.buttons["diagnostics"].tap()
        XCTAssertTrue(app.navigationBars["Diagnostics"].waitForExistence(timeout: 5))
        app.navigationBars["Diagnostics"].buttons.element(boundBy: 0).tap()
        let age = app.sliders["ageSetting"]
        for _ in 0..<6 {
            if age.exists && age.isHittable { break }
            app.swipeDown()
        }
        XCTAssertTrue(age.isHittable)
        XCTAssertEqual(app.staticTexts["ageSettingValue"].label, "6 years")
        age.adjust(toNormalizedSliderPosition: 1)
        age.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: age.coordinate(withNormalizedOffset: CGVector(dx: 1.1, dy: 0.5)))
        XCTAssertEqual(app.staticTexts["ageSettingValue"].label, "18 years")
        age.adjust(toNormalizedSliderPosition: 0)
        age.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: age.coordinate(withNormalizedOffset: CGVector(dx: -0.1, dy: 0.5)))
        XCTAssertEqual(app.staticTexts["ageSettingValue"].label, "3 years")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Settings screen"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["Done"].tap()
        XCTAssertFalse(app.navigationBars["Settings"].exists)
        XCTAssertFalse(app.sliders["ageSetting"].exists)
        app.buttons["settings"].tap()
        XCTAssertEqual(app.staticTexts["ageSettingValue"].label, "3 years")
        app.buttons["Done"].tap()
    }

    @MainActor
    func testPortraitGalleryActionsAndKeyboardSurviveRotation() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-imageCount", "5", "-childAge", "0"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Enter a description to begin"].exists)
        XCTAssertFalse(app.staticTexts["What shall we draw?"].exists)
        XCTAssertFalse(app.buttons["About generation and costs"].exists)
        XCTAssertFalse(app.buttons["clearDescription"].exists)
        XCTAssertEqual(subject.placeholderValue, "Describe your coloring sheet…")
        XCTAssertFalse(app.buttons["ageDifficulty"].exists, "Drawing difficulty is available in Settings")
        subject.tap()
        XCTAssertTrue(app.buttons["dismissKeyboard"].waitForExistence(timeout: 5))
        XCTAssertTrue(subject.placeholderValue?.isEmpty ?? true, "The placeholder disappears on focus")
        let emptyFrame = subject.frame
        subject.typeText("A")
        // The simulator may collapse a software keyboard to its suggestion bar
        // when a hardware keyboard is attached, moving the editor vertically.
        XCTAssertTrue(subject.isHittable, "Typing must leave the editor visible")
        XCTAssertEqual(subject.frame.height, emptyFrame.height, accuracy: 1)
        subject.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(subject.isHittable, "Deleting must leave the editor visible")
        XCTAssertEqual(subject.frame.height, emptyFrame.height, accuracy: 1)
        subject.typeText("A friendly flower")
        XCTAssertTrue(app.buttons["dismissKeyboard"].isHittable)
        app.buttons["dismissKeyboard"].tap()
        setAge(in: app, position: 0.2)
        app.buttons["generate"].tap()
        let position = app.staticTexts["sheetPosition"]
        func assertVisibleSheetMatchesSelection() {
            // Page transitions briefly expose stale accessibility elements.
            // Wait for the visible page and export selection to agree.
            let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let visible = app.images.matching(identifier: "sheetPreview").allElementsBoundByIndex.filter(\.isHittable)
                return visible.count == 1 && visible.first?.value as? String == position.label
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 5), .completed,
                           "The displayed image must match the sheet used for export")
        }
        XCTAssertTrue(position.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["nextSheet"].isHittable)
        XCTAssertTrue(app.buttons["settings"].isHittable)
        app.buttons["nextSheet"].tap()
        XCTAssertEqual(position.label, "Sheet 2 of 3")
        assertVisibleSheetMatchesSelection()

        if app.buttons["sheetActions"].exists {
            app.buttons["sheetActions"].tap()
            XCTAssertTrue(app.buttons["Share"].exists)
            XCTAssertTrue(app.buttons["Save to Photos"].exists)
            XCTAssertTrue(app.buttons["Print"].exists)
        }
        app.buttons["usage"].tap()
        XCTAssertTrue(app.navigationBars["Usage & cost"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Generation is free for you.")).firstMatch.exists)
        XCTAssertTrue(app.buttons["Done"].isHittable)
        let usage = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        usage.name = "Portrait usage fits the display"
        usage.lifetime = .keepAlways
        add(usage)
        app.buttons["Done"].tap()
        XCTAssertEqual(position.label, "Sheet 2 of 3")
        assertVisibleSheetMatchesSelection()

        let portrait = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        portrait.name = "Portrait gallery"
        portrait.lifetime = .keepAlways
        add(portrait)
        let restingSize = subject.frame.size
        subject.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "One tap must open the keyboard after generation")
        XCTAssertEqual(subject.frame.height, restingSize.height, accuracy: 1)
        XCTAssertEqual(subject.frame.width, restingSize.width, accuracy: 1)
        subject.typeText(" with stars")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.buttons["dismissKeyboard"].waitForExistence(timeout: 5))
        // The keyboard and editable field must remain usable after rotation.
        XCTAssertTrue(subject.isHittable)
        subject.typeText(" and a moon")
        let keyboard = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        keyboard.name = "Landscape editing with keyboard"
        keyboard.lifetime = .keepAlways
        add(keyboard)
        app.buttons["dismissKeyboard"].tap()
        app.buttons["minimizeComposer"].tap()
        XCTAssertTrue(app.buttons["expandComposer"].label.contains("and a moon"))
        app.buttons["expandComposer"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "Manually collapsed descriptions must also open the keyboard in one tap")
        subject.typeText("!")
        app.buttons["dismissKeyboard"].tap()
        XCTAssertEqual(position.label, "Sheet 2 of 3")
        assertVisibleSheetMatchesSelection()
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.buttons["nextSheet"].isHittable)
        XCTAssertEqual(position.label, "Sheet 2 of 3")
        assertVisibleSheetMatchesSelection()
        let beforeClearSize = subject.frame.size
        app.buttons["clearDescription"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(subject.value as? String, "")
        XCTAssertFalse(app.buttons["clearDescription"].exists)
        XCTAssertEqual(subject.frame.width, beforeClearSize.width, accuracy: 1)
        XCTAssertEqual(subject.frame.height, beforeClearSize.height, accuracy: 1)
        XCTAssertFalse(app.buttons["generate"].isEnabled)
        subject.typeText("A new idea")
        // On iPhone the keyboard can exist in accessibility before its entrance
        // animation finishes. Wait for it to be on screen before tapping the
        // clear button, whose position moves with the composer during that time.
        let keyboardShown = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let keyboard = app.keyboards.firstMatch
            return keyboard.exists && keyboard.frame.maxY <= app.frame.maxY + 1 &&
                subject.frame.maxY < keyboard.frame.minY
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardShown], timeout: 5), .completed)
        let beforeFocusedClear = subject.frame
        app.buttons["clearDescription"].tap()
        XCTAssertEqual(subject.value as? String, "")
        XCTAssertTrue(subject.isHittable, "Clearing must leave the editor visible")
        XCTAssertEqual(subject.frame.width, beforeFocusedClear.width, accuracy: 1)
        XCTAssertEqual(subject.frame.height, beforeFocusedClear.height, accuracy: 1)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        subject.typeText("A moonlit garden")
        XCTAssertEqual(subject.value as? String, "A moonlit garden")
        app.buttons["dismissKeyboard"].tap()
        XCTAssertEqual(position.label, "Sheet 2 of 3")
        assertVisibleSheetMatchesSelection()
    }

    @MainActor
    func testPortraitControlsWithAccessibilityText() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-imageCount", "1", "-childAge", "6",
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        subject.typeText("A flower")
        // The composer scrolls when larger text and the keyboard exhaust its space.
        if !app.buttons["dismissKeyboard"].isHittable { subject.swipeDown() }
        app.buttons["dismissKeyboard"].tap()
        app.buttons["generate"].tap()
        XCTAssertTrue(app.staticTexts["sheetPosition"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["settings"].isHittable)
        XCTAssertTrue(app.buttons["sheetActions"].isHittable)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Portrait gallery with accessibility text"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Done"].isHittable)
    }

    // Opt-in smoke check of the actual app, Keychain and deployed Worker. One
    // button tap only; never automatically retry a paid generation.
    @MainActor
    func testExplicitLiveGeneration() throws {
        guard ProcessInfo.processInfo.environment["COLORING_EXPLICIT_LIVE_UI_CHECK"] == "one-batch" else {
            throw XCTSkip("Live UI generation requires explicit opt-in.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-descriptionDraft", "", "-imageCount", "1", "-childAge", "0",
                               "-generationModel", "gpt-image-2.5-sunburst"]
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 10))
        subject.tap()
        subject.typeText("A friendly dinosaur riding a bicycle on the moon")
        app.buttons["dismissKeyboard"].tap()
        app.buttons["settings"].tap()
        XCTAssertEqual(app.staticTexts["ageSettingValue"].label, "6 years")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["generate"].isEnabled)
        app.buttons["generate"].tap()

        // A live installation can already contain a saved gallery. Its presence
        // alone cannot prove that this new generation succeeded.
        let progress = app.staticTexts["generationProgress"]
        XCTAssertTrue(progress.waitForExistence(timeout: 5))
        let complete = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                !progress.exists || app.buttons["failureDiagnostics"].exists
            }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [complete], timeout: 240), .completed)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Live iPad generation result"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertFalse(app.buttons["failureDiagnostics"].exists, app.debugDescription)
        XCTAssertTrue(app.staticTexts["sheetPosition"].exists, "At least one live sheet must reach the gallery: \(app.debugDescription)")
        XCTAssertEqual(app.staticTexts["sheetPosition"].label, "Sheet 1 of 1")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "configuration update")).firstMatch.exists)
    }

    @MainActor
    func testSwipingAndArrowsSelectSheetsAndEditingRetainsGallery() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchArguments = ["--mock", "-descriptionDraft", "", "-imageCount", "5", "-childAge", "0"]
        app.launch()

        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 5))
        subject.tap()
        subject.typeText("Dinosaur riding a bike on the moon")
        app.buttons["dismissKeyboard"].tap()
        setAge(in: app, position: 0.2)
        app.buttons["generate"].tap()

        let position = app.staticTexts["sheetPosition"]
        func expectPage(_ number: Int) {
            let expectation = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label == %@", "Sheet \(number) of 3"), object: position)
            XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 8), .completed)
        }
        expectPage(1)
        XCTAssertTrue(subject.isHittable, "Generation must leave the description directly editable")
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
        expectPage(3)
        XCTAssertFalse(app.buttons["nextSheet"].isEnabled)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Three-sheet landscape gallery"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let restingSize = subject.frame.size
        subject.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "One tap must open the keyboard after generation")
        XCTAssertEqual(subject.frame.height, restingSize.height, accuracy: 1)
        XCTAssertEqual(subject.frame.width, restingSize.width, accuracy: 1)
        subject.typeText(" with stars")
        expectPage(3)
        XCTAssertTrue(gallery.exists)
        app.buttons["dismissKeyboard"].tap()
        app.buttons["minimizeComposer"].tap()
        expectPage(3)
        XCTAssertTrue(app.buttons["expandComposer"].label.contains("with stars"))
        app.buttons["previousSheet"].tap()
        expectPage(2)
    }
}

extension GalleryUITests {
    /// Deliberate physical-device review demonstration; never part of routine QA.
    @MainActor
    func testAppReviewPhysicalDemonstration() throws {
        guard ProcessInfo.processInfo.environment["WONDERLINES_APP_REVIEW_CAPTURE"] == "one-batch" else {
            throw XCTSkip("App Review capture requires explicit one-batch opt-in.")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-descriptionDraft", "", "-imageCount", "3", "-childAge", "6", "-generationModel", "gpt-image-2.5-sunburst"]
        app.terminate()
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.launch()
        let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
        XCTAssertTrue(subject.waitForExistence(timeout: 10))
        func capture(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        capture("01-launch")
        app.buttons["settings"].tap()
        XCTAssertTrue(app.sliders["ageSetting"].waitForExistence(timeout: 5))
        capture("02-settings")
        Thread.sleep(forTimeInterval: 3)
        app.buttons["Done"].tap()
        subject.tap()
        subject.typeText("A friendly dinosaur riding a bicycle on the moon")
        app.buttons["dismissKeyboard"].tap()
        capture("03-description")
        app.buttons["generate"].tap()
        let progress = app.staticTexts["generationProgress"]
        XCTAssertTrue(progress.waitForExistence(timeout: 5))
        let completion = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: progress)
        XCTAssertEqual(XCTWaiter.wait(for: [completion], timeout: 240), .completed)
        XCTAssertTrue(app.images["sheetPreview"].exists, app.debugDescription)
        XCTAssertFalse(app.buttons["failureDiagnostics"].exists, app.debugDescription)
        capture("04-live-gallery")
        if app.buttons["nextSheet"].isEnabled {
            app.buttons["nextSheet"].tap()
            capture("05-next-sheet")
            Thread.sleep(forTimeInterval: 3)
            app.buttons["previousSheet"].tap()
        }
        func action(_ label: String) {
            if app.buttons["sheetActions"].exists { app.buttons["sheetActions"].tap() }
            app.buttons[label].tap()
        }
        action("Save to Photos")
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = system.buttons["Allow Photos to Be Added"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        else if system.alerts.buttons["Allow"].exists { system.alerts.buttons["Allow"].tap() }
        let saved = app.staticTexts["The coloring sheet is now in your Photos library."]
        XCTAssertTrue(saved.waitForExistence(timeout: 10), app.debugDescription)
        capture("06-saved-to-photos")
        app.alerts.buttons["OK"].tap()
        action("Share")
        Thread.sleep(forTimeInterval: 3)
        capture("07-system-share")
        if app.buttons["Close"].exists { app.buttons["Close"].tap() }
        else if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
        else { app.swipeDown() }
        XCTAssertTrue(app.buttons["settings"].waitForExistence(timeout: 5))
        action("Print")
        Thread.sleep(forTimeInterval: 3)
        capture("08-print-options")
        XCTAssertTrue(app.buttons["Cancel"].exists, app.debugDescription)
        app.buttons["Cancel"].tap()
        if app.buttons["sheetActions"].exists { app.buttons["sheetActions"].tap() }
        app.buttons["usage"].tap()
        capture("09-usage")
        Thread.sleep(forTimeInterval: 3)
        app.buttons["Done"].tap()
        if app.buttons["editDescription"].exists { app.buttons["editDescription"].tap() }
        subject.tap()
        subject.typeText(" with stars")
        app.buttons["dismissKeyboard"].tap()
        capture("10-edit-and-retain-gallery")
        XCTAssertTrue(app.images["sheetPreview"].exists)
        Thread.sleep(forTimeInterval: 3)
    }
}
