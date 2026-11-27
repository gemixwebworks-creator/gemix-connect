package com.gemix.connect;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class GemixBackgroundService extends Service {
    public static final String CHANNEL_SERVICE_ID = "gemix_bg_service_channel";
    public static final String CHANNEL_CALL_ID = "gemix_incoming_call_channel";
    public static final String CHANNEL_MSG_ID = "gemix_message_channel";
    public static final String EXTRA_GEMIX_NUM = "extra_gemix_num";
    public static final String EXTRA_USER_NAME = "extra_user_name";

    private static final String PROJECT_ID = "gemix-communication";
    private static final long POLL_INTERVAL_MS = 4000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private String gemixNum = "";
    private String lastHandledCallId = "";
    private final Set<String> seenMessageDocIds = new HashSet<>();
    private boolean initializedMessages = false;
    private boolean running = false;

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            new Thread(() -> {
                try {
                    if (gemixNum != null && !gemixNum.isEmpty()) {
                        checkIncomingCall(gemixNum);
                        checkRecentMessages(gemixNum);
                    }
                } catch (Exception ignored) {
                } finally {
                    if (running) {
                        handler.postDelayed(this, POLL_INTERVAL_MS);
                    }
                }
            }).start();
        }
    };

    public static void startService(Context ctx, String gemixNum, String userName) {
        if (ctx == null || gemixNum == null || gemixNum.trim().isEmpty()) return;
        Intent intent = new Intent(ctx, GemixBackgroundService.class);
        intent.putExtra(EXTRA_GEMIX_NUM, gemixNum.trim());
        intent.putExtra(EXTRA_USER_NAME, userName != null ? userName : "VIP User");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
    }

    public static void ensureChannels(Context ctx) {
        if (ctx == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel svcCh = new NotificationChannel(
                CHANNEL_SERVICE_ID,
                "Gemix Background Connection",
                NotificationManager.IMPORTANCE_LOW
        );
        svcCh.setDescription("Keeps Gemix Connect active for calls and messages");
        nm.createNotificationChannel(svcCh);

        NotificationChannel callCh = new NotificationChannel(
                CHANNEL_CALL_ID,
                "Gemix Incoming Calls",
                NotificationManager.IMPORTANCE_HIGH
        );
        callCh.setDescription("Incoming voice and video call alerts");
        callCh.enableVibration(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            callCh.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        }
        nm.createNotificationChannel(callCh);

        NotificationChannel msgCh = new NotificationChannel(
                CHANNEL_MSG_ID,
                "Gemix Messages",
                NotificationManager.IMPORTANCE_HIGH
        );
        msgCh.setDescription("Incoming chat message notifications");
        msgCh.enableVibration(true);
        nm.createNotificationChannel(msgCh);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels(this);
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GemixConnect:BgWakeLock");
                wakeLock.acquire(10 * 60 * 1000L);
            }
        } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannels(this);
        if (intent != null) {
            String num = intent.getStringExtra(EXTRA_GEMIX_NUM);
            if (num != null && !num.trim().isEmpty()) {
                gemixNum = num.trim();
                getSharedPreferences("gemix_bg_prefs", MODE_PRIVATE)
                        .edit()
                        .putString("gemixNum", gemixNum)
                        .apply();
            }
        }
        if (gemixNum == null || gemixNum.isEmpty()) {
            gemixNum = getSharedPreferences("gemix_bg_prefs", MODE_PRIVATE).getString("gemixNum", "");
        }

        Notification fgNotif = buildForegroundNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(9001, fgNotif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(9001, fgNotif);
        }

        if (!running) {
            running = true;
            handler.removeCallbacks(pollRunnable);
            handler.post(pollRunnable);
        }
        return START_STICKY;
    }

    private Notification buildForegroundNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 9001, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_SERVICE_ID)
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setContentTitle("Gemix Connect Active")
                .setContentText("Listening for VIP calls & messages")
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private String httpGet(String urlStr) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            if (conn.getResponseCode() != 200) return "";
            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close();
            return sb.toString();
        } catch (Exception e) {
            return "";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String extractStringField(String json, String fieldName) {
        Pattern p = Pattern.compile("\"" + Pattern.quote(fieldName) + "\"\s*:\s*\{\s*\"stringValue\"\s*:\s*\"([^\"]*)\"");
        Matcher m = p.matcher(json);
        return m.find() ? m.group(1) : "";
    }

    private boolean extractBoolField(String json, String fieldName) {
        Pattern p = Pattern.compile("\"" + Pattern.quote(fieldName) + "\"\s*:\s*\{\s*\"booleanValue\"\s*:\s*(true|false)");
        Matcher m = p.matcher(json);
        return m.find() && "true".equalsIgnoreCase(m.group(1));
    }

    private void checkIncomingCall(String targetNum) {
        String endpoint = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
                "/databases/(default)/documents/calls/" + targetNum;
        String body = httpGet(endpoint);
        if (body.isEmpty() || !body.contains(""fields"")) return;

        String status = extractStringField(body, "status");
        String callerName = extractStringField(body, "callerName");
        String callerNum = extractStringField(body, "callerGemixNum");
        boolean isVideo = extractBoolField(body, "isVideo");

        if ("ringing".equals(status) && !callerNum.equals(targetNum)) {
            String callKey = callerNum + "_" + (isVideo ? "vid" : "aud") + "_ringing";
            if (!callKey.equals(lastHandledCallId)) {
                lastHandledCallId = callKey;
                showIncomingCallAlert(
                        callerName.isEmpty() ? "Incoming Call" : callerName,
                        isVideo ? "VIP Video Call" : "VIP Voice Call"
                );
            }
        } else if (!"ringing".equals(status)) {
            lastHandledCallId = "";
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(9101);
        }
    }

    private void showIncomingCallAlert(String callerName, String callType) {
        ensureChannels(this);
        Intent fullScreenIntent = new Intent(this, MainActivity.class);
        fullScreenIntent.putExtra("gemix_incoming_call", true);
        fullScreenIntent.putExtra("caller_name", callerName);
        fullScreenIntent.putExtra("call_type", callType);
        fullScreenIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        PendingIntent fullScreenPi = PendingIntent.getActivity(
                this, 9101, fullScreenIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_CALL_ID)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(callerName)
                .setContentText(callType)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setFullScreenIntent(fullScreenPi, true)
                .setContentIntent(fullScreenPi);

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(9101, builder.build());
        }

        try {
            startActivity(fullScreenIntent);
        } catch (Exception ignored) {}
    }

    private void checkRecentMessages(String myNum) {
        String endpoint = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
                "/databases/(default)/documents/chats";
        String body = httpGet(endpoint);
        if (body.isEmpty() || !body.contains(""documents"")) return;

        Pattern docNamePattern = Pattern.compile("\"name\"\s*:\s*\"projects/" +
                Pattern.quote(PROJECT_ID) + "/databases/\(default\)/documents/chats/([^\"]+)\"");
        Matcher m = docNamePattern.matcher(body);
        while (m.find()) {
            String chatId = m.group(1);
            if (!chatId.contains(myNum)) continue;
            checkChatMessages(chatId, myNum);
        }
    }

    private void checkChatMessages(String chatId, String myNum) {
        String msgsUrl = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
                "/databases/(default)/documents/chats/" + chatId + "/messages";
        String msgsBody = httpGet(msgsUrl);
        if (msgsBody.isEmpty()) return;

        Pattern docPattern = Pattern.compile("\"name\"\s*:\s*\"[^\"]+/messages/([^\"]+)\"([\s\S]*?)(?=\"name\"\s*:\s*\"[^\"]+/messages/|$)");
        Matcher dm = docPattern.matcher(msgsBody);
        Set<String> currentIds = new HashSet<>();

        while (dm.find()) {
            String msgId = dm.group(1);
            String chunk = dm.group(2);
            currentIds.add(msgId);

            String senderNum = extractStringField(chunk, "senderGemixNum");
            String senderName = extractStringField(chunk, "senderName");
            String text = extractStringField(chunk, "text");
            String type = extractStringField(chunk, "type");

            if (initializedMessages && !seenMessageDocIds.contains(msgId) && !senderNum.equals(myNum) && !senderNum.isEmpty()) {
                String preview = !text.isEmpty() ? text : ("Sent a " + (type.isEmpty() ? "message" : type));
                showMessageNotification(senderName.isEmpty() ? ("ID " + senderNum) : senderName, preview, msgId.hashCode());
            }
        }

        seenMessageDocIds.clear();
        seenMessageDocIds.addAll(currentIds);
        initializedMessages = true;
    }

    private void showMessageNotification(String sender, String text, int notifId) {
        ensureChannels(this);
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, notifId, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_MSG_ID)
                .setSmallIcon(android.R.drawable.sym_action_chat)
                .setContentTitle(sender)
                .setContentText(text)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(pi);

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(Math.abs(notifId), builder.build());
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        if (gemixNum != null && !gemixNum.isEmpty()) {
            startService(getApplicationContext(), gemixNum, "");
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(pollRunnable);
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {}
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
