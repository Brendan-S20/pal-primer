// The shape of a technician's route on the lock screen and the Dynamic Island.
//
// COMPILED INTO TWO TARGETS: the app (which starts, updates and ends the
// activity through RouteActivityPlugin) and the RouteActivity widget
// extension (which draws it). ActivityKit matches the two halves by the TYPE
// NAME, so this one file is a member of both targets rather than two copies
// that could drift apart.
//
// Every string here arrives already written in the technician's language.
// They are computed in JS (src/lib/live-activity-state.ts) with the same
// translations My Day uses, or on the server for a push
// (src/lib/push-liveactivity.server.ts) with the language the device saved
// beside its token. So the Swift side carries no localisation of its own and
// cannot say anything My Day does not.
//
// The decoder is forgiving on purpose. A remote update's `content-state` is
// JSON written by the server, and a field the server stops sending, or one a
// newer server adds, must not make iOS throw the whole update away. A missing
// value becomes an empty one; an unknown key is ignored.

import Foundation

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.1, *)
public struct RouteActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// "Stop 5 of 12".
        public var stopLabel: String
        /// What the line under it is: "Next stop", "In progress", "All stops done".
        public var nextLabel: String
        /// The property's label, or its street. Never the customer's name.
        public var nextStop: String?
        /// "10:40–11:00", or nil when the stop has no window.
        public var window: String?
        /// "4 done".
        public var doneLabel: String
        /// "1 skipped".
        public var skippedLabel: String
        public var done: Int
        public var skipped: Int
        public var total: Int
        /// The stop the tech is at or driving to, 1-based. Equals total + 1
        /// never; when every stop is finished it is `total` and allDone is set.
        public var position: Int
        public var allDone: Bool
        /// Arabic reads right to left; the views flip their layout for it.
        public var rtl: Bool

        public init(
            stopLabel: String,
            nextLabel: String,
            nextStop: String?,
            window: String?,
            doneLabel: String,
            skippedLabel: String,
            done: Int,
            skipped: Int,
            total: Int,
            position: Int,
            allDone: Bool,
            rtl: Bool
        ) {
            self.stopLabel = stopLabel
            self.nextLabel = nextLabel
            self.nextStop = nextStop
            self.window = window
            self.doneLabel = doneLabel
            self.skippedLabel = skippedLabel
            self.done = done
            self.skipped = skipped
            self.total = total
            self.position = position
            self.allDone = allDone
            self.rtl = rtl
        }

        enum CodingKeys: String, CodingKey {
            case stopLabel, nextLabel, nextStop, window, doneLabel, skippedLabel
            case done, skipped, total, position, allDone, rtl
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            stopLabel = (try? c.decode(String.self, forKey: .stopLabel)) ?? ""
            nextLabel = (try? c.decode(String.self, forKey: .nextLabel)) ?? ""
            nextStop = try? c.decodeIfPresent(String.self, forKey: .nextStop)
            window = try? c.decodeIfPresent(String.self, forKey: .window)
            doneLabel = (try? c.decode(String.self, forKey: .doneLabel)) ?? ""
            skippedLabel = (try? c.decode(String.self, forKey: .skippedLabel)) ?? ""
            done = (try? c.decode(Int.self, forKey: .done)) ?? 0
            skipped = (try? c.decode(Int.self, forKey: .skipped)) ?? 0
            total = (try? c.decode(Int.self, forKey: .total)) ?? 0
            position = (try? c.decode(Int.self, forKey: .position)) ?? 0
            allDone = (try? c.decode(Bool.self, forKey: .allDone)) ?? false
            rtl = (try? c.decode(Bool.self, forKey: .rtl)) ?? false
        }

        /// Finished stops over all stops, 0...1. Skipped counts as finished
        /// HERE, unlike My Day's percentage: the bar on the lock screen is
        /// "how far through the route am I", and a skipped stop is behind you.
        public var progress: Double {
            guard total > 0 else { return 0 }
            return min(1, Double(done + skipped) / Double(total))
        }
    }

    /// The org-local day the route is for, "2026-10-04". One activity per day:
    /// starting again for the same day updates the one already showing.
    public var routeDate: String
    /// "Today's route", in the tech's language. Fixed for the activity's life.
    public var title: String

    public init(routeDate: String, title: String) {
        self.routeDate = routeDate
        self.title = title
    }
}
#endif
