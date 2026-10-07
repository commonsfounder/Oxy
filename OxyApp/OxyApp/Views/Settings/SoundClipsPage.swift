import AVFoundation
import SwiftUI

/// The sounds behind recent alerts, so the household can say whether Adam heard right.
struct SoundClipsPage: View {
    @AppStorage(SoundClipStore.preferenceKey) private var keepClips = false
    @State private var store = SoundClipStore.shared
    @State private var player: AVAudioPlayer?
    @State private var playingId: String?
    @State private var exported: [URL] = []
    @State private var confirmsDeleteAll = false

    private var markedCount: Int { store.clips.filter { $0.verdict != nil }.count }

    var body: some View {
        SettingsPage(title: "Sounds heard") {
            SettingsList {
                SettingsToggleRow(
                    title: "Keep a clip with each alert",
                    subtitle: "Five seconds of sound, kept on this iPhone for 30 days",
                    isOn: $keepClips
                )
            }

            if store.clips.isEmpty {
                SettingsStatement(text: keepClips ? "Nothing heard yet." : "Switch this on to hear what set off an alert.", solid: false)
                    .padding(.horizontal, 4)
            } else {
                SettingsGroup(title: "Did Adam hear right?") {
                    SettingsList {
                        ForEach(Array(store.clips.enumerated()), id: \.element.id) { index, clip in
                            if index > 0 { SettingsRule() }
                            row(clip)
                        }
                    }
                }

                SettingsList {
                    if markedCount > 0 {
                        ShareLink(items: exported) {
                            SettingsRow(title: "Send marked clips", subtitle: "\(markedCount) marked") {
                                AppIcon("arrow-up-right", size: 13).foregroundStyle(Color.appMuted)
                            }
                        }
                        .buttonStyle(.plain)
                        SettingsRule()
                    }
                    Button {
                        confirmsDeleteAll = true
                    } label: {
                        Text("Delete all clips")
                            .font(.appBody(15, weight: .medium))
                            .foregroundStyle(Color.appDestructive)
                            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .confirmationDialog("Delete all clips?", isPresented: $confirmsDeleteAll, titleVisibility: .visible) {
            Button("Delete all", role: .destructive) {
                stopPlaying()
                store.deleteAll()
            }
        }
        .onAppear {
            HouseholdSoundMonitor.shared.pauseListening()
            exported = store.exportMarked()
        }
        .onDisappear {
            stopPlaying()
            HouseholdSoundMonitor.shared.resumeListening()
        }
        .onChange(of: store.clips) { _, _ in exported = store.exportMarked() }
    }

    private func row(_ clip: SoundClipStore.Clip) -> some View {
        HStack(spacing: 12) {
            Button {
                toggle(clip)
            } label: {
                AppIcon(playingId == clip.id ? "stop" : "play", size: 13)
                    .foregroundStyle(Color.appInk)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Color.settingsRaised))
                    .overlay(Circle().strokeBorder(Color.appCardOutline, lineWidth: 1))
            }
            .buttonStyle(.appScale)
            .accessibilityLabel(playingId == clip.id ? "Stop" : "Play \(clip.title)")

            VStack(alignment: .leading, spacing: 2) {
                Text(clip.title)
                    .font(.appBody(15, weight: .medium))
                    .foregroundStyle(Color.appInk)
                Text(clip.heardAt.formatted(.relative(presentation: .named)))
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
            }
            Spacer(minLength: 8)
            verdictButton(clip, .right, label: "Right")
            verdictButton(clip, .wrong, label: "Wrong")
        }
        .padding(.vertical, 10)
    }

    private func verdictButton(_ clip: SoundClipStore.Clip, _ verdict: SoundClipStore.Clip.Verdict, label: String) -> some View {
        let chosen = clip.verdict == verdict
        return Button {
            HapticManager.shared.select()
            store.mark(clip, verdict)
        } label: {
            Text(label)
                .font(.appBody(13, weight: chosen ? .semibold : .medium))
                .foregroundStyle(chosen ? Color.appOnAccent : Color.appMuted)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background(Capsule().fill(chosen ? Color.appAccent : Color.clear))
                .overlay(Capsule().strokeBorder(chosen ? Color.clear : Color.appCardOutline, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
    }

    private func toggle(_ clip: SoundClipStore.Clip) {
        if playingId == clip.id {
            stopPlaying()
            return
        }
        stopPlaying()
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        guard let next = try? AVAudioPlayer(contentsOf: store.url(for: clip)) else { return }
        next.play()
        player = next
        playingId = clip.id
        Task {
            try? await Task.sleep(for: .seconds(next.duration + 0.1))
            if playingId == clip.id, player === next { stopPlaying() }
        }
    }

    private func stopPlaying() {
        player?.stop()
        player = nil
        playingId = nil
    }
}
