// The bridge between My Day and ActivityKit.
//
// A LOCAL plugin: it lives in the app target, not in node_modules, because
// no Capacitor 8 Live Activity plugin is a dependency of this project and one
// small file is less to keep alive than a package. Capacitor only discovers
// plugins on its own when they are Swift packages listed in CapApp-SPM, which
// `npx cap sync` rewrites, so this one is registered by hand in
// HSBridgeViewController.capacitorDidLoad(), the documented way for a plugin
// that ships inside the app. JS reaches it as `RouteActivity` through
// registerPlugin in src/lib/live-activity.ts.
//
// Four methods, matching the JS wrapper:
//
//   isSupported()           { supported, enabled }. Supported is iOS 16.2+;
//                           enabled is the person's own switch in Settings ›
//                           HoundStack › Live Activities.
//   start({attributes, state})
//                           { id, pushToken?, reused }. ONE activity per route
//                           day: starting again for the same day updates the
//                           one already showing instead of stacking a second,
//                           and an activity left over from another day is
//                           ended first. pushToken is the first token ActivityKit
//                           hands out, if it arrives within a few seconds; any
//                           later or rotated token comes as a `pushToken` event.
//   update({state})         { updated, id?, pushToken? }. A no-op, not an
//                           error, when nothing is showing, so My Day can call
//                           it on every change without asking first.
//   end({state?, dismissalPolicy, dismissAt?})
//                           { ended, ids }. "immediate", "default" (iOS keeps
//                           it up to four hours), or "after" with dismissAt in
//                           epoch ms. Ends every route activity, and says
//                           which, so the server can stop pushing to them.
//
// Two events: `pushToken` {id, token, routeDate} and `ended` {id, routeDate}
// when the person swipes it away or iOS ends it, so the server stops pushing
// to a token nothing is listening on.

import Foundation
import Capacitor
#if canImport(ActivityKit)
import ActivityKit
#endif

@objc(RouteActivityPlugin)
public class RouteActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RouteActivityPlugin"
    public let jsName = "RouteActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    /// The latest push token per activity id, as hex. Main actor only.
    private var tokens: [String: String] = [:]
    /// Activities whose token and state streams are already being followed.
    private var observed: Set<String> = []

    override public func load() {
        // After a relaunch the activity is still on the lock screen but its
        // streams are not being read by anyone: pick them back up, so a token
        // Apple rotates overnight still reaches the server.
        if #available(iOS 16.2, *) {
            Task { @MainActor [weak self] in
                for activity in Activity<RouteActivityAttributes>.activities {
                    self?.observe(activity)
                }
            }
        }
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        if #available(iOS 16.2, *) {
            call.resolve([
                "supported": true,
                "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
            ])
        } else {
            call.resolve(["supported": false, "enabled": false])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities need iOS 16.2 or later", "UNSUPPORTED")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities are switched off for HoundStack in Settings", "DISABLED")
            return
        }
        guard let attributes = call.getObject("attributes"),
              let routeDate = attributes["routeDate"] as? String,
              let title = attributes["title"] as? String else {
            call.reject("start needs attributes.routeDate and attributes.title", "BAD_INPUT")
            return
        }
        guard let state = Self.decodeState(call.options["state"]) else {
            call.reject("start needs a content state", "BAD_INPUT")
            return
        }
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            let content = ActivityContent(state: state, staleDate: nil)
            for other in Activity<RouteActivityAttributes>.activities
            where other.attributes.routeDate != routeDate {
                await other.end(nil, dismissalPolicy: .immediate)
            }
            if let existing = Activity<RouteActivityAttributes>.activities.first(where: {
                $0.attributes.routeDate == routeDate && $0.activityState == .active
            }) {
                await existing.update(content)
                self.observe(existing)
                let token = await self.firstToken(for: existing.id)
                call.resolve(Self.result(existing.id, token: token, extra: ["reused": true]))
                return
            }
            let attrs = RouteActivityAttributes(routeDate: routeDate, title: title)
            do {
                let activity = try Activity.request(attributes: attrs, content: content, pushType: .token)
                self.observe(activity)
                let token = await self.firstToken(for: activity.id)
                call.resolve(Self.result(activity.id, token: token, extra: ["reused": false]))
            } catch {
                // A build without the push entitlement (a simulator run with
                // signing off) cannot have a push token, but it can still show
                // the activity and update it locally. Say why there is no token.
                do {
                    let activity = try Activity.request(attributes: attrs, content: content, pushType: nil)
                    self.observe(activity)
                    call.resolve(Self.result(activity.id, token: nil, extra: [
                        "reused": false,
                        "pushError": error.localizedDescription,
                    ]))
                } catch {
                    call.reject(error.localizedDescription, "REQUEST_FAILED")
                }
            }
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["updated": false])
            return
        }
        guard let state = Self.decodeState(call.options["state"]) else {
            call.reject("update needs a content state", "BAD_INPUT")
            return
        }
        Task { @MainActor [weak self] in
            let live = Activity<RouteActivityAttributes>.activities.filter { $0.activityState == .active }
            guard let first = live.first else {
                call.resolve(["updated": false])
                return
            }
            for activity in live {
                await activity.update(ActivityContent(state: state, staleDate: nil))
                self?.observe(activity)
            }
            call.resolve(Self.result(first.id, token: self?.tokens[first.id], extra: ["updated": true]))
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["ended": 0, "ids": [String]()])
            return
        }
        let state = Self.decodeState(call.options["state"])
        let policy: ActivityUIDismissalPolicy
        switch call.getString("dismissalPolicy") ?? "default" {
        case "immediate":
            policy = .immediate
        case "after":
            let ms = call.getDouble("dismissAt") ?? (Date().timeIntervalSince1970 * 1000)
            policy = .after(Date(timeIntervalSince1970: ms / 1000))
        default:
            policy = .default
        }
        Task { @MainActor [weak self] in
            let all = Activity<RouteActivityAttributes>.activities
            for activity in all {
                let content = state.map { ActivityContent(state: $0, staleDate: nil) }
                await activity.end(content, dismissalPolicy: policy)
                self?.tokens.removeValue(forKey: activity.id)
            }
            call.resolve(["ended": all.count, "ids": all.map { $0.id }])
        }
    }

    // MARK: - Streams

    @available(iOS 16.2, *)
    @MainActor
    private func observe(_ activity: Activity<RouteActivityAttributes>) {
        guard !observed.contains(activity.id) else { return }
        observed.insert(activity.id)
        let id = activity.id
        let routeDate = activity.attributes.routeDate
        Task { @MainActor [weak self] in
            for await data in activity.pushTokenUpdates {
                let hex = data.map { String(format: "%02x", $0) }.joined()
                self?.tokens[id] = hex
                self?.notifyListeners("pushToken", data: ["id": id, "token": hex, "routeDate": routeDate])
            }
        }
        Task { @MainActor [weak self] in
            for await state in activity.activityStateUpdates {
                if state == .dismissed || state == .ended {
                    self?.tokens.removeValue(forKey: id)
                    self?.observed.remove(id)
                    self?.notifyListeners("ended", data: ["id": id, "routeDate": routeDate])
                    break
                }
            }
        }
    }

    /// The first token, if ActivityKit hands one out within four seconds. It
    /// usually does in well under one; a slow one still arrives as an event.
    @MainActor
    private func firstToken(for id: String) async -> String? {
        for _ in 0..<40 {
            if let token = tokens[id] { return token }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return tokens[id]
    }

    // MARK: - Helpers

    private static func result(_ id: String, token: String?, extra: [String: Any]) -> [String: Any] {
        var out: [String: Any] = ["id": id]
        if let token = token { out["pushToken"] = token }
        for (k, v) in extra { out[k] = v }
        return out
    }

    @available(iOS 16.1, *)
    static func decodeState(_ raw: Any?) -> RouteActivityAttributes.ContentState? {
        guard let raw = raw, JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode(RouteActivityAttributes.ContentState.self, from: data)
    }
}
