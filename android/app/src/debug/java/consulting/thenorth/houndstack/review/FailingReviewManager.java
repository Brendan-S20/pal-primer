package consulting.thenorth.houndstack.review;

import android.app.Activity;
import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.android.play.core.review.ReviewException;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.model.ReviewErrorCode;

/**
 * A ReviewManager whose requestReviewFlow() always fails, the way Play's does
 * when the Play Store is missing or out of date. FakeReviewManager only ever
 * succeeds, so this is the debug build's way to show that a failed request is
 * swallowed (-Phoundstack.fakeReview=fail). Debug source set only.
 */
public final class FailingReviewManager implements ReviewManager {

    public int requestCalls = 0;
    public int launchCalls = 0;

    @Override
    public Task<ReviewInfo> requestReviewFlow() {
        requestCalls++;
        return Tasks.forException(new ReviewException(ReviewErrorCode.PLAY_STORE_NOT_FOUND));
    }

    @Override
    public Task<Void> launchReviewFlow(Activity activity, ReviewInfo reviewInfo) {
        launchCalls++;
        return Tasks.forException(new ReviewException(ReviewErrorCode.INVALID_REQUEST));
    }
}
