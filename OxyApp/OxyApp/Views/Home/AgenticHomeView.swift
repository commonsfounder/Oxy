import SwiftUI
import CoreLocation

// MARK: - Home

// MARK: - Chat launch

/// `fullScreenCover(item:)` needs an Identifiable, and a bare workflow id string is not one.
private struct OpenWorkflow: Identifiable, Equatable {
    let id: String
}

// MARK: - Mission cards

// MARK: - Briefing mission card (secondary under concept cards)

struct MissionGlassPlate: View {
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous)
        Color.appSurface
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.appHairline, lineWidth: 0.7))
            .shadow(color: Color.appInk.opacity(0.035), radius: 10, y: 4)
    }
}

