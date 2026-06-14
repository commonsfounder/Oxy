import AVFoundation

extension AVAudioSession {
    func setActiveAsync(_ active: Bool, options: AVAudioSession.SetActiveOptions = []) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.setActive(active, options: options) { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }
}
