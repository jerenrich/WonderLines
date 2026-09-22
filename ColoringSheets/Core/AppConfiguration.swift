import Foundation

struct AppConfiguration: Decodable {
    let mock: Bool
    let serviceURL: URL
    static func load() -> Self {
        guard let url = Bundle.main.url(forResource: "ServiceConfiguration", withExtension: "plist"),
              let data = try? Data(contentsOf: url), let value = try? PropertyListDecoder().decode(Self.self, from: data) else {
            return Self(mock: false, serviceURL: WorkerClient.defaultServiceURL)
        }
        return value
    }
}
