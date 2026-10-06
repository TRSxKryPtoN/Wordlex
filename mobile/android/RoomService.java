// Keeps a Wordlex room alive while the app is in the background (in "recents") or the
// screen is off. Android may freeze an app that is not on screen; a foreground service
// with a small notification tells it the app is still in use.
//
// Started and stopped by LocalRoomPlugin.keepAwake(). Needs the <service> entry and the
// FOREGROUND_SERVICE permissions in AndroidManifest.xml (see MOBILE.md).
package com.example.wordlex;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

public class RoomService extends Service {

    private static final String CHANNEL = "wordlex_room";
    private static final int NOTE_ID = 4780;
    private static final long MAX_HOLD_MS = 3L * 60L * 60L * 1000L; // never hold the phone awake longer

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            Notification note = buildNotification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTE_ID, note);
            }
            holdLocks();
        } catch (Exception e) {
            // Not allowed on this phone: the game still works, it just pauses in the background.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel =
                new NotificationChannel(CHANNEL, "Game room", NotificationManager.IMPORTANCE_LOW);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("Wordlex room is open")
            .setContentText("Tap to return to the game")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(tap)
            .build();
    }

    private void holdLocks() {
        try {
            if (wakeLock == null) {
                PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (power != null) {
                    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wordlex:room");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null) wakeLock.acquire(MAX_HOLD_MS);
            if (wifiLock == null) {
                WifiManager wifi =
                    (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "wordlex:room");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null) wifiLock.acquire();
        } catch (Exception ignored) {
            // locks are a bonus; the service alone already helps
        }
    }

    @Override
    public void onDestroy() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {
            // nothing to do
        }
        super.onDestroy();
    }

    /** The app was swiped away from recents: the room cannot continue, so stop cleanly. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }
}
