package com.openchamber.app;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugin: register before super.onCreate so the bridge picks
        // it up alongside the plugins listed in capacitor.plugins.json. Keeping
        // the registration here (and the class in this source set) means
        // `cap sync` can never wipe it — it only regenerates the JSON/gradle
        // plugin files.
        registerPlugin(HardwareKeyboardPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // A key event from a physical keyboard is the strongest proof one is
        // attached, and config changes are not reliably fired on attach — so
        // surface every key to the plugin before the WebView consumes it.
        PluginHandle handle = getBridge() != null ? getBridge().getPlugin("HardwareKeyboard") : null;
        if (handle != null && handle.getInstance() instanceof HardwareKeyboardPlugin) {
            ((HardwareKeyboardPlugin) handle.getInstance()).onHardwareKeyEvent(event);
        }
        return super.dispatchKeyEvent(event);
    }
}
