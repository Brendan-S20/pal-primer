// DEBUG ONLY: a sample route on the lock screen, with no sign-in.
//
// The real activity starts from My Day, which needs a signed-in technician
// with visits today. That cannot be arranged on a simulator without a real
// account, so this puts up the same activity with fixture data, to look at
// the views and to try a remote update against its push token:
//
//   xcrun simctl launch booted consulting.thenorth.houndstack -liveActivityDemo
//   xcrun simctl launch booted consulting.thenorth.houndstack -liveActivityDemo -liveActivityDemoStep 12
//   xcrun simctl launch booted consulting.thenorth.houndstack -liveActivityDemo -liveActivityDemoLang ar
//
// And to prove the JS bridge reaches the plugin, without signing in:
//
//   xcrun simctl launch booted consulting.thenorth.houndstack -liveActivityBridgeCheck
//
// waits for the page, then calls RouteActivity.isSupported(), start() and
// update() FROM JS, the way src/lib/live-activity.ts does, and logs what came
// back. The activity it leaves up reads "Stop 6 of 12, 88 Birch Ave".
//
// The whole file is inside `#if DEBUG`, so a Release build (every Xcode
// Cloud archive) has no trace of it: no launch argument is read and no
// fixture string ships.

#if DEBUG
import Foundation
import WebKit
#if canImport(ActivityKit)
import ActivityKit
#endif

enum RouteActivityDemo {
    /// Called from HSBridgeViewController once the web view exists.
    static func checkBridgeIfAsked(_ webView: WKWebView?) {
        guard ProcessInfo.processInfo.arguments.contains("-liveActivityBridgeCheck"),
              let webView = webView else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
            let js = """
            const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.RouteActivity;
            if (!p) return "RouteActivity is not on window.Capacitor.Plugins";
            const r = await p.isSupported();
            const state = (n, street) => ({ stopLabel: "Stop " + n + " of 12", nextLabel: "Next stop",
              nextStop: street, window: "11:15 AM–11:35 AM", doneLabel: (n - 2) + " done", skippedLabel: "1 skipped",
              done: n - 2, skipped: 1, total: 12, position: n, allDone: false, rtl: false });
            const started = await p.start({ attributes: { routeDate: "2026-10-04", title: "Today's route" },
              state: state(5, "412 Elm St") });
            const updated = await p.update({ state: state(6, "88 Birch Ave") });
            return "available=" + window.Capacitor.isPluginAvailable("RouteActivity") +
              " isSupported=" + JSON.stringify(r) +
              " start=" + JSON.stringify({ id: started.id, reused: started.reused, pushToken: started.pushToken ? started.pushToken.length + " hex chars" : null }) +
              " update=" + JSON.stringify({ updated: updated.updated, sameId: updated.id === started.id });
            """
            webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value): NSLog("[RouteActivityDemo] bridge check: \(String(describing: value))")
                case .failure(let error): NSLog("[RouteActivityDemo] bridge check failed: \(error)")
                }
            }
        }
    }

    private static var started = false

    /// Called from applicationDidBecomeActive: ActivityKit refuses a request
    /// from an app that is not in the foreground yet.
    static func startIfAsked() {
        let args = ProcessInfo.processInfo.arguments
        guard !started, args.contains("-liveActivityDemo") else { return }
        started = true
        guard #available(iOS 16.2, *) else {
            NSLog("[RouteActivityDemo] needs iOS 16.2")
            return
        }
        let step = Int(value(after: "-liveActivityDemoStep", in: args) ?? "") ?? 5
        let lang = value(after: "-liveActivityDemoLang", in: args) ?? "en"
        let state = sample(step: step, lang: lang)
        let attrs = RouteActivityAttributes(
            routeDate: "2026-10-04",
            title: lang == "ar" ? "مسار اليوم" : lang == "es" ? "Ruta de hoy" : "Today's route"
        )
        Task { @MainActor in
            for old in Activity<RouteActivityAttributes>.activities {
                await old.end(nil, dismissalPolicy: .immediate)
            }
            do {
                let activity: Activity<RouteActivityAttributes>
                do {
                    activity = try Activity.request(
                        attributes: attrs,
                        content: ActivityContent(state: state, staleDate: nil),
                        pushType: .token
                    )
                } catch {
                    NSLog("[RouteActivityDemo] no push token (\(error.localizedDescription)); starting without one")
                    activity = try Activity.request(
                        attributes: attrs,
                        content: ActivityContent(state: state, staleDate: nil),
                        pushType: nil
                    )
                }
                NSLog("[RouteActivityDemo] started \(activity.id)")
                for await data in activity.pushTokenUpdates {
                    let hex = data.map { String(format: "%02x", $0) }.joined()
                    NSLog("[RouteActivityDemo] push token \(hex)")
                }
            } catch {
                NSLog("[RouteActivityDemo] failed: \(error.localizedDescription)")
            }
        }
    }

    private static func value(after flag: String, in args: [String]) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    @available(iOS 16.1, *)
    private static func sample(step: Int, lang: String) -> RouteActivityAttributes.ContentState {
        let total = 12
        let skipped = step > 3 ? 1 : 0
        let allDone = step > total
        let done = max(0, min(total, step - 1) - skipped)
        let position = min(step, total)
        if lang == "ar" {
            return .init(
                stopLabel: allDone ? "انتهت كل المحطات" : "المحطة \(position) من \(total)",
                nextLabel: allDone ? "انتهى اليوم" : "المحطة التالية",
                nextStop: allDone ? nil : "412 Elm St",
                window: allDone ? nil : "10:40 ص–11:00 ص",
                doneLabel: "\(done) منجزة",
                skippedLabel: "\(skipped) متخطاة",
                done: done, skipped: skipped, total: total, position: position,
                allDone: allDone, rtl: true
            )
        }
        return .init(
            stopLabel: allDone ? "All stops done" : "Stop \(position) of \(total)",
            nextLabel: allDone ? "Route finished" : "Next stop",
            nextStop: allDone ? nil : "412 Elm St",
            window: allDone ? nil : "10:40–11:00 AM",
            doneLabel: "\(done) done",
            skippedLabel: "\(skipped) skipped",
            done: done, skipped: skipped, total: total, position: position,
            allDone: allDone, rtl: false
        )
    }
}
#endif
