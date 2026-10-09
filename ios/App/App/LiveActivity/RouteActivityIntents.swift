// Start, pressed on the route's lock-screen card, starts the stop.
//
// COMPILED INTO TWO TARGETS, like RouteActivityAttributes.swift: the widget
// extension needs the intent TYPE to draw `Button(intent:)`, and the app is
// where it RUNS. A LiveActivityIntent's perform() is called by iOS in the
// app's process, launched in the background if it is not running, never in
// the extension; the extension's copy is compiled with ROUTE_ACTIVITY_
// EXTENSION set (project.pbxproj) and its perform() does nothing.
//
// What the app's perform() does:
//
//   1. reads the ACTION TOKEN the signed-in app put in the keychain when the
//      route went on the lock screen (RouteActivityPlugin.setActionToken;
//      src/lib/live-activity-action.ts says what it is good for, which is
//      starting a stop on this tech's route today and nothing else);
//   2. posts { visitId, action: "start" } with it to
//      /api/public/hooks/live-activity-action;
//   3. on 200, puts the content state the server sends back on the card at
//      once, so Start becomes Complete without waiting for a push.
//
// Anything else -- no token, a token for another day or past its expiry, no
// signal, a refusal -- and the button does what it did before it could act:
// it opens the app on the stop, with Start in hand (needsToContinueIn
// ForegroundError, which asks iOS to unlock and bring the app forward). It
// never fails silently, and it never holds or sends a Supabase session.
//
// The keychain item is this app's own (no App Group, no new entitlement), is
// readable after the first unlock so the button works on a locked phone, and
// never leaves this device (ThisDeviceOnly: not in a backup, not on a new
// phone).

import Foundation
#if canImport(ActivityKit) && canImport(AppIntents)
import ActivityKit
import AppIntents
import Security
#if !ROUTE_ACTIVITY_EXTENSION
import UIKit
import Capacitor
#endif

/// The action token, where the plugin leaves it and the intent finds it.
enum RouteActionStore {
    static let service = "consulting.thenorth.houndstack.route-action"
    static let account = "action-token"

    struct Held: Codable, Equatable {
        /// 43 base64url characters. Good for one tech, one day, Start only.
        let token: String
        /// The absolute URL the intent posts to.
        let endpoint: String
        /// The org-local day it was minted for, "2026-10-08".
        let routeDate: String
        /// Epoch milliseconds.
        let expiresAt: Double

        var isUsable: Bool {
            token.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
                && expiresAt > Date().timeIntervalSince1970 * 1000
                && RouteActionStore.endpointURL(endpoint) != nil
        }
    }

    /// Only https, or plain http to this machine on a Debug build (a dev
    /// server). Anything else is refused, so a bad value cannot send the
    /// token somewhere it should not go.
    static func endpointURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil else { return nil }
        if url.scheme == "https" { return url }
        #if DEBUG
        if url.scheme == "http", ["localhost", "127.0.0.1"].contains(host) { return url }
        #endif
        return nil
    }

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    @discardableResult
    static func save(_ held: Held) -> Bool {
        guard held.isUsable, let data = try? JSONEncoder().encode(held) else { return false }
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func load() -> Held? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Held.self, from: data)
    }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

@available(iOS 17.0, *)
struct StartStopIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Start stop"
    static var description = IntentDescription("Starts the stop shown on the route's lock-screen card.")
    /// A lock-screen button, not something to offer in Shortcuts or Siri.
    static var isDiscoverable: Bool = false

    @Parameter(title: "Visit")
    var visitId: String

    @Parameter(title: "Route day")
    var routeDate: String

    init() {}

    init(visitId: String, routeDate: String) {
        self.visitId = visitId
        self.routeDate = routeDate
    }

    func perform() async throws -> some IntentResult {
        #if ROUTE_ACTIVITY_EXTENSION
        // Never called here: iOS runs a LiveActivityIntent in the app.
        return .result()
        #else
        if let state = await RouteStartRequest.send(visitId: visitId, routeDate: routeDate) {
            for activity in Activity<RouteActivityAttributes>.activities
            where activity.attributes.routeDate == routeDate {
                await activity.update(ActivityContent(state: state, staleDate: nil))
            }
            return .result()
        }
        // Could not start it from here: open the app on the stop instead.
        let link = RouteLinks.myDay(routeDate: routeDate, visitId: visitId, action: "start")
        throw needsToContinueInForegroundError {
            if let link = link {
                // Through Capacitor, as if iOS had opened the link: the App
                // plugin keeps it until the page is listening.
                _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: link, options: [:])
            }
        }
        #endif
    }
}

#if !ROUTE_ACTIVITY_EXTENSION
@available(iOS 17.0, *)
extension StartStopIntent: ForegroundContinuableIntent {}

/// The one request the intent makes.
@available(iOS 17.0, *)
enum RouteStartRequest {
    struct Reply: Decodable {
        let ok: Bool
        let outcome: String?
        let state: RouteActivityAttributes.ContentState?
    }

    /// The card's next state when the stop started (or already had), nil for
    /// every reason it could not be started from the lock screen.
    static func send(visitId: String, routeDate: String) async -> RouteActivityAttributes.ContentState? {
        guard let held = RouteActionStore.load(), held.isUsable, held.routeDate == routeDate,
              visitId.range(of: #"^[0-9A-Fa-f-]{36}$"#, options: .regularExpression) != nil,
              let url = RouteActionStore.endpointURL(held.endpoint) else {
            NSLog("[RouteActivity] Start: no usable action token for \(routeDate)")
            return nil
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
        request.httpMethod = "POST"
        request.setValue("Bearer \(held.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["visitId": visitId, "action": "start"])
        let session = URLSession(configuration: .ephemeral)
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200, let reply = try? JSONDecoder().decode(Reply.self, from: data), reply.ok else {
                NSLog("[RouteActivity] Start: refused, HTTP \(status)")
                return nil
            }
            NSLog("[RouteActivity] Start: \(reply.outcome ?? "ok")")
            // A started stop with no state in the reply still started; the
            // push brings the card up to date.
            return reply.state ?? Activity<RouteActivityAttributes>.activities.first?.content.state
        } catch {
            NSLog("[RouteActivity] Start: \(error.localizedDescription)")
            return nil
        }
    }
}
#endif
#endif
