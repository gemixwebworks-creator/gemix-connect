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
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

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
        String key = "\"" + fieldName + "\"";
        int keyIdx = json.indexOf(key);
        if (keyIdx < 0) return "";
        int strKeyIdx = json.indexOf("\"stringValue\"", keyIdx + key.length());
        if (strKeyIdx < 0) return "";
        int colonIdx = json.indexOf(":", strKeyIdx + "\"stringValue\"".length());
        if (colonIdx < 0) return "";
        int firstQuote = json.indexOf("\"", colonIdx + 1);
        if (firstQuote < 0) return "";
        StringBuilder out = new StringBuilder();
        boolean escaped = false;
        for (int i = firstQuote + 1; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) {
                out.append(c);
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                break;
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private boolean extractBoolField(String json, String fieldName) {
        String key = "\"" + fieldName + "\"";
        int keyIdx = json.indexOf(key);
        if (keyIdx < 0) return false;
        int boolKeyIdx = json.indexOf("\"booleanValue\"", keyIdx + key.length());
        if (boolKeyIdx < 0) return false;
        String tail = json.substring(boolKeyIdx, Math.min(json.length(), boolKeyIdx + 40));
        return tail.contains("true");
    }

    private void checkIncomingCall(String targetNum) {
        String endpoint = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
                "/databases/(default)/documents/calls/" + targetNum;
        String body = httpGet(endpoint);
        if (body.isEmpty()) return;
        if (!body.contains("\"fields\"")) return;

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
        if (body.isEmpty()) return;
        if (!body.contains("\"documents\"")) return;

        String marker = "/documents/chats/";
        int pos = 0;
        while (pos < body.length()) {
            int idx = body.indexOf(marker, pos);
            if (idx < 0) break;
            int start = idx + marker.length();
            int endQuote = body.indexOf("\"", start);
            if (endQuote < 0) break;
            String chatId = body.substring(start, endQuote);
            pos = endQuote + 1;
            if (!chatId.contains("/") && chatId.contains(myNum)) {
                checkChatMessages(chatId, myNum);
            }
        }
    }

    private void checkChatMessages(String chatId, String myNum) {
        String msgsUrl = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
                "/databases/(default)/documents/chats/" + chatId + "/messages";
        String msgsBody = httpGet(msgsUrl);
        if (msgsBody.isEmpty()) return;

        String msgMarker = "/messages/";
        List<Integer> docStarts = new ArrayList<>();
        int searchFrom = 0;
        while (searchFrom < msgsBody.length()) {
            int mIdx = msgsBody.indexOf(msgMarker, searchFrom);
            if (mIdx < 0) break;
            int idStart = mIdx + msgMarker.length();
            int idEnd = msgsBody.indexOf("\"", idStart);
            if (idEnd < 0) break;
            docStarts.add(mIdx);
            searchFrom = idEnd + 1;
        }

        Set<String> currentIds = new HashSet<>();
        for (int i = 0; i < docStarts.size(); i++) {
            int startIdx = docStarts.get(i);
            int endIdx = (i + 1 < docStarts.size()) ? docStarts.get(i + 1) : msgsBody.length();
            String chunk = msgsBody.substring(startIdx, endIdx);

            int idStart = startIdx + msgMarker.length();
            int idEnd = msgsBody.indexOf("\"", idStart);
            if (idEnd < 0) continue;
            String msgId = msgsBody.substring(idStart, idEnd);
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
