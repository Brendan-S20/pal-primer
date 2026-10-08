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

        // The buttons (2026-10-07). All optional, and all absent from a state
        // written before them: an update saved by an older server, or a
        // build-261 phone's own. Absent decodes as nil, and the card then
        // draws no button that needs it, exactly as it did before.

        /// The stop on the card, for the links back into My Day.
        public var visitId: String?
        /// Where Navigate sends the maps app: coordinates when the property
        /// has them...
        public var destLat: Double?
        public var destLng: Double?
        /// ...else "412 Elm St, Springfield, 62704".
        public var destAddress: String?
        /// "start" or "complete": which of My Day's buttons the stop needs.
        /// A string, not an enum, so a value a newer server invents is
        /// ignored rather than failing the whole decode.
        public var nextAction: String?
        /// "Navigate", in the tech's language.
        public var navigateLabel: String?
        /// "Start" or "Complete", in the tech's language.
        public var actionLabel: String?

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
            rtl: Bool,
            visitId: String? = nil,
            destLat: Double? = nil,
            destLng: Double? = nil,
            destAddress: String? = nil,
            nextAction: String? = nil,
            navigateLabel: String? = nil,
            actionLabel: String? = nil
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
            self.visitId = visitId
            self.destLat = destLat
            self.destLng = destLng
            self.destAddress = destAddress
            self.nextAction = nextAction
            self.navigateLabel = navigateLabel
            self.actionLabel = actionLabel
        }

        enum CodingKeys: String, CodingKey {
            case stopLabel, nextLabel, nextStop, window, doneLabel, skippedLabel
            case done, skipped, total, position, allDone, rtl
            case visitId, destLat, destLng, destAddress, nextAction, navigateLabel, actionLabel
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
            visitId = Self.nonEmpty(try? c.decodeIfPresent(String.self, forKey: .visitId))
            destLat = try? c.decodeIfPresent(Double.self, forKey: .destLat)
            destLng = try? c.decodeIfPresent(Double.self, forKey: .destLng)
            destAddress = Self.nonEmpty(try? c.decodeIfPresent(String.self, forKey: .destAddress))
            nextAction = Self.nonEmpty(try? c.decodeIfPresent(String.self, forKey: .nextAction))
            navigateLabel = Self.nonEmpty(try? c.decodeIfPresent(String.self, forKey: .navigateLabel))
            actionLabel = Self.nonEmpty(try? c.decodeIfPresent(String.self, forKey: .actionLabel))
        }

        private static func nonEmpty(_ s: String?) -> String? {
            guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
            return s
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

// MARK: - Where the card's buttons go

/// The links on the card. Built here, from the state's plain values, rather
/// than sent as URLs: the content state arrives from a server push, and the
/// only things it can make the lock screen open are the maps app and My Day.
/// Nothing in them is a session, a token, or a HoundStack API address.
@available(iOS 16.1, *)
public enum RouteLinks {
    /// Info.plist CFBundleURLSchemes; src/lib/live-activity-links.ts reads it.
    static let scheme = "consulting.thenorth.houndstack"
    /// The host src/lib/live-activity-links.ts accepts. `auth-callback` is
    /// the OAuth hand-back on the same scheme and is not this.
    static let host = "open"
    static let path = "/my-day"
    static let actions: Set<String> = ["start", "complete"]

    /// My Day, on the stop, and with `action` when a button asked for one:
    /// consulting.thenorth.houndstack://open/my-day?date=…&visit=…&action=start
    public static func myDay(routeDate: String, visitId: String?, action: String? = nil) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        c.host = host
        c.path = path
        var items: [URLQueryItem] = []
        if routeDate.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil {
            items.append(URLQueryItem(name: "date", value: routeDate))
        }
        if let visitId = visitId,
           visitId.range(of: #"^[0-9A-Fa-f-]{36}$"#, options: .regularExpression) != nil {
            items.append(URLQueryItem(name: "visit", value: visitId))
            if let action = action, actions.contains(action) {
                items.append(URLQueryItem(name: "action", value: action))
            }
        }
        c.queryItems = items.isEmpty ? nil : items
        return c.url
    }

    /// Turn-by-turn directions to the stop: the same Google Maps directions
    /// link My Day's Navigate button opens (src/routes/_authenticated/
    /// my-day.tsx mapsUrl), which iOS hands to the Google Maps app when it is
    /// installed and to Safari when it is not. Coordinates when there are
    /// any, which are exact; else the address string My Day uses.
    public static func directions(lat: Double?, lng: Double?, address: String?) -> URL? {
        let destination: String
        if let lat = lat, let lng = lng, lat.isFinite, lng.isFinite,
           abs(lat) <= 90, abs(lng) <= 180, !(lat == 0 && lng == 0) {
            destination = "\(lat),\(lng)"
        } else if let address = address?.trimmingCharacters(in: .whitespacesAndNewlines), !address.isEmpty {
            destination = address
        } else {
            return nil
        }
        var c = URLComponents(string: "https://www.google.com/maps/dir/")
        c?.queryItems = [
            URLQueryItem(name: "api", value: "1"),
            URLQueryItem(name: "destination", value: destination),
        ]
        return c?.url
    }

    /// The Navigate hand-off. A `Link` on a Live Activity does not open its
    /// URL itself: iOS gives every URL tapped on the card to THIS app, the
    /// Google Maps one included (measured on the simulator, 2026-10-07:
    /// SpringBoard "Sending open application request ... url =
    /// https://www.google.com/maps/dir/?api=1&destination=..." to
    /// consulting.thenorth.houndstack). So AppDelegate asks this whether an
    /// incoming URL is one of the card's directions links and, if it is,
    /// opens the maps link from the app, which iOS then sends on to Google
    /// Maps or Safari.
    ///
    /// Only a link of exactly the shape `directions` builds is recognised,
    /// and what is opened is rebuilt from its destination, not the URL as it
    /// arrived, so this cannot be used to open anything else.
    public static func directionsHandOff(_ url: URL) -> URL? {
        guard url.scheme == "https", url.host == "www.google.com", url.path == "/maps/dir",
              url.user == nil, url.password == nil, url.port == nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.first(where: { $0.name == "api" })?.value == "1",
              let destination = items.first(where: { $0.name == "destination" })?.value,
              !destination.isEmpty, destination.count <= 300 else { return nil }
        let parts = destination.split(separator: ",", omittingEmptySubsequences: false)
        if parts.count == 2, let lat = Double(parts[0]), let lng = Double(parts[1]) {
            return directions(lat: lat, lng: lng, address: nil)
        }
        return directions(lat: nil, lng: nil, address: destination)
    }
}

@available(iOS 16.1, *)
extension RouteActivityAttributes.ContentState {
    /// A tap anywhere on the card: My Day on the stop it names.
    public func cardURL(routeDate: String) -> URL? {
        RouteLinks.myDay(routeDate: routeDate, visitId: allDone ? nil : visitId)
    }

    /// Navigate, or nil when there is nowhere to go or nothing to call it.
    public var directionsURL: URL? {
        guard !allDone, navigateLabel != nil else { return nil }
        return RouteLinks.directions(lat: destLat, lng: destLng, address: destAddress)
    }

    /// Start or Complete: opens My Day on the stop with that button in hand.
    /// Never performs it.
    public func actionURL(routeDate: String) -> URL? {
        guard !allDone, let visitId = visitId, let action = nextAction,
              RouteLinks.actions.contains(action), actionLabel != nil else { return nil }
        return RouteLinks.myDay(routeDate: routeDate, visitId: visitId, action: action)
    }
}
#endif
