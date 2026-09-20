import Foundation

struct AppConfiguration: Decodable {
    let credential: String
    let mock: Bool
    static func load() -> Self {
        guard let url = Bundle.main.url(forResource: "ServiceConfiguration", withExtension: "plist"),
              let data = try? Data(contentsOf: url), let value = try? PropertyListDecoder().decode(Self.self, from: data) else {
            return Self(credential: "", mock: false)
        }
        return value
    }
}
