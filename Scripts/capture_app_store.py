#!/usr/bin/env python3
"""Capture the current UI with local artwork in an isolated simulator-only copy.

Usage: python3 Scripts/capture_app_store.py --device UUID --family iphone [--output PATH]
The shipping app and its Xcode project are never modified.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DELIVERY = ROOT / 'docs/app-store/2026-11-04'
WORK = ROOT / '.build/general-purpose-store-capture'
STAGE = WORK / 'project'

ARTWORK = {
    'ScreenshotReef': 'datasets/colouring-sheets/images/raw/20261005-sunburst-r01/age-15/cs009-age15-20261005-sunburst-r01-v01.png',
    'ScreenshotButterfly': 'datasets/colouring-sheets/images/raw/20261005-sunburst-r01/age-15/cs012-age15-20261005-sunburst-r01-v01.png',
}

APP = '''import SwiftUI

@main
struct ColoringSheetsApp: App {
    @StateObject private var store: ColoringViewModel
    init() {
        ExportItem.cleanAbandonedExports()
        let defaults = UserDefaults(suiteName: "StoreScreenshotSession")!
        defaults.removePersistentDomain(forName: "StoreScreenshotSession")
        defaults.set(1, forKey: "imageCount")
        defaults.set(15, forKey: "childAge")
        defaults.set(ImageModel.sunburst.rawValue, forKey: "generationModel")
        let value = ColoringViewModel(service: ScreenshotGenerator(), isMock: false,
                                      defaults: defaults, requiresConsent: false)
        value.description = ProcessInfo.processInfo.arguments.contains("--butterfly")
            ? "Butterfly sitting on a daisy" : "Whale swimming through a coral reef"
        _store = StateObject(wrappedValue: value)
    }
    var body: some Scene { WindowGroup { ContentView(store: store) } }
}

@MainActor
final class ScreenshotGenerator: GenerationServing {
    func generate(_ request: GenerationRequest) async throws -> ColoringResult {
        let asset = request.originalDescription.contains("Butterfly") ? "ScreenshotButterfly" : "ScreenshotReef"
        let image = UIImage(named: asset)!
        return ColoringResult(data: image.pngData()!, image: image,
                              requestedModel: request.model, metrics: nil)
    }
}
'''

CAPTURE = '''import XCTest
import UIKit

final class AppStoreCaptureTests: XCTestCase {
    @MainActor
    func testCapture() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        // Screenshot-only binary has no networking service or paid requests.
        app.launchArguments = []
        app.launch()
        let tablet = UIDevice.current.userInterfaceIdiom == .pad
        XCUIDevice.shared.orientation = tablet ? .landscapeLeft : .portrait
        let generate = app.buttons["generate"]
        XCTAssertTrue(generate.waitForExistence(timeout: 10))
        generate.tap()
        XCTAssertTrue(app.staticTexts["sheetPosition"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["sheetPosition"].label, "Sheet 1 of 1")
        capture("01-create-your-coloring-page")

        if tablet {
            // Relaunch with the second saved page; iPad captures do not need a keyboard.
            app.terminate()
            app.launchArguments = ["--butterfly"]
            app.launch()
            XCTAssertTrue(generate.waitForExistence(timeout: 10))
            generate.tap()
            XCTAssertTrue(app.staticTexts["sheetPosition"].waitForExistence(timeout: 10))
            capture("02-intricate-nature-details")
        } else {
            let subject = app.descendants(matching: .any).matching(identifier: "subject").firstMatch
            subject.tap()
            app.buttons["clearDescription"].tap()
            subject.typeText("Butterfly sitting on a daisy")
            app.buttons["dismissKeyboard"].tap()
            generate.tap()
            XCTAssertTrue(app.staticTexts["sheetPosition"].waitForExistence(timeout: 10))
            capture("02-intricate-nature-details")
            subject.tap()
            XCTAssertTrue(app.buttons["dismissKeyboard"].waitForExistence(timeout: 5))
            capture("03-describe-your-idea")
            app.buttons["dismissKeyboard"].tap()
        }

        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.sliders["drawingDetail"].exists)
        capture("04-choose-your-drawing-detail")
        app.buttons["Done"].tap()

        if !tablet {
            app.buttons["sheetActions"].tap()
            XCTAssertTrue(app.buttons["Print"].waitForExistence(timeout: 5))
            capture("05-save-share-and-print")
        } else {
            XCUIDevice.shared.orientation = .portrait
            capture("05-portrait-gallery")
        }
        XCUIDevice.shared.orientation = .portrait
    }

    @MainActor
    private func capture(_ name: String) {
        // Allow UIKit animations and orientation changes to finish.
        Thread.sleep(forTimeInterval: 1.5)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
'''

def prepare():
    if STAGE.exists():
        raise SystemExit('Staging project already exists; use --reuse to capture it again.')
    STAGE.mkdir(parents=True)
    for name in ['ColoringSheets', 'ColoringSheetsTests', 'ColoringSheetsUITests', 'Scripts', 'Config']:
        shutil.copytree(ROOT / name, STAGE / name,
                        ignore=shutil.ignore_patterns('Local.xcconfig', '__pycache__'))
    (STAGE / 'ColoringSheets.xcodeproj/xcshareddata/xcschemes').mkdir(parents=True)
    (STAGE / 'ColoringSheets/ColoringSheetsApp.swift').write_text(APP)
    (STAGE / 'ColoringSheetsUITests/AppStoreCaptureTests.swift').write_text(CAPTURE)
    for name, source in ARTWORK.items():
        asset = STAGE / f'ColoringSheets/Assets.xcassets/{name}.imageset'
        asset.mkdir()
        shutil.copy2(ROOT / source, asset / 'page.png')
        (asset / 'Contents.json').write_text(json.dumps({
            'images': [{'filename': 'page.png', 'idiom': 'universal'}],
            'info': {'author': 'xcode', 'version': 1}}))
    # Give capture builds their own installation and Keychain namespace.
    project_script = STAGE / 'Scripts/create_project.py'
    project_script.write_text(project_script.read_text().replace(
        'com.jordan.family.ColoringSheets', 'com.jordan.family.ColoringSheets.screenshots'))
    subprocess.run(['python3', str(STAGE / 'Scripts/create_project.py')], check=True)
    print('Prepared isolated screenshot project', flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', required=True)
    parser.add_argument('--family', choices=['iphone', 'iphone-medium', 'ipad'], required=True)
    parser.add_argument('--reuse', action='store_true')
    parser.add_argument('--output', type=Path, default=DELIVERY, help='Folder for upload-ready screenshots')
    args = parser.parse_args()
    delivery = args.output.resolve()
    if not args.reuse:
        prepare()
    else:
        (STAGE / 'ColoringSheets/ColoringSheetsApp.swift').write_text(APP)
        (STAGE / 'ColoringSheetsUITests/AppStoreCaptureTests.swift').write_text(CAPTURE)
    env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
    index = 1
    while (WORK / f'{args.family}-{index}.xcresult').exists():
        index += 1
    result = WORK / f'{args.family}-{index}.xcresult'
    subprocess.run(['xcrun', 'simctl', 'boot', args.device], env=env, capture_output=True)
    subprocess.run(['xcrun', 'simctl', 'bootstatus', args.device, '-b'], env=env, check=True)
    subprocess.run(['xcrun', 'simctl', 'status_bar', args.device, 'override', '--time', '9:41',
                    '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
                    '--batteryState', 'charged', '--batteryLevel', '100'], env=env, check=True)
    command = ['xcodebuild', '-project', str(STAGE / 'ColoringSheets.xcodeproj'),
               '-scheme', 'ColoringSheets', '-configuration', 'Debug',
               '-destination', f'platform=iOS Simulator,id={args.device}',
               '-derivedDataPath', str(WORK / 'DerivedData'),
               '-resultBundlePath', str(result), '-parallel-testing-enabled', 'NO',
               '-only-testing:ColoringSheetsUITests/AppStoreCaptureTests/testCapture',
               'COLORING_MODE=mock', 'test']
    log = WORK / f'{args.family}-capture.log'
    print(f'Capturing {args.family}; log: {log}', flush=True)
    with log.open('w') as stream:
        completed = subprocess.run(command, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if completed.returncode:
        print('\n'.join(log.read_text().splitlines()[-65:]))
        raise SystemExit(completed.returncode)
    export = WORK / f'{args.family}-{index}-attachments'
    subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(result),
                    '--output-path', str(export)], env=env, check=True)
    destination = delivery / {'iphone': 'iphone-6.9-inch', 'iphone-medium': 'iphone-medium', 'ipad': 'ipad-13-inch'}[args.family]
    destination.mkdir(parents=True, exist_ok=True)
    pairs = []
    for group in json.loads((export / 'manifest.json').read_text()):
        for attachment in group['attachments']:
            name = attachment['suggestedHumanReadableName'].split('_0_')[0] + '.png'
            source = export / attachment['exportedFileName']
            width, height, depth, color = struct.unpack('>IIBB', source.read_bytes()[16:26])
            accepted = {(1320, 2868), (2868, 1320), (1206, 2622), (2622, 1206), (1179, 2556), (2556, 1179)} if args.family.startswith('iphone') else {(2752, 2064), (2064, 2752), (2732, 2048), (2048, 2732)}
            if (width, height) not in accepted or color != 2:
                raise SystemExit(f'Unexpected screenshot dimensions or alpha channel: {source}')
            pairs.extend([str(source), str(destination / name)])
    subprocess.run(['swift', str(ROOT / 'Scripts/normalize_screenshots.swift'), *pairs], env=env, check=True)
    for screenshot in destination.glob('*.png'):
        width, height, depth, color = struct.unpack('>IIBB', screenshot.read_bytes()[16:26])
        if (width, height) not in accepted or color != 2:
            raise SystemExit(f'Unexpected normalized screenshot format: {screenshot}')
    print(f'Capture succeeded. Upload-ready screenshots: {destination}', flush=True)

if __name__ == '__main__':
    main()
