package consulting.thenorth.houndstack;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.provider.Settings;
import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The two things no installed Capacitor plugin does, called from
 * src/lib/native.ts.
 *
 * setSystemBarBackground (R2-28). Under edge-to-edge (targetSdk 35+, enforced
 * from Android 15) StatusBar.setBackgroundColor is skipped by the plugin, and
 * Capacitor's SystemBars pads the WebView's PARENT by the status bar's height
 * when it does not pass the inset through to the page. That padding is
 * transparent, so the window background shows behind the clock, and
 * SystemBars resets the window background to the DayNight theme's on every
 * configuration change: black in system dark mode, under the dark icons a
 * light app asks for. Painting the parent covers that band with the app's own
 * colour, and SystemBars never touches the parent's background.
 *
 * openAppSettings (R2-54). Location denied on Android is cleared on the app's
 * own page in Settings, and nothing the WebView can navigate to opens it:
 * Bridge.launchIntent wraps every URL in ACTION_VIEW, and no activity views
 * a "package:" URI.
 */
@CapacitorPlugin(name = "HoundStackNative")
public class HoundStackNativePlugin extends Plugin {

    @PluginMethod
    public void setSystemBarBackground(PluginCall call) {
        String color = call.getString("color");
        if (color == null) {
            call.reject("color is required");
            return;
        }
        final int parsed;
        try {
            parsed = Color.parseColor(color);
        } catch (IllegalArgumentException e) {
            call.reject("not a colour: " + color);
            return;
        }
        getBridge().executeOnMainThread(() -> {
            View parent = (View) getBridge().getWebView().getParent();
            if (parent != null) parent.setBackgroundColor(parsed);
            call.resolve();
        });
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open settings", e);
        }
    }
}
