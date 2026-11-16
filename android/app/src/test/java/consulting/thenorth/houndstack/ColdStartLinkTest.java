package consulting.thenorth.houndstack;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ServiceWorkerWebSettings;
import org.robolectric.RuntimeEnvironment;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowWebView;

/**
 * Issue #621, the Android half, on the JVM: no device, no emulator.
 *
 * On a Pixel 10a (Nov 2 2026) a link sent to a KILLED app with
 * `am start -a android.intent.action.VIEW -d <url>` landed on My Day. These
 * tests start the real MainActivity cold with exactly that intent and check
 * every step up to the web layer:
 *
 *   1. the manifest sends the link to MainActivity at all;
 *   2. the bridge records it as the launch URL (what App.getLaunchUrl reads);
 *   3. Capacitor's App plugin keeps it as an appUrlOpen event until the first
 *      JS listener attaches, and hands it over intact, query and all;
 *   4. only that FIRST listener gets it. That is the Capacitor behaviour
 *      src/lib/app-url-open.ts is built around (one JS listener, sorted by
 *      kind), and if a Capacitor upgrade changed it the JS side would need to
 *      know, so it is pinned here.
 *
 * What happens after the event reaches JS is tested in vitest:
 * tests/a-link-that-opened-a-killed-app-lands-where-it-points.test.ts.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = ColdStartLinkTest.NoServiceWorkers.class)
public class ColdStartLinkTest {

    /**
     * Robolectric has no WebView provider, and Capacitor's Bridge asks for the
     * service-worker controller while it loads the page. Nothing here is about
     * service workers, so it gets one that does nothing. Every other step of
     * MainActivity.onCreate is the real one.
     */
    @Implements(ServiceWorkerController.class)
    public static class NoServiceWorkers {

        @Implementation
        protected static ServiceWorkerController getInstance() {
            return new ServiceWorkerController() {
                @Override
                public ServiceWorkerWebSettings getServiceWorkerWebSettings() {
                    return null;
                }

                @Override
                public void setServiceWorkerClient(ServiceWorkerClient client) {}
            };
        }
    }

    /** The three links the device check used, plus a query string that must
     *  survive (a Live Activity link carries one). */
    private static final List<String> LINKS = Arrays.asList(
        "https://app.houndstack.com/my-schedule",
        "https://app.houndstack.com/profile",
        "https://app.houndstack.com/invite/3f9c2a7e-token",
        "https://app.houndstack.com/my-day?stop=abc&from=link"
    );

    /** A JS call into a plugin, recording what native resolves it with. */
    private static final class Recorded extends PluginCall {

        final List<JSObject> results = new ArrayList<>();

        Recorded(String method, JSObject data) {
            super(null, "App", "cb-" + method, method, data);
        }

        @Override
        public void resolve(JSObject data) {
            results.add(data);
        }

        @Override
        public void resolve() {
            results.add(new JSObject());
        }

        List<String> urls() {
            List<String> out = new ArrayList<>();
            for (JSObject r : results) out.add(r.getString("url"));
            return out;
        }
    }

    /** Capacitor refuses to load on a WebView older than its minimum, and
     *  Robolectric reports none installed. A current Chrome WebView. */
    @Before
    public void aCurrentWebView() {
        PackageInfo webView = new PackageInfo();
        webView.packageName = "com.google.android.webview";
        webView.versionName = "140.0.7339.0";
        ShadowWebView.setCurrentWebViewPackage(webView);
        // @capacitor/browser binds Chrome's Custom Tabs service at load to
        // warm it up; Robolectric would "connect" it with no service behind
        // it. A phone without Chrome refuses the bind, and so does this.
        Shadows.shadowOf(RuntimeEnvironment.getApplication())
            .declareActionUnbindable("android.support.customtabs.action.CustomTabsService");
    }

    private static Intent view(String url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setClassName(
            RuntimeEnvironment.getApplication().getPackageName(),
            MainActivity.class.getName()
        );
        return intent;
    }

    private static Plugin appPlugin(MainActivity activity) {
        Bridge bridge = activity.getBridge();
        assertNotNull("the bridge was not built", bridge);
        PluginHandle handle = bridge.getPlugin("App");
        assertNotNull("@capacitor/app is not registered with the bridge", handle);
        return handle.getInstance();
    }

    /** What `App.addListener("appUrlOpen", ...)` sends from JS. */
    private static Recorded listen(Plugin app) {
        JSObject data = new JSObject();
        data.put("eventName", "appUrlOpen");
        Recorded call = new Recorded("addListener", data);
        app.addListener(call);
        return call;
    }

    private static Recorded launchUrl(Plugin app) throws Exception {
        Recorded call = new Recorded("getLaunchUrl", new JSObject());
        app.getClass().getMethod("getLaunchUrl", PluginCall.class).invoke(app, call);
        return call;
    }

    @Test
    public void the_manifest_sends_each_link_to_main_activity() {
        Context ctx = RuntimeEnvironment.getApplication();
        for (String url : LINKS) {
            // No component: the system's own resolution, as an App Link tap.
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setPackage(ctx.getPackageName());
            List<ResolveInfo> found = ctx.getPackageManager().queryIntentActivities(intent, 0);
            boolean main = false;
            for (ResolveInfo r : found) {
                if (MainActivity.class.getName().equals(r.activityInfo.name)) main = true;
            }
            assertTrue(url + " does not resolve to MainActivity", main);
        }
    }

    @Test
    public void a_cold_launch_keeps_the_link_for_the_first_listener() throws Exception {
        for (String url : LINKS) {
            ActivityController<MainActivity> controller =
                Robolectric.buildActivity(MainActivity.class, view(url)).setup();
            try {
                MainActivity activity = controller.get();
                assertEquals(url, String.valueOf(activity.getBridge().getIntentUri()));

                Plugin app = appPlugin(activity);
                // getLaunchUrl reads the same launch intent.
                assertEquals(Arrays.asList(url), launchUrl(app).urls());

                // The web view boots and only then attaches its listener.
                Recorded first = listen(app);
                assertEquals(url + " was not handed to the first listener",
                    Arrays.asList(url), first.urls());

                // Handed once, to the first listener only (lib/app-url-open.ts).
                Recorded second = listen(app);
                assertTrue("a second listener was handed the launch link too: " + second.urls(),
                    second.results.isEmpty());
            } finally {
                controller.pause().stop().destroy();
            }
        }
    }

    @Test
    public void a_link_to_the_running_app_reaches_every_listener() {
        Intent launcher = new Intent(Intent.ACTION_MAIN);
        launcher.addCategory(Intent.CATEGORY_LAUNCHER);
        launcher.setComponent(new ComponentName(
            RuntimeEnvironment.getApplication(), MainActivity.class));
        ActivityController<MainActivity> controller =
            Robolectric.buildActivity(MainActivity.class, launcher).setup();
        try {
            Plugin app = appPlugin(controller.get());
            Recorded first = listen(app);
            Recorded second = listen(app);
            // A plain launch is not a link.
            assertTrue(first.results.isEmpty());
            for (String url : LINKS) controller.newIntent(view(url));
            assertEquals(LINKS, first.urls());
            assertEquals(LINKS, second.urls());
        } finally {
            controller.pause().stop().destroy();
        }
    }
}
