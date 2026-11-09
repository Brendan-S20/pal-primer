package consulting.thenorth.houndstack.review;

import android.widget.Toast;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.testing.FakeReviewManager;
import java.util.Locale;

/**
 * Debug/QA stand-in for the in-app rating prompt on Android (issue #521).
 *
 * Play's review sheet never appears on a debug build or a sideloaded APK, so
 * on a QA phone the real path is indistinguishable from "nothing happened".
 * This plugin runs the same request-then-launch sequence against Play's own
 * FakeReviewManager and shows a toast at the moment the sheet WOULD appear,
 * so a tester can see when the eligibility rules in src/lib/rating-prompt.ts
 * actually fire.
 *
 * Lives in src/debug only and is registered (by FakeReviewInstaller) only when the APK was built with
 * -Phoundstack.fakeReview=on (or =fail, which uses FailingReviewManager to
 * show that a failed request is swallowed). Release builds cannot contain it.
 */
@CapacitorPlugin(name = FakeReviewPlugin.NAME)
public class FakeReviewPlugin extends Plugin {

    /** Must match FAKE_REVIEW_PLUGIN in src/lib/rating-prompt-native.ts. */
    public static final String NAME = "HoundStackFakeReview";

    private int requested = 0;
    private int launched = 0;
    private int failed = 0;
    @Nullable
    private String lastOutcome = null;

    /** The build flag's values. Anything else, including "", is off. */
    public static boolean isEnabled(@Nullable String flag) {
        return "on".equals(flag) || "fail".equals(flag);
    }

    static ReviewManager managerFor(@Nullable String flag, android.content.Context context) {
        return "fail".equals(flag) ? new FailingReviewManager() : new FakeReviewManager(context);
    }

    @PluginMethod
    public void requestReview(final PluginCall call) {
        requested++;
        final ReviewManager manager = managerFor(
            consulting.thenorth.houndstack.BuildConfig.FAKE_REVIEW_MANAGER,
            getContext()
        );
        ReviewFlow.run(manager, getActivity(), Runnable::run, (outcome, error) -> {
            if (outcome == ReviewFlow.Outcome.LAUNCHED) launched++;
            else failed++;
            lastOutcome = outcome.name().toLowerCase(Locale.ROOT);
            final String message = outcome == ReviewFlow.Outcome.LAUNCHED
                ? "FakeReviewManager: the Play review sheet would appear now (#" + launched + ")"
                : "FakeReviewManager: " + lastOutcome + " (swallowed, app carries on)";
            getActivity().runOnUiThread(() -> Toast.makeText(getContext(), message, Toast.LENGTH_LONG).show());
            JSObject result = new JSObject();
            result.put("outcome", lastOutcome);
            call.resolve(result);
        });
    }

    /** For a tester (or a debugger console): how many times it has fired this launch. */
    @PluginMethod
    public void getStats(final PluginCall call) {
        JSObject result = new JSObject();
        result.put("requested", requested);
        result.put("launched", launched);
        result.put("failed", failed);
        result.put("lastOutcome", lastOutcome);
        result.put("mode", consulting.thenorth.houndstack.BuildConfig.FAKE_REVIEW_MANAGER);
        call.resolve(result);
    }
}
