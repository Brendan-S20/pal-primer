// What the technician sees without unlocking: where the route stands, where
// to go next, and when they are expected there.
//
// Branded with the app icon's two colours, the navy of the H and the cream
// behind it (#fdfaf1, the splash and PWA background in capacitor.config.ts
// and vite.config.ts), and a paw for a glyph. Every word is computed in the
// app in the tech's language (RouteActivityAttributes.swift says why); the
// views only lay out what they are given, and flip for Arabic.
//
// Buttons, on iOS 17 and later, on the lock screen and in the expanded
// Dynamic Island: Navigate, and Start or Complete for the stop on the card.
//
//   Navigate is a plain `Link` to the maps app: iOS gives a link tapped on a
//   Live Activity to the app that owns it, whatever its URL, so AppDelegate
//   passes the directions link on (RouteLinks.directionsHandOff).
//
//   Start STARTS the stop, from the lock screen, without opening the app
//   (2026-10-08): a `Button(intent:)` running StartStopIntent
//   (ios/App/App/LiveActivity/RouteActivityIntents.swift), which iOS runs in
//   the app's process with the action token the app keeps in its keychain.
//   Nothing runs in this extension. When it cannot (no token, no signal), the
//   intent opens My Day on the stop with Start in hand, as the link did.
//
//   Complete is a `Link`: it opens My Day on the stop and straight into its
//   completion photo when the visit needs one (src/lib/live-activity-links
//   .ts). A completion is never made from a pocket.
//
// A tap anywhere else on the card opens My Day on the stop (`widgetURL`), on
// 16.2 too. On 16.2 to 16.x the card is drawn exactly as before, without the
// buttons.
//
// On iOS 18 and later the same activity also shows on a paired Apple Watch's
// Smart Stack (watchOS 11) and, on iOS 26, a CarPlay Dashboard, through the
// small supplemental family (#454). There is no watch app and no CarPlay app:
// iOS draws `SmallRouteView` there from the same content state. It has no
// buttons -- nothing is started or completed from a wrist or a dashboard --
// and a tap opens My Day on the phone at the stop, through the card's
// `widgetURL`, which carries no action. It names the stop by its street with
// no house number (`shortStop`), never the property's label or the customer.
// The lock screen and the Dynamic Island are drawn exactly as before.

import ActivityKit
import AppIntents
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
            ActivityContentView(
                title: context.attributes.title,
                routeDate: context.attributes.routeDate,
                state: context.state
            )
                .environment(\.layoutDirection, context.state.rtl ? .rightToLeft : .leftToRight)
                .activityBackgroundTint(Brand.navy)
                .activitySystemActionForegroundColor(Brand.cream)
                .widgetURL(context.state.cardURL(routeDate: context.attributes.routeDate))
        } dynamicIsland: { context in
            let s = context.state
            let routeDate = context.attributes.routeDate
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
                        if showsButtons(s, routeDate: routeDate) {
                            // Counts beside the bar rather than under it, to
                            // leave the buttons their 44pt.
                            HStack(spacing: 10) {
                                ProgressView(value: s.progress)
                                    .tint(Brand.cream)
                                Counts(state: s, compact: true, fill: false)
                                    .fixedSize()
                            }
                            ActionButtons(routeDate: routeDate, state: s)
                        } else {
                            ProgressView(value: s.progress)
                                .tint(Brand.cream)
                            Counts(state: s, compact: true)
                        }
                    }
                    .environment(\.layoutDirection, dir)
                    // Wider with the buttons: the island's corners curve in
                    // at the bottom, and at 4 the trailing button's corner
                    // met the curve (simulator, 2026-10-07).
                    .padding(.horizontal, showsButtons(s, routeDate: routeDate) ? 10 : 4)
                    .padding(.bottom, showsButtons(s, routeDate: routeDate) ? 4 : 0)
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
            .widgetURL(s.cardURL(routeDate: routeDate))
        }
        .smallSupplementalFamilyIfAvailable()
    }
}

extension WidgetConfiguration {
    /// The Apple Watch Smart Stack and the CarPlay Dashboard (#454): iOS 18
    /// and later. On 16.2 to 17.x the configuration is returned unchanged,
    /// so those phones draw exactly what they drew before. (An `if
    /// #available` returning two types is allowed here by SE-0360.)
    func smallSupplementalFamilyIfAvailable() -> some WidgetConfiguration {
        if #available(iOS 18.0, *) {
            return supplementalActivityFamilies([.small])
        } else {
            return self
        }
    }
}

/// The lock screen everywhere it was before; the small view where iOS asks
/// for the small family (the Smart Stack, CarPlay). `activityFamily` exists
/// only on iOS 18, so the switch is behind its own availability.
private struct ActivityContentView: View {
    let title: String
    let routeDate: String
    let state: RouteActivityAttributes.ContentState

    var body: some View {
        if #available(iOS 18.0, *) {
            FamilySwitch(title: title, routeDate: routeDate, state: state)
        } else {
            LockScreenView(title: title, routeDate: routeDate, state: state)
        }
    }
}

@available(iOS 18.0, *)
private struct FamilySwitch: View {
    @Environment(\.activityFamily) private var family
    let title: String
    let routeDate: String
    let state: RouteActivityAttributes.ContentState

    var body: some View {
        switch family {
        case .small:
            SmallRouteView(state: state)
        default:
            LockScreenView(title: title, routeDate: routeDate, state: state)
        }
    }
}

/// "5/12", or a tick when the route is finished. Digits only, so it needs no
/// translation and reads the same in every language.
private func fraction(_ s: RouteActivityAttributes.ContentState) -> String {
    s.allDone ? "\(s.total)/\(s.total)" : "\(s.position)/\(s.total)"
}

/// Whether to draw the buttons: iOS 17 or later, a route not finished, and
/// at least one button with somewhere to go and a label to say so. A state
/// from before the buttons existed has neither, and draws none.
private func showsButtons(_ s: RouteActivityAttributes.ContentState, routeDate: String) -> Bool {
    guard #available(iOS 17.0, *) else { return false }
    return !s.allDone && (s.directionsURL != nil || s.actionURL(routeDate: routeDate) != nil)
}

private struct LockScreenView: View {
    let title: String
    let routeDate: String
    let state: RouteActivityAttributes.ContentState

    var body: some View {
        let buttons = showsButtons(state, routeDate: routeDate)
        // A Live Activity is at most 160pt tall on the lock screen. The
        // buttons take 44 of it, so with them the counts move up beside the
        // bar and the padding tightens, and nothing is cut off.
        VStack(alignment: .leading, spacing: buttons ? 8 : 10) {
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

            if buttons {
                HStack(spacing: 10) {
                    ProgressView(value: state.progress)
                        .tint(Brand.cream)
                    Counts(state: state, compact: true, fill: false)
                        .fixedSize()
                }
                ActionButtons(routeDate: routeDate, state: state)
            } else {
                ProgressView(value: state.progress)
                    .tint(Brand.cream)

                Counts(state: state, compact: false)
            }
        }
        .padding(buttons ? 14 : 16)
    }
}

/// The Smart Stack on an Apple Watch and the CarPlay Dashboard (#454):
/// "Stop 2 of 7", the street, the window, and a bar. No buttons and no
/// links: the only thing a tap does is the card's `widgetURL`, My Day on the
/// stop, with no action in it. Nothing here starts or completes a visit.
///
/// The street is `shortStop`, "Elm St", never `nextStop`: `nextStop` is the
/// office's label for the property when it has one, and a label is often
/// the customer's name.
struct SmallRouteView: View {
    let state: RouteActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: state.allDone ? "checkmark.circle.fill" : Brand.glyph)
                    .font(.caption.weight(.semibold))
                Text(state.stopLabel)
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            if !state.allDone {
                if let street = state.shortStop {
                    Text(street)
                        .font(.headline)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                if let window = state.window {
                    Text(window)
                        .font(.caption)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .opacity(0.85)
                }
            }
            ProgressView(value: state.progress)
                .tint(Brand.cream)
        }
        .foregroundColor(Brand.cream)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }
}

/// Navigate, then Start or Complete, side by side, each at least 44pt tall
/// and sharing the width. Navigate is the filled one: on the road it is the
/// one a tech wants. In Arabic the row flips with the rest of the card.
private struct ActionButtons: View {
    let routeDate: String
    let state: RouteActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 8) {
            if let url = state.directionsURL, let label = state.navigateLabel {
                Link(destination: url) {
                    ActionLabel(
                        text: label,
                        systemImage: "arrow.triangle.turn.up.right.diamond.fill",
                        filled: true
                    )
                }
            }
            if let url = state.actionURL(routeDate: routeDate), let label = state.actionLabel {
                if #available(iOS 17.0, *) {
                    StopActionButton(routeDate: routeDate, state: state, url: url, label: label)
                } else {
                    Link(destination: url) {
                        ActionLabel(text: label, systemImage: "play.circle.fill", filled: false)
                    }
                }
            }
        }
    }
}

/// Start runs where it is pressed; Complete opens the app. Both look alike.
@available(iOS 17.0, *)
private struct StopActionButton: View {
    let routeDate: String
    let state: RouteActivityAttributes.ContentState
    let url: URL
    let label: String

    var body: some View {
        if state.nextAction == "start", let visitId = state.visitId {
            Button(intent: StartStopIntent(visitId: visitId, routeDate: routeDate)) {
                ActionLabel(text: label, systemImage: "play.circle.fill", filled: false)
            }
            .buttonStyle(.plain)
        } else {
            Link(destination: url) {
                ActionLabel(
                    text: label,
                    systemImage: state.nextAction == "complete" ? "checkmark.circle.fill" : "play.circle.fill",
                    filled: false
                )
            }
        }
    }
}

private struct ActionLabel: View {
    let text: String
    let systemImage: String
    let filled: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
            Text(text)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .foregroundColor(filled ? Brand.navy : Brand.cream)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(filled ? Brand.cream : Brand.cream.opacity(0.16))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Brand.cream.opacity(filled ? 0 : 0.45), lineWidth: 1)
        )
        .contentShape(Rectangle())
    }
}

private struct Counts: View {
    let state: RouteActivityAttributes.ContentState
    let compact: Bool
    /// Push to the leading edge across the full width. Off when the counts
    /// sit beside the progress bar.
    var fill: Bool = true

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
            if fill { Spacer(minLength: 0) }
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

#if DEBUG
/// Xcode previews of the small family (#454): stop 2 of 7 in English, the
/// same stop in Arabic, a stop with no street, and a finished route, at about
/// the size of an Apple Watch Smart Stack tile.
struct SmallRouteView_Previews: PreviewProvider {
    private static func state(
        position: Int, shortStop: String?, window: String?, allDone: Bool = false, rtl: Bool = false
    ) -> RouteActivityAttributes.ContentState {
        .init(
            stopLabel: allDone ? "All stops done" : (rtl ? "المحطة \(position) من 7" : "Stop \(position) of 7"),
            nextLabel: allDone ? "Route finished" : "Next stop",
            nextStop: allDone ? nil : "Smith residence",
            window: window,
            doneLabel: "\(position - 1) done",
            skippedLabel: "0 skipped",
            done: allDone ? 7 : position - 1,
            skipped: 0,
            total: 7,
            position: position,
            allDone: allDone,
            rtl: rtl,
            shortStop: shortStop
        )
    }

    static var previews: some View {
        Group {
            SmallRouteView(state: state(position: 2, shortStop: "Elm St", window: "10:40–11:00 AM"))
                .previewDisplayName("Small, stop 2 of 7")
            SmallRouteView(state: state(position: 2, shortStop: "Elm St", window: "10:40 ص–11:00 ص", rtl: true))
                .environment(\.layoutDirection, .rightToLeft)
                .previewDisplayName("Small, Arabic")
            SmallRouteView(state: state(position: 4, shortStop: nil, window: nil))
                .previewDisplayName("Small, no street or window")
            SmallRouteView(state: state(position: 7, shortStop: nil, window: nil, allDone: true))
                .previewDisplayName("Small, finished")
        }
        .frame(width: 170, height: 76)
        .background(Brand.navy)
        .previewLayout(.sizeThatFits)
    }
}
#endif
