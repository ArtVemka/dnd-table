package ru.dndstol.player

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Держит процесс живым, пока игрок за столом.
 *
 * Без foreground service Android может выгрузить приложение в фоне и оборвать
 * iroh-туннель посреди сцены. Сам туннель остаётся в Activity; служба лишь не
 * даёт системе убить процесс, пока игрок не вышел из-за стола.
 */
class TunnelService : Service() {
    companion object {
        private const val CHANNEL_ID = "dnd-table-session"
        private const val NOTIFICATION_ID = 7

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, TunnelService::class.java)
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TunnelService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Стол",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Соединение с мастером во время игры"
            setShowBadge(false)
        }
        manager?.createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("D&D Стол")
            .setContentText("Вы за столом, соединение с мастером активно")
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        startForeground(NOTIFICATION_ID, notification)
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
