package consulting.thenorth.houndstack.review;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.Context;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.android.gms.tasks.Task;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.testing.FakeReviewManager;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Issue #521 on a real Android runtime: FakeReviewManager with a real
 * Context, listeners on the main thread as Play delivers them. Needs a device
 * or emulator: `./gradlew connectedDebugAndroidTest`. Not in CI (no device
 * farm); the same behaviour is covered on the JVM by ReviewFlowTest, which is.
 */
@RunWith(AndroidJUnit4.class)
public class FakeReviewManagerInstrumentedTest {

    private static final String PLAY_LISTING =
        "https://play.google.com/store/apps/details?id=consulting.thenorth.houndstack";

    private Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private ReviewFlow.Outcome runOnMain(ReviewManager manager) throws InterruptedException {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<ReviewFlow.Outcome> outcome = new AtomicReference<>();
        ReviewFlow.run(manager, null, context().getMainExecutor(), (o, e) -> {
            outcome.set(o);
            latch.countDown();
        });
        assertTrue("review flow never finished", latch.await(10, TimeUnit.SECONDS));
        return outcome.get();
    }

    @Test
    public void requestThenLaunchOnceEachWithFakeReviewManager() throws Exception {
        FakeReviewManager fake = new FakeReviewManager(context());
        AtomicInteger requests = new AtomicInteger();
        AtomicInteger launches = new AtomicInteger();
        ReviewManager counting = new ReviewManager() {
            @Override
            public Task<ReviewInfo> requestReviewFlow() {
                requests.incrementAndGet();
                return fake.requestReviewFlow();
            }

            @Override
            public Task<Void> launchReviewFlow(Activity activity, ReviewInfo info) {
                launches.incrementAndGet();
                return fake.launchReviewFlow(activity, info);
            }
        };

        assertEquals(ReviewFlow.Outcome.LAUNCHED, runOnMain(counting));
        assertEquals(1, requests.get());
        assertEquals(1, launches.get());
    }

    @Test
    public void aFailedRequestIsSwallowed() throws Exception {
        FailingReviewManager failing = new FailingReviewManager();
        assertEquals(ReviewFlow.Outcome.REQUEST_FAILED, runOnMain(failing));
        assertEquals(0, failing.launchCalls);
    }

    @Test
    public void thePlayListingNamesThisInstalledPackage() {
        // The "Rate HoundStack" row (src/components/settings/RateAppCard.tsx)
        // opens this URL. The installed app's package name is the one fact a
        // device can check about it; vitest checks the same URL against
        // applicationId in android/app/build.gradle without a device.
        assertEquals(context().getPackageName(), Uri.parse(PLAY_LISTING).getQueryParameter("id"));
    }
}
