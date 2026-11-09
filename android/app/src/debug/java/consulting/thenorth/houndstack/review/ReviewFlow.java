package consulting.thenorth.houndstack.review;

import android.app.Activity;
import androidx.annotation.Nullable;
import com.google.android.gms.tasks.Task;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import java.util.concurrent.Executor;

/**
 * The two calls Play's in-app review API takes, in the order it takes them:
 * requestReviewFlow(), then launchReviewFlow() with the ReviewInfo it gave.
 * The same sequence @capacitor-community/in-app-review runs against the real
 * ReviewManager, written here so a debug build can run it against
 * FakeReviewManager and a test can count it (issue #521).
 *
 * Never loud. Every failure, including a manager that throws instead of
 * returning a failed Task, ends in the callback with an outcome; nothing
 * propagates. The JS caller (src/lib/rating-prompt-native.ts) treats anything
 * but LAUNCHED as "skipped" and the app carries on.
 *
 * The executor is a parameter so a JVM test can run the listeners inline.
 */
public final class ReviewFlow {

    public enum Outcome {
        /** Both calls succeeded. Play never says whether a sheet appeared. */
        LAUNCHED,
        /** requestReviewFlow() failed, threw, or gave no ReviewInfo. launch was not called. */
        REQUEST_FAILED,
        /** launchReviewFlow() failed or threw. */
        LAUNCH_FAILED,
    }

    public interface Callback {
        void onDone(Outcome outcome, @Nullable Exception error);
    }

    private ReviewFlow() {}

    public static void run(
        final ReviewManager manager,
        final Activity activity,
        final Executor executor,
        final Callback callback
    ) {
        final Task<ReviewInfo> request;
        try {
            request = manager.requestReviewFlow();
        } catch (RuntimeException e) {
            callback.onDone(Outcome.REQUEST_FAILED, e);
            return;
        }
        request.addOnCompleteListener(executor, (requested) -> {
            if (!requested.isSuccessful() || requested.getResult() == null) {
                callback.onDone(Outcome.REQUEST_FAILED, requested.getException());
                return;
            }
            final Task<Void> launch;
            try {
                launch = manager.launchReviewFlow(activity, requested.getResult());
            } catch (RuntimeException e) {
                callback.onDone(Outcome.LAUNCH_FAILED, e);
                return;
            }
            launch.addOnCompleteListener(executor, (launched) ->
                callback.onDone(
                    launched.isSuccessful() ? Outcome.LAUNCHED : Outcome.LAUNCH_FAILED,
                    launched.getException()
                )
            );
        });
    }
}
