#!/usr/bin/env python3
"""Deterministic, dependency-free Xcode project generator; rerun after adding Swift files."""
from pathlib import Path
import hashlib
import json
root = Path(__file__).resolve().parents[1]
objects = {}
def uid(name): return hashlib.sha1(name.encode()).hexdigest()[:24].upper()
def obj(name, body):
    objects[uid(name)] = body
    return uid(name)
def quoted(value): return json.dumps(value)
def array(values): return '(' + ', '.join(values) + (',' if values else '') + ')'
def settings(values): return '{' + ''.join(f'{k} = {quoted(str(v))};' for k, v in values.items()) + '}'
app_files = sorted((root / 'ColoringSheets').rglob('*.swift'))
test_files = sorted((root / 'ColoringSheetsTests').rglob('*.swift'))
ui_test_files = sorted((root / 'ColoringSheetsUITests').rglob('*.swift'))
asset_catalog = 'ColoringSheets/Assets.xcassets'
asset_ref = obj(asset_catalog, f'{{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = {quoted(asset_catalog)}; sourceTree = SOURCE_ROOT;}}')
asset_build = obj(asset_catalog+'build', f'{{isa = PBXBuildFile; fileRef = {asset_ref};}}')
resources = obj('Appresources', f'{{isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = {array([asset_build])}; runOnlyForDeploymentPostprocessing = 0;}}')
groups = []
for group, files in [('App', app_files), ('Tests', test_files), ('UITests', ui_test_files)]:
    refs, builds = [], []
    for file in files:
        path = str(file.relative_to(root))
        ref = obj(path, f'{{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {quoted(path)}; sourceTree = SOURCE_ROOT;}}')
        refs.append(ref)
        builds.append(obj(path+'build', f'{{isa = PBXBuildFile; fileRef = {ref};}}'))
    if group == 'App': refs.append(asset_ref)
    groups.append(obj(group, f'{{isa = PBXGroup; name = {group}; children = {array(refs)}; sourceTree = "<group>";}}'))
    obj(group+'sources', f'{{isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {array(builds)}; runOnlyForDeploymentPostprocessing = 0;}}')
app_product = obj('appProduct', '{isa = PBXFileReference; explicitFileType = wrapper.application; path = ColoringSheets.app; sourceTree = BUILT_PRODUCTS_DIR;}')
test_product = obj('testProduct', '{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = ColoringSheetsTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;}')
ui_test_product = obj('uiTestProduct', '{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = ColoringSheetsUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;}')
products = obj('products', f'{{isa = PBXGroup; name = Products; children = {array([app_product,test_product,ui_test_product])}; sourceTree = "<group>";}}')
local = obj('localConfig', '{isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Config/Base.xcconfig; sourceTree = SOURCE_ROOT;}')
main = obj('main', f'{{isa = PBXGroup; children = {array(groups+[local,products])}; sourceTree = "<group>";}}')
script = obj('secretScript', '{isa = PBXShellScriptBuildPhase; buildActionMask = 2147483647; alwaysOutOfDate = 1; files = (); inputPaths = (); outputPaths = (); name = "Bundle local service configuration"; runOnlyForDeploymentPostprocessing = 0; shellPath = /bin/sh; shellScript = "set -eu\\n/usr/bin/python3 \\"$SRCROOT/Scripts/build_configuration.py\\"\\n"; showEnvVarsInLog = 0;}')
# Use JSON quoting for the script string in the OpenStep plist.
objects[script] = '{isa = PBXShellScriptBuildPhase; buildActionMask = 2147483647; alwaysOutOfDate = 1; files = (); inputPaths = (); outputPaths = (); name = "Bundle local service configuration"; runOnlyForDeploymentPostprocessing = 0; shellPath = /bin/sh; shellScript = ' + quoted('set -eu\n/usr/bin/python3 "$SRCROOT/Scripts/build_configuration.py"\n') + '; showEnvVarsInLog = 0;}'
for scope in ['Project','App','Tests','UITests']:
    configs=[]
    for config in ['Debug','Release']:
        values = {'SWIFT_VERSION':'5.0', 'IPHONEOS_DEPLOYMENT_TARGET':'17.0', 'SDKROOT':'iphoneos', 'TARGETED_DEVICE_FAMILY':'2', 'CLANG_ENABLE_MODULES':'YES', 'ENABLE_USER_SCRIPT_SANDBOXING':'NO'}
        if config == 'Debug': values.update({'ENABLE_TESTABILITY':'YES','ONLY_ACTIVE_ARCH':'YES','SWIFT_OPTIMIZATION_LEVEL':'-Onone','SWIFT_ACTIVE_COMPILATION_CONDITIONS':'DEBUG','GCC_PREPROCESSOR_DEFINITIONS':'DEBUG=1 $(inherited)'})
        else: values.update({'SWIFT_COMPILATION_MODE':'wholemodule','SWIFT_OPTIMIZATION_LEVEL':'-O'})
        if scope == 'App':
            values.update({'PRODUCT_BUNDLE_IDENTIFIER':'com.jordan.family.ColoringSheets','PRODUCT_NAME':'ColoringSheets','GENERATE_INFOPLIST_FILE':'YES','INFOPLIST_KEY_CFBundleDisplayName':'Coloring Sheets','INFOPLIST_KEY_NSPhotoLibraryAddUsageDescription':'Save coloring sheets to your Photos library.','INFOPLIST_KEY_UILaunchScreen_Generation':'YES','INFOPLIST_KEY_UIApplicationSceneManifest_Generation':'YES','INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad':'UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight','CODE_SIGN_STYLE':'Automatic','MARKETING_VERSION':'1.0','CURRENT_PROJECT_VERSION':'1','SUPPORTS_MACCATALYST':'NO','SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD':'NO','ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon','COLORING_MODE':'live' if config == 'Release' else '$(inherited)'})
            if config == 'Debug': del values['COLORING_MODE']
        if scope == 'Tests':
            values.update({'PRODUCT_BUNDLE_IDENTIFIER':'com.jordan.family.ColoringSheetsTests','PRODUCT_NAME':'$(TARGET_NAME)','GENERATE_INFOPLIST_FILE':'YES','TEST_HOST':'$(BUILT_PRODUCTS_DIR)/ColoringSheets.app/ColoringSheets','BUNDLE_LOADER':'$(TEST_HOST)','CODE_SIGN_STYLE':'Automatic'})
        if scope == 'UITests':
            values.update({'PRODUCT_BUNDLE_IDENTIFIER':'com.jordan.family.ColoringSheetsUITests','PRODUCT_NAME':'$(TARGET_NAME)','GENERATE_INFOPLIST_FILE':'YES','TEST_TARGET_NAME':'ColoringSheets','CODE_SIGN_STYLE':'Automatic'})
        base = f'baseConfigurationReference = {local};' if scope == 'Project' else ''
        configs.append(obj(scope+config, f'{{isa = XCBuildConfiguration; {base} buildSettings = {settings(values)}; name = {config};}}'))
    obj(scope+'configs', f'{{isa = XCConfigurationList; buildConfigurations = {array(configs)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;}}')
proxy = obj('proxy', f'{{isa = PBXContainerItemProxy; containerPortal = {uid("project")}; proxyType = 1; remoteGlobalIDString = {uid("appTarget")}; remoteInfo = ColoringSheets;}}')
dep = obj('dependency', f'{{isa = PBXTargetDependency; target = {uid("appTarget")}; targetProxy = {proxy};}}')
obj('appTarget', f'{{isa = PBXNativeTarget; buildConfigurationList = {uid("Appconfigs")}; buildPhases = {array([uid("Appsources"),resources,script])}; buildRules = (); dependencies = (); name = ColoringSheets; productName = ColoringSheets; productReference = {app_product}; productType = "com.apple.product-type.application";}}')
obj('testTarget', f'{{isa = PBXNativeTarget; buildConfigurationList = {uid("Testsconfigs")}; buildPhases = {array([uid("Testssources")])}; buildRules = (); dependencies = {array([dep])}; name = ColoringSheetsTests; productName = ColoringSheetsTests; productReference = {test_product}; productType = "com.apple.product-type.bundle.unit-test";}}')
obj('uiTestTarget', f'{{isa = PBXNativeTarget; buildConfigurationList = {uid("UITestsconfigs")}; buildPhases = {array([uid("UITestssources")])}; buildRules = (); dependencies = {array([dep])}; name = ColoringSheetsUITests; productName = ColoringSheetsUITests; productReference = {ui_test_product}; productType = "com.apple.product-type.bundle.ui-testing";}}')
obj('project', f'{{isa = PBXProject; attributes = {{BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 2700;}}; buildConfigurationList = {uid("Projectconfigs")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en, Base); mainGroup = {main}; productRefGroup = {products}; projectDirPath = ""; projectRoot = ""; targets = {array([uid("appTarget"),uid("testTarget"),uid("uiTestTarget")])};}}')
(root/'ColoringSheets.xcodeproj/project.pbxproj').write_text('// !$*UTF8*$!\n{archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n'+'\n'.join(k+' = '+v+';' for k,v in objects.items())+'\n}; rootObject = '+uid('project')+';}\n')
ref=lambda target,name: f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid(target)}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:ColoringSheets.xcodeproj"/>'
(root/'ColoringSheets.xcodeproj/xcshareddata/xcschemes/ColoringSheets.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref('appTarget','ColoringSheets.app')}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref('testTarget','ColoringSheetsTests.xctest')}</TestableReference><TestableReference skipped="NO">{ref('uiTestTarget','ColoringSheetsUITests.xctest')}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref('appTarget','ColoringSheets.app')}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref('appTarget','ColoringSheets.app')}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
