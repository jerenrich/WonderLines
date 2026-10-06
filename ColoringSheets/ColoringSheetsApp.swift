import SwiftUI

@main
struct ColoringSheetsApp: App {
    @StateObject private var store: ColoringViewModel
    init() {
        ExportItem.cleanAbandonedExports()
        let config = AppConfiguration.load()
        var useMock = config.mock
        var mockDelay: Duration = .zero
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--mock") { useMock = true }
        if ProcessInfo.processInfo.arguments.contains("--slow-mock") { mockDelay = .seconds(15) }
        #endif
        let service: any GenerationServing = useMock ? MockGenerator(delay: mockDelay) : WorkerClient(serviceURL: config.serviceURL)
        _store = StateObject(wrappedValue: ColoringViewModel(service: service, isMock: useMock))
    }
    var body: some Scene { WindowGroup { ContentView(store: store) } }
}
