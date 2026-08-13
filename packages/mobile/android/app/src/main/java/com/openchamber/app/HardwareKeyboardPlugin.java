package com.openchamber.app;

import android.content.res.Configuration;
import android.os.Handler;
import android.os.Looper;
import android.view.InputDevice;
import android.view.KeyEvent;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native answer to "is a physical keyboard attached?", mirroring the iOS
 * GCKeyboard bridge ({@code BridgeViewController} in the iOS app).
 *
 * <p>The web layer otherwise INFERS attachment from a soft keyboard that never
 * appears, which costs one focus before the layout settles. This plugin owns
 * the authoritative answer and publishes it as
 * {@code window.__OPENCHAMBER_HARDWARE_KEYBOARD__} plus an
 * {@code oc:hardware-keyboard} CustomEvent — the exact contract the shared
 * {@code hardwareKeyboard.ts} bridge consumes on every runtime, so the web side
 * needs no changes.
 *
 * <p>Android has no single "keyboard connected" API. The signals used here, in
 * order of reliability:
 * <ol>
 *   <li>An {@link InputDevice} with the keyboard source that is not the
 *       virtual device. Bluetooth and built-in physical keyboards register an
 *       InputDevice; IMEs (the soft keyboard) never do.</li>
 *   <li>A key event arriving from such a device (see
 *       {@link #onHardwareKeyEvent(KeyEvent)}), which proves attachment the
 *       instant the user presses a key.</li>
 *   <li>{@link #handleOnConfigurationChanged(Configuration)} and
 *       {@link #handleOnResume()} re-scan for attach/detach while foregrounded
 *       or after returning from background — a keyboard can be connected or
 *       unplugged while the app is not in front.</li>
 * </ol>
 *
 * <p>{@code configuration.keyboard == KEYBOARD_QWERTY} is deliberately NOT
 * used: it reports the <em>default</em> input method, and many devices report
 * QWERTY with no physical keyboard attached at all.
 *
 * <p>Android has no document-start script injection like iOS' WKUserScript, so
 * the first publish from {@link #load()} is queued and may land before or after
 * the page's own scripts. The web bridge adopts idempotently and is driven by
 * the live event, so the staggered re-publishes below guarantee an event
 * reaches it even if the first one fired before it registered.
 */
@CapacitorPlugin(name = "HardwareKeyboard")
public class HardwareKeyboardPlugin extends Plugin {

    private static final long[] REANSWER_DELAYS_MS = { 300L, 1000L, 2500L };

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable[] delayedPublishes = new Runnable[REANSWER_DELAYS_MS.length];

    @Override
    public void load() {
        super.load();
        // The WebView may not exist yet during load(), so the immediate publish
        // can be a no-op; the staggered re-publishes cover both the late-created
        // WebView and the web bridge that mounts after page scripts.
        refreshHardwareKeyboardState();
        for (int i = 0; i < REANSWER_DELAYS_MS.length; i++) {
            final long delayMs = REANSWER_DELAYS_MS[i];
            delayedPublishes[i] = () -> {
                if (getBridge() == null) return;
                refreshHardwareKeyboardState();
            };
            mainHandler.postDelayed(delayedPublishes[i], delayMs);
        }
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        refreshHardwareKeyboardState();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        refreshHardwareKeyboardState();
    }

    @Override
    protected void handleOnDestroy() {
        for (Runnable runnable : delayedPublishes) {
            if (runnable != null) {
                mainHandler.removeCallbacks(runnable);
            }
        }
        super.handleOnDestroy();
    }

    /**
     * Called from {@code MainActivity.dispatchKeyEvent} before the WebView
     * handles the key. A key event from a physical keyboard is the strongest
     * proof one is attached — publish immediately rather than waiting for a
     * config change (which not every device reports on keyboard attach).
     */
    public void onHardwareKeyEvent(KeyEvent event) {
        if (event == null) {
            return;
        }
        InputDevice device = event.getDevice();
        if (device == null || device.isVirtual()) {
            return;
        }
        if ((device.getSources() & InputDevice.SOURCE_KEYBOARD) == 0) {
            return;
        }
        // Same discriminator as the scan: a soft-keyboard Enter arrives through
        // dispatchKeyEvent too, but its device is not an alphabetic keyboard.
        if (device.getKeyboardType() != InputDevice.KEYBOARD_TYPE_ALPHABETIC) {
            return;
        }
        publishHardwareKeyboardState(true);
    }

    /** Re-scan input devices and publish whatever changed. */
    public void refreshHardwareKeyboardState() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        publishHardwareKeyboardState(isPhysicalKeyboardAttached());
    }

    private boolean isPhysicalKeyboardAttached() {
        for (int deviceId : InputDevice.getDeviceIds()) {
            InputDevice device = InputDevice.getDevice(deviceId);
            if (device == null || device.isVirtual()) {
                continue;
            }
            // A real typing keyboard is alphabetic. Built-in devices (touchpanel,
            // power/nav keys, fingerprint) also carry SOURCE_KEYBOARD but report
            // NON_ALPHABETIC, so requiring the alphabetic type is what separates a
            // genuine physical keyboard from the noise every phone/tablet exposes.
            if ((device.getSources() & InputDevice.SOURCE_KEYBOARD) != 0
                    && device.getKeyboardType() == InputDevice.KEYBOARD_TYPE_ALPHABETIC) {
                return true;
            }
        }
        return false;
    }

    private void publishHardwareKeyboardState(boolean attached) {
        String value = attached ? "true" : "false";
        getBridge().getWebView().evaluateJavascript(
            "window.__OPENCHAMBER_HARDWARE_KEYBOARD__ = " + value + ";"
                + "window.dispatchEvent(new CustomEvent('oc:hardware-keyboard', { detail: { attached: " + value + " } }));",
            null
        );
    }
}
