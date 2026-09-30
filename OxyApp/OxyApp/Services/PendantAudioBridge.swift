import Foundation
import Observation

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        Swift.withUnsafeBytes(of: value.littleEndian) { self.append(contentsOf: $0) }
    }
}
