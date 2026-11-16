package consulting.thenorth.houndstack;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate, which builds the bridge and loads plugins.
        registerPlugin(HoundStackNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
