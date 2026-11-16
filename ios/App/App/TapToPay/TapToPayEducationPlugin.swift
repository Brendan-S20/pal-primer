// Apple's merchant education for Tap to Pay on iPhone, for the review guide's
// section 4 (how to tap, cards and wallets, PIN entry).
//
// A LOCAL plugin, like RouteActivityPlugin: the Stripe Terminal plugin does
// not expose ProximityReaderDiscovery, and one small file is less to keep
// alive than a fork. Registered by hand in
// HSBridgeViewController.capacitorDidLoad(). JS reaches it as
// `TapToPayEducation` through src/lib/tap-to-pay-education-native.ts.
//
//   isAvailable()  { available }  true on an iPhone on iOS 18 and later,
//                                 where ProximityReaderDiscovery exists.
//                                 Always false on an iPad (#726).
//   show()         { shown }      presents Apple's "how to tap" content over
//                                 the app. shown: false below iOS 18, where
//                                 the app's own screens are used instead.
//                                 Rejects on an iPad.
//
// ── WHY NOT ON AN iPAD ────────────────────────────────────────────────────
//
// Tap to Pay on iPhone is an iPhone feature: an iPad has no NFC reader for
// it, and Apple's merchant education describes a phone. The iOS 18 check
// alone would answer true on any iPad on iPadOS 18+ (Apple reviewed 1.0 on
// an iPad Air 11-inch (M4), #726), offering a guide to hardware it lacks.
// The idiom is checked first, before anything from ProximityReader is
// touched, so an iPad never reaches that framework through this plugin.

import Foundation
import UIKit
import Capacitor
#if canImport(ProximityReader)
import ProximityReader
#endif

@objc(TapToPayEducationPlugin)
public class TapToPayEducationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TapToPayEducationPlugin"
    public let jsName = "TapToPayEducation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
    ]

    /// Tap to Pay on iPhone does not exist on iPad (#726). Capacitor calls
    /// plugin methods off the main thread, and UIDevice is UIKit, so it is
    /// read on main (sync only from another thread, so it cannot deadlock).
    private static var isPad: Bool {
        if Thread.isMainThread {
            return UIDevice.current.userInterfaceIdiom == .pad
        }
        return DispatchQueue.main.sync { UIDevice.current.userInterfaceIdiom == .pad }
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        if TapToPayEducationPlugin.isPad {
            call.resolve(["available": false])
            return
        }
        #if canImport(ProximityReader)
        if #available(iOS 18.0, *) {
            call.resolve(["available": true])
            return
        }
        #endif
        call.resolve(["available": false])
    }

    @objc func show(_ call: CAPPluginCall) {
        if TapToPayEducationPlugin.isPad {
            call.reject("Tap to Pay on iPhone is not available on iPad")
            return
        }
        #if canImport(ProximityReader)
        if #available(iOS 18.0, *) {
            Task { @MainActor in
                guard let presenter = self.bridge?.viewController else {
                    call.reject("No view controller to present from")
                    return
                }
                do {
                    let discovery = ProximityReaderDiscovery()
                    let content = try await discovery.content(for: .payment(.howToTap))
                    try await discovery.presentContent(content, from: presenter)
                    call.resolve(["shown": true])
                } catch {
                    call.reject(error.localizedDescription)
                }
            }
            return
        }
        #endif
        call.resolve(["shown": false])
    }
}
