package com.gemix.connect;

import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Rational;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String MSG_CHANNEL_ID = "gemix_messages_channel";
    private static final String CALL_CHANNEL_ID = "gemix_calls_channel";
    private static final String PREFS_NAME = "gemix_connect_prefs";
    private static final String KEY_OVERLAY_PROMPTED = "overlay_prompted_once";
    private static final int CALL_NOTIF_ID = 9001;
    private int msgNotifCounter = 1000;

    private AudioManager audioManager;
    private NotificationManager notificationManager;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyLockScreenFlags();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannels();

        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(new GemixAudioBridge(), "GemixAudio");
            this.bridge.getWebView().addJavascriptInterface(new GemixNotifyBridge(), "GemixNotify");
        }

    }

    private void promptOverlayOnceIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            if (Settings.canDrawOverlays(this)) return;
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            boolean alreadyPrompted = prefs.getBoolean(KEY_OVERLAY_PROMPTED, false);
            if (!alreadyPrompted) {
                prefs.edit().putBoolean(KEY_OVERLAY_PROMPTED, true).apply();
                openOverlaySettingsPage();
            }
        } catch (Exception ignored) {}
    }

    private void openOverlaySettingsPage() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception ignored) {}
    }

    private void applyLockScreenFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            try {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            } catch (Exception ignored) {}
        }
        try {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            );
        } catch (Exception ignored) {}
    }

    private void wakeScreenAndBringToFront() {
        runOnUiThread(() -> {
            applyLockScreenFlags();
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
                    if (km != null) {
                        km.requestDismissKeyguard(this, null);
                    }
                }
            } catch (Exception ignored) {}
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    PowerManager.WakeLock wl = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        "GemixConnect:IncomingCallWake"
                    );
                    wl.acquire(5000L);
                }
            } catch (Exception ignored) {}
            try {
                Intent intent = new Intent(MainActivity.this, MainActivity.class);
                intent.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK |
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT |
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
                );
                startActivity(intent);
            } catch (Exception ignored) {}
        });
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notificationManager != null) {
            NotificationChannel msgChannel = new NotificationChannel(
                MSG_CHANNEL_ID,
                "Gemix Messages",
                NotificationManager.IMPORTANCE_HIGH
            );
            msgChannel.setDescription("New message notifications");
            notificationManager.createNotificationChannel(msgChannel);

            NotificationChannel callChannel = new NotificationChannel(
                CALL_CHANNEL_ID,
                "Gemix Incoming Calls",
                NotificationManager.IMPORTANCE_HIGH
            );
            callChannel.setDescription("Incoming voice and video call alerts");
            callChannel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
            notificationManager.createNotificationChannel(callChannel);
        }
    }

    private PendingIntent createOpenAppIntent(int requestCode) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK |
            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT |
            Intent.FLAG_ACTIVITY_SINGLE_TOP |
            Intent.FLAG_ACTIVITY_CLEAR_TOP
        );
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, requestCode, intent, flags);
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                PictureInPictureParams params = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(9, 16))
                    .build();
                enterPictureInPictureMode(params);
            } catch (Exception ignored) {}
        }
    }

    private class GemixAudioBridge {
        @JavascriptInterface
        public void startCallAudio() {
            if (audioManager == null) return;
            try {
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audioManager.setSpeakerphoneOn(false);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void setSpeaker(boolean enabled) {
            if (audioManager == null) return;
            try {
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audioManager.setSpeakerphoneOn(enabled);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void resetCallAudio() {
            if (audioManager == null) return;
            try {
                audioManager.setSpeakerphoneOn(false);
                audioManager.setMode(AudioManager.MODE_NORMAL);
            } catch (Exception ignored) {}
        }
    }

    private class GemixNotifyBridge {
        @JavascriptInterface
        public void showMessageNotification(String title, String body) {
            if (notificationManager == null) return;
            try {
                String safeTitle = (title != null && !title.isEmpty()) ? title : "Gemix Connect";
                String safeBody = (body != null && !body.isEmpty()) ? body : "New message";
                int iconRes = getApplicationInfo().icon != 0 ? getApplicationInfo().icon : android.R.drawable.ic_dialog_email;

                NotificationCompat.Builder builder = new NotificationCompat.Builder(MainActivity.this, MSG_CHANNEL_ID)
                    .setSmallIcon(iconRes)
                    .setContentTitle(safeTitle)
                    .setContentText(safeBody)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(safeBody))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setAutoCancel(true)
                    .setContentIntent(createOpenAppIntent(msgNotifCounter));

                notificationManager.notify(msgNotifCounter++, builder.build());
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void showIncomingCallNotification(String callerName, String callLabel) {
            wakeScreenAndBringToFront();
            if (notificationManager == null) return;
            try {
                String safeCaller = (callerName != null && !callerName.isEmpty()) ? callerName : "Incoming Call";
                String safeLabel = (callLabel != null && !callLabel.isEmpty()) ? callLabel : "Incoming Call";
                int iconRes = getApplicationInfo().icon != 0 ? getApplicationInfo().icon : android.R.drawable.ic_menu_call;
                PendingIntent fullScreenPi = createOpenAppIntent(CALL_NOTIF_ID);

                NotificationCompat.Builder builder = new NotificationCompat.Builder(MainActivity.this, CALL_CHANNEL_ID)
                    .setSmallIcon(iconRes)
                    .setContentTitle(safeCaller)
                    .setContentText(safeLabel)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setFullScreenIntent(fullScreenPi, true)
                    .setContentIntent(fullScreenPi);

                notificationManager.notify(CALL_NOTIF_ID, builder.build());
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void cancelCallNotification() {
            if (notificationManager == null) return;
            try {
                notificationManager.cancel(CALL_NOTIF_ID);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void openOverlaySettings() {
            runOnUiThread(() -> openOverlaySettingsPage());
        }
    }
}
