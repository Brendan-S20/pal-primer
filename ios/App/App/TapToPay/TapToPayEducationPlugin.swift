// Apple's merchant education for Tap to Pay on iPhone, for the review guide's
// section 4 (how to tap, cards and wallets, PIN entry).
//
// A LOCAL plugin, like RouteActivityPlugin: the Stripe Terminal plugin does
// not expose ProximityReaderDiscovery, and one small file is less to keep
// alive than a fork. Registered by hand in
// HSBridgeViewController.capacitorDidLoad(). JS reaches it as
// `TapToPayEducation` through src/lib/tap-to-pay-education-native.ts.
//
//   isAvailable()  { available }  true on iOS 18 and later, where
//                                 ProximityReaderDiscovery exists.
//   show()         { shown }      presents Apple's "how to tap" content over
//                                 the app. shown: false below iOS 18, where
//                                 the app's own screens are used instead.

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

    @objc func isAvailable(_ call: CAPPluginCall) {
        #if canImport(ProximityReader)
        if #available(iOS 18.0, *) {
            call.resolve(["available": true])
            return
        }
        #endif
        call.resolve(["available": false])
    }

    @objc func show(_ call: CAPPluginCall) {
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
