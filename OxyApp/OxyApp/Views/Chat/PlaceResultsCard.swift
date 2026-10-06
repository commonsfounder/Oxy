import MapKit
import SwiftUI

/// The places a search found, on one map with a card for each: the facts that make them comparable, one tap to open.
struct PlaceResultsCard: View {
    let action: ActionResult

    @State private var selectedID: String?
    @State private var camera: MapCameraPosition = .automatic
    @State private var comparing = false

    private var places: [PlaceOption] { action.places ?? [] }
    private var chosenID: String? { selectedID ?? places.first?.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(places.count == 1 ? "1 place" : "\(places.count) places")
                    .font(.sectionLabel)
                    .foregroundStyle(Color.appMuted)
                Spacer(minLength: 8)
                if places.count >= 2 {
                    Button {
                        HapticManager.shared.impact(.light)
                        comparing = true
                    } label: {
                        Text("Compare")
                            .font(.appBody(14, weight: .medium))
                            .foregroundStyle(Color.appAccent)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 4)

            VStack(spacing: 0) {
                Map(position: $camera, selection: $selectedID) {
                    ForEach(places) { place in
                        Marker(place.name, coordinate: CLLocationCoordinate2D(latitude: place.lat, longitude: place.lng))
                            .tint(place.id == chosenID ? Color.appAccent : Color.appMuted)
                            .tag(place.id)
                    }
                }
                .mapStyle(.standard(pointsOfInterest: .excludingAll))
                .frame(height: 190)
                .allowsHitTesting(true)

                carousel
                    .padding(.vertical, 12)
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .settingsSurface()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Places found")
        .sheet(isPresented: $comparing) {
            CompareSheet(table: .places(places))
                .presentationDragIndicator(.visible)
        }
    }

    private var carousel: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 10) {
                ForEach(places) { place in
                    card(place)
                        .id(place.id)
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, 12)
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollPosition(id: $selectedID)
    }

    private func card(_ place: PlaceOption) -> some View {
        let isChosen = place.id == chosenID
        return VStack(alignment: .leading, spacing: 6) {
            Text(place.name)
                .font(.rowTitle)
                .foregroundStyle(Color.appInk)
                .lineLimit(1)
            if !place.facts.isEmpty {
                Text(place.facts)
                    .font(.rowSecondary)
                    .foregroundStyle(Color.appMuted)
                    .lineLimit(1)
            }
            Text(place.address)
                .font(.fineprint)
                .foregroundStyle(Color.appMuted)
                .lineLimit(1)
            Button {
                guard let link = place.link, let url = URL(string: link) else { return }
                HapticManager.shared.impact(.light)
                UIApplication.shared.open(url)
            } label: {
                Text("Open in Maps")
                    .font(.appBody(14, weight: .medium))
                    .foregroundStyle(Color.appOnAction)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .background(Capsule().fill(Color.appAction))
            }
            .buttonStyle(.appScale(0.97))
            .disabled(place.link == nil)
        }
        .padding(14)
        .frame(width: 252, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.appBackground.opacity(0.55)))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(isChosen ? Color.appAccent.opacity(0.7) : Color.appHairline, lineWidth: isChosen ? 1.2 : 0.7)
        )
        .accessibilityElement(children: .combine)
    }
}
