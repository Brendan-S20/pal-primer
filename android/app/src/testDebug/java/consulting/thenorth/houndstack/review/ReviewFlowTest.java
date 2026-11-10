package consulting.thenorth.houndstack.review;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.PendingIntent;
import com.google.android.gms.tasks.Task;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.testing.FakeReviewManager;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.mockito.MockedStatic;
import org.mockito.Mockito;

/**
 * Issue #521, on the JVM: no device, no emulator, runs in CI with
 * `./gradlew testDebugUnitTest`. The eligibility rules (office role after the
 * first paid invoice, a tech after ten visits, never a dispatcher, the 120-day
 * cap) are decided in TypeScript and tested in tests/rating-prompt.test.ts;
 * by the time this code runs the answer is already "ask". What is tested here
 * is the Android half: once asked, request then launch, exactly once each,
 * and a failure is swallowed.
 */
public class ReviewFlowTest {

    private static final Executor INLINE = Runnable::run;

    /**
     * FakeReviewManager wraps PendingIntent.getBroadcast() in its ReviewInfo,
     * and on the JVM the stub android.jar returns null, which ReviewInfo
     * refuses. A device returns a real one; here a mock stands in.
     */
    private MockedStatic<PendingIntent> pendingIntents;

    @Before
    public void giveFakeReviewManagerAPendingIntent() {
        pendingIntents = Mockito.mockStatic(PendingIntent.class);
        pendingIntents
            .when(() -> PendingIntent.getBroadcast(Mockito.any(), Mockito.anyInt(), Mockito.any(), Mockito.anyInt()))
            .thenAnswer((call) -> Mockito.mock(PendingIntent.class));
    }

    @After
    public void releaseTheStaticMock() {
        pendingIntents.close();
    }

    /** Wraps a manager to count calls, since FakeReviewManager does not. */
    private static final class Counting implements ReviewManager {

        final ReviewManager inner;
        int requests = 0;
        int launches = 0;

        Counting(ReviewManager inner) {
            this.inner = inner;
        }

        @Override
        public Task<ReviewInfo> requestReviewFlow() {
            requests++;
            return inner.requestReviewFlow();
        }

        @Override
        public Task<Void> launchReviewFlow(Activity activity, ReviewInfo info) {
            launches++;
            return inner.launchReviewFlow(activity, info);
        }
    }

    private static final class Recorder implements ReviewFlow.Callback {

        final List<ReviewFlow.Outcome> outcomes = new ArrayList<>();
        Exception lastError;

        @Override
        public void onDone(ReviewFlow.Outcome outcome, Exception error) {
            outcomes.add(outcome);
            lastError = error;
        }
    }

    @Test
    public void anEligiblePromptRequestsThenLaunchesOnceEach() {
        Counting manager = new Counting(new FakeReviewManager(null));
        Recorder done = new Recorder();

        ReviewFlow.run(manager, null, INLINE, done);

        assertEquals(1, manager.requests);
        assertEquals(1, manager.launches);
        assertEquals(List.of(ReviewFlow.Outcome.LAUNCHED), done.outcomes);
    }

    @Test
    public void aFailedRequestIsSwallowedAndNeverLaunches() {
        FailingReviewManager manager = new FailingReviewManager();
        Recorder done = new Recorder();

        ReviewFlow.run(manager, null, INLINE, done);

        assertEquals(1, manager.requestCalls);
        assertEquals("launch must not follow a failed request", 0, manager.launchCalls);
        assertEquals(List.of(ReviewFlow.Outcome.REQUEST_FAILED), done.outcomes);
        assertNotNull(done.lastError);
    }

    @Test
    public void aManagerThatThrowsIsSwallowedToo() {
        ReviewManager throwing = new ReviewManager() {
            @Override
            public Task<ReviewInfo> requestReviewFlow() {
                throw new IllegalStateException("Play services missing");
            }

            @Override
            public Task<Void> launchReviewFlow(Activity activity, ReviewInfo info) {
                throw new AssertionError("never reached");
            }
        };
        Recorder done = new Recorder();

        ReviewFlow.run(throwing, null, INLINE, done);

        assertEquals(List.of(ReviewFlow.Outcome.REQUEST_FAILED), done.outcomes);
    }

    @Test
    public void aLaunchWithSomeoneElsesReviewInfoFails() {
        // FakeReviewManager refuses a ReviewInfo it did not hand out, the way
        // Play refuses a stale one. Two managers, crossed: the outcome must be
        // LAUNCH_FAILED, reported once, and nothing thrown.
        FakeReviewManager first = new FakeReviewManager(null);
        FakeReviewManager second = new FakeReviewManager(null);
        ReviewManager crossed = new ReviewManager() {
            @Override
            public Task<ReviewInfo> requestReviewFlow() {
                return first.requestReviewFlow();
            }

            @Override
            public Task<Void> launchReviewFlow(Activity activity, ReviewInfo info) {
                return second.launchReviewFlow(activity, info);
            }
        };
        Recorder done = new Recorder();

        ReviewFlow.run(crossed, null, INLINE, done);

        assertEquals(List.of(ReviewFlow.Outcome.LAUNCH_FAILED), done.outcomes);
    }

    @Test
    public void theBuildFlagIsOffUnlessItSaysOnOrFail() {
        assertFalse(FakeReviewPlugin.isEnabled(null));
        assertFalse(FakeReviewPlugin.isEnabled(""));
        assertFalse(FakeReviewPlugin.isEnabled("off"));
        assertFalse(FakeReviewPlugin.isEnabled("true"));
        assertFalse(FakeReviewPlugin.isEnabled("ON"));
        assertTrue(FakeReviewPlugin.isEnabled("on"));
        assertTrue(FakeReviewPlugin.isEnabled("fail"));
    }

    @Test
    public void failModeUsesTheFailingManager() {
        assertTrue(FakeReviewPlugin.managerFor("fail", null) instanceof FailingReviewManager);
        assertTrue(FakeReviewPlugin.managerFor("on", null) instanceof FakeReviewManager);
    }
}
