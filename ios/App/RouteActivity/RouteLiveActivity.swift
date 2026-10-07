// What the technician sees without unlocking: where the route stands, where
// to go next, and when they are expected there.
//
// Branded with the app icon's two colours, the navy of the H and the cream
// behind it (#fdfaf1, the splash and PWA background in capacitor.config.ts
// and vite.config.ts), and a paw for a glyph. Every word is computed in the
// app in the tech's language (RouteActivityAttributes.swift says why); the
// views only lay out what they are given, and flip for Arabic.

import ActivityKit
import SwiftUI
import WidgetKit

private enum Brand {
    /// The H in the app icon.
    static let navy = Color(red: 21 / 255, green: 41 / 255, blue: 58 / 255)
    /// The icon's background, the splash screen and the PWA theme.
    static let cream = Color(red: 253 / 255, green: 250 / 255, blue: 241 / 255)
    static let glyph = "pawprint.fill"
}

struct RouteLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RouteActivityAttributes.self) { context in
            LockScreenView(title: context.attributes.title, state: context.state)
                .environment(\.layoutDirection, context.state.rtl ? .rightToLeft : .leftToRight)
                .activityBackgroundTint(Brand.navy)
                .activitySystemActionForegroundColor(Brand.cream)
        } dynamicIsland: { context in
            let s = context.state
            let dir: LayoutDirection = s.rtl ? .rightToLeft : .leftToRight
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Image(systemName: Brand.glyph)
                            .foregroundColor(Brand.cream)
                        Text(fraction(s))
                            .font(.headline)
                            .monospacedDigit()
                            .foregroundColor(Brand.cream)
                    }
                    .environment(\.layoutDirection, dir)
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let window = s.window, !s.allDone {
                        Text(window)
                            .font(.subheadline)
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .foregroundColor(Brand.cream)
                            .padding(.trailing, 4)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(s.nextLabel)
                            .font(.caption)
                            .foregroundColor(Brand.cream.opacity(0.75))
                            .lineLimit(1)
                        Text(s.nextStop ?? s.stopLabel)
                            .font(.headline)
                            .foregroundColor(Brand.cream)
                            .lineLimit(1)
                    }
                    .environment(\.layoutDirection, dir)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        ProgressView(value: s.progress)
                            .tint(Brand.cream)
                        Counts(state: s, compact: true)
                    }
                    .environment(\.layoutDirection, dir)
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: Brand.glyph)
                    .foregroundColor(Brand.cream)
            } compactTrailing: {
                Text(fraction(s))
                    .monospacedDigit()
                    .foregroundColor(Brand.cream)
            } minimal: {
                ProgressRing(progress: s.progress)
            }
            .keylineTint(Brand.cream)
        }
    }
}

/// "5/12", or a tick when the route is finished. Digits only, so it needs no
/// translation and reads the same in every language.
private func fraction(_ s: RouteActivityAttributes.ContentState) -> String {
    s.allDone ? "\(s.total)/\(s.total)" : "\(s.position)/\(s.total)"
}

private struct LockScreenView: View {
    let title: String
    let state: RouteActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle().fill(Brand.cream)
                    Image(systemName: state.allDone ? "checkmark" : Brand.glyph)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(Brand.navy)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(state.stopLabel)
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(Brand.cream)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if let window = state.window, !state.allDone {
                            Text(window)
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                                .foregroundColor(Brand.cream)
                                .lineLimit(1)
                                .layoutPriority(1)
                        }
                    }
                    Text(state.nextLabel)
                        .font(.caption)
                        .foregroundColor(Brand.cream.opacity(0.75))
                        .lineLimit(1)
                    Text(state.nextStop ?? title)
                        .font(.title3.weight(.bold))
                        .foregroundColor(Brand.cream)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }

            ProgressView(value: state.progress)
                .tint(Brand.cream)

            Counts(state: state, compact: false)
        }
        .padding(16)
    }
}

private struct Counts: View {
    let state: RouteActivityAttributes.ContentState
    let compact: Bool

    var body: some View {
        HStack(spacing: 14) {
            Label {
                Text(state.doneLabel).lineLimit(1)
            } icon: {
                Image(systemName: "checkmark.circle.fill")
            }
            Label {
                Text(state.skippedLabel).lineLimit(1)
            } icon: {
                Image(systemName: "arrow.uturn.right.circle.fill")
            }
            .opacity(state.skipped > 0 ? 1 : 0.6)
            Spacer(minLength: 0)
        }
        .font(compact ? .caption2 : .caption)
        .foregroundColor(Brand.cream.opacity(0.9))
    }
}

/// The minimal presentation, when another app's activity shares the island:
/// how far through the route, as a ring around the paw.
private struct ProgressRing: View {
    let progress: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(Brand.cream.opacity(0.25), lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(Brand.cream, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: Brand.glyph)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(Brand.cream)
        }
    }
}
