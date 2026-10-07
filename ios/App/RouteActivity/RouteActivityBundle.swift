// The RouteActivity widget extension: a technician's route on the lock screen
// and in the Dynamic Island. It has no home-screen widget; the bundle exists
// because ActivityKit draws a Live Activity from a WidgetKit extension and
// nowhere else.

import WidgetKit
import SwiftUI

@main
struct RouteActivityBundle: WidgetBundle {
    var body: some Widget {
        RouteLiveActivity()
    }
}
