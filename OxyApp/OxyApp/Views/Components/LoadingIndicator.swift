import SwiftUI

struct LoadingIndicator: View {
    var label: String = "Loading..."
    var tint: Color = .oxyStone

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(tint)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Color.oxySub)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.oxyBg)
    }
}

#Preview {
    LoadingIndicator()
}
