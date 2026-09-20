import SwiftUI

@main
struct ColoringSheetsApp: App {
    @StateObject private var store: ColoringViewModel
    init() {
        ExportItem.cleanAbandonedExports()
        let config = AppConfiguration.load()
        var useMock = config.mock
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--mock") { useMock = true }
        #endif
        let service: any GenerationServing = useMock ? MockGenerator() : WorkerClient(credential: config.credential)
        _store = StateObject(wrappedValue: ColoringViewModel(service: service, isMock: useMock))
    }
    var body: some Scene { WindowGroup { ContentView(store: store) } }
}
