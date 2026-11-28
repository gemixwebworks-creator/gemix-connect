package com.gemix.connect;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        GemixBackgroundService.ensureChannels(this);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
            }
        }

        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void registerBackgroundUser(String gemixNum, String userName) {
                    runOnUiThread(() -> GemixBackgroundService.startService(MainActivity.this, gemixNum, userName));
                }
            }, "GemixNativeBg");
        }

        String savedNum = getSharedPreferences("gemix_bg_prefs", MODE_PRIVATE).getString("gemixNum", "");
        if (savedNum != null && !savedNum.isEmpty()) {
            GemixBackgroundService.startService(this, savedNum, "");
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        try {
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().evaluateJavascript(
                    "if(typeof gemixSetMyPresence==='function')gemixSetMyPresence(false);", null
                );
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onStop() {
        super.onStop();
        try {
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().evaluateJavascript(
                    "if(typeof gemixSetMyPresence==='function')gemixSetMyPresence(false);", null
                );
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onDestroy() {
        String savedNum = getSharedPreferences("gemix_bg_prefs", MODE_PRIVATE).getString("gemixNum", "");
        if (savedNum != null && !savedNum.isEmpty()) {
            GemixBackgroundService.startService(getApplicationContext(), savedNum, "");
        }
        super.onDestroy();
    }
}
