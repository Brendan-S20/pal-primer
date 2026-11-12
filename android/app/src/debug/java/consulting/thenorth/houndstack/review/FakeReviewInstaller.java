package consulting.thenorth.houndstack.review;

import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.getcapacitor.BridgeActivity;
import consulting.thenorth.houndstack.BuildConfig;

/**
 * Puts FakeReviewPlugin on the Capacitor bridge in a DEBUG build made with
 * -Phoundstack.fakeReview=on|fail (issue #521). Declared only in
 * src/debug/AndroidManifest.xml, so a release build has neither the class nor
 * the declaration.
 *
 * Why a provider and not a line in MainActivity: BridgeActivity.onCreate()
 * calls super.onCreate() first, which dispatches onActivityCreated to every
 * registered lifecycle callback, and only then builds the bridge. Registering
 * the plugin from that callback lands it in time, on every API level, and
 * keeps the production activity free of anything debug-only.
 */
public class FakeReviewInstaller extends ContentProvider {

    @Override
    public boolean onCreate() {
        if (!FakeReviewPlugin.isEnabled(BuildConfig.FAKE_REVIEW_MANAGER)) return true;
        if (getContext() == null) return true;
        Application app = (Application) getContext().getApplicationContext();
        app.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override
            public void onActivityCreated(@NonNull Activity activity, @Nullable Bundle state) {
                if (activity instanceof BridgeActivity) {
                    ((BridgeActivity) activity).registerPlugin(FakeReviewPlugin.class);
                }
            }

            @Override public void onActivityStarted(@NonNull Activity activity) {}
            @Override public void onActivityResumed(@NonNull Activity activity) {}
            @Override public void onActivityPaused(@NonNull Activity activity) {}
            @Override public void onActivityStopped(@NonNull Activity activity) {}
            @Override public void onActivitySaveInstanceState(@NonNull Activity activity, @NonNull Bundle state) {}
            @Override public void onActivityDestroyed(@NonNull Activity activity) {}
        });
        return true;
    }

    @Nullable @Override
    public Cursor query(@NonNull Uri uri, @Nullable String[] p, @Nullable String s, @Nullable String[] a, @Nullable String o) {
        return null;
    }

    @Nullable @Override
    public String getType(@NonNull Uri uri) {
        return null;
    }

    @Nullable @Override
    public Uri insert(@NonNull Uri uri, @Nullable ContentValues values) {
        return null;
    }

    @Override
    public int delete(@NonNull Uri uri, @Nullable String s, @Nullable String[] a) {
        return 0;
    }

    @Override
    public int update(@NonNull Uri uri, @Nullable ContentValues v, @Nullable String s, @Nullable String[] a) {
        return 0;
    }
}
