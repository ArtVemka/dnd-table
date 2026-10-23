package ru.dndstol.player

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions
import computer.iroh.IrohAndroid
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var tunnel: IrohTunnel
    private var pendingScanId: String? = null

    private val scanLauncher = registerForActivityResult(ScanContract()) { result: ScanIntentResult ->
        val id = pendingScanId
        pendingScanId = null
        if (id != null) {
            val contents = result.contents
            val payload = if (contents.isNullOrBlank()) {
                JSONObject().put("ok", false).put("error", "QR-код не распознан")
            } else {
                JSONObject().put("ok", true).put("text", contents)
            }
            reply(id, payload)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        IrohAndroid.installAndroidContext(applicationContext)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        tunnel = IrohTunnel(lifecycleScope)

        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = true
                allowContentAccess = false
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                // Без этого WebView игнорирует meta viewport и раскладывает
                // страницу шире экрана: правый край чата уезжает за границу.
                useWideViewPort = true
                loadWithOverviewMode = false
            }
            addJavascriptInterface(Bridge(), "Android")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (url.scheme == "file" || url.host == "127.0.0.1" || url.host == "localhost") {
                        return false
                    }
                    openExternal(url.toString())
                    return true
                }
            }
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        setContentView(webView)
        // Android 15 рисует приложение под системными панелями. Отступаем их,
        // иначе кнопки главного экрана уезжают под строку состояния.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        webView.loadUrl("file:///android_asset/renderer/index.html")

        // Уведомление нужно службе, которая держит соединение в фоне. Если
        // игрок откажет, служба всё равно работает, просто без строки в шторке.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onDestroy() {
        TunnelService.stop(this)
        tunnel.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        webView.evaluateJavascript("window.dndAndroidBack && window.dndAndroidBack()") { result ->
            if (result != "true") finish()
        }
    }

    private fun openExternal(url: String) {
        runOnUiThread {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: Throwable) {
                // Нет браузера: ссылка просто не откроется.
            }
        }
    }

    private fun reply(id: String, payload: JSONObject) {
        val idJson = JSONObject.quote(id)
        val payloadJson = JSONObject.quote(payload.toString())
        runOnUiThread {
            webView.evaluateJavascript("window.__androidResult($idJson, $payloadJson)", null)
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun joinP2p(id: String, ticket: String) {
            // Службу поднимаем до туннеля, пока приложение точно на переднем
            // плане: Android 12+ не разрешает стартовать её из фона.
            runOnUiThread {
                runCatching { TunnelService.start(this@MainActivity) }
            }
            lifecycleScope.launch(Dispatchers.IO) {
                val result = try {
                    val port = tunnel.start(ticket.trim())
                    JSONObject().put("ok", true).put("localPort", port)
                } catch (t: Throwable) {
                    runCatching { TunnelService.stop(this@MainActivity) }
                    JSONObject().put("ok", false).put("error", t.message ?: "Не удалось подключиться")
                }
                reply(id, result)
            }
        }

        @JavascriptInterface
        fun stopTunnel(id: String) {
            lifecycleScope.launch(Dispatchers.IO) {
                tunnel.shutdown()
                runCatching { TunnelService.stop(this@MainActivity) }
                reply(id, JSONObject().put("ok", true))
            }
        }

        @JavascriptInterface
        fun readClipboard(id: String) {
            runOnUiThread {
                val text = try {
                    val manager = getSystemService(ClipboardManager::class.java)
                    manager?.primaryClip
                        ?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)
                        ?.coerceToText(this@MainActivity)
                        ?.toString()
                } catch (_: Throwable) {
                    null
                }
                val result = if (text.isNullOrBlank()) {
                    JSONObject().put("ok", false).put("error", "Буфер обмена пуст")
                } else {
                    JSONObject().put("ok", true).put("text", text)
                }
                reply(id, result)
            }
        }

        @JavascriptInterface
        fun scanQr(id: String) {
            runOnUiThread {
                if (pendingScanId != null) {
                    reply(id, JSONObject().put("ok", false).put("error", "Сканер уже открыт"))
                    return@runOnUiThread
                }
                pendingScanId = id
                try {
                    val options = ScanOptions()
                    options.setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    options.setPrompt("Наведите камеру на QR-код билета")
                    options.setBeepEnabled(false)
                    options.setOrientationLocked(false)
                    scanLauncher.launch(options)
                } catch (t: Throwable) {
                    pendingScanId = null
                    reply(id, JSONObject().put("ok", false).put("error", t.message ?: "Не удалось открыть сканер"))
                }
            }
        }

        @JavascriptInterface
        fun openExternal(url: String) {
            this@MainActivity.openExternal(url)
        }
    }
}
