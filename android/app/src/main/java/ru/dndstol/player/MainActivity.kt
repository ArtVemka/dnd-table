package ru.dndstol.player

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
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
import computer.iroh.IrohAndroid
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var tunnel: IrohTunnel

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
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
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
            lifecycleScope.launch(Dispatchers.IO) {
                val result = try {
                    val port = tunnel.start(ticket.trim())
                    JSONObject().put("ok", true).put("localPort", port)
                } catch (t: Throwable) {
                    JSONObject().put("ok", false).put("error", t.message ?: "Не удалось подключиться")
                }
                reply(id, result)
            }
        }

        @JavascriptInterface
        fun stopTunnel(id: String) {
            lifecycleScope.launch(Dispatchers.IO) {
                tunnel.shutdown()
                reply(id, JSONObject().put("ok", true))
            }
        }

        @JavascriptInterface
        fun openExternal(url: String) {
            this@MainActivity.openExternal(url)
        }
    }
}
