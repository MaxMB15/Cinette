package app.cinette

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // Back goes to the page, which closes its top layer or goes home first.
  // See onWebViewCreate.
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Hands Back to the page's `window.__cinetteBack` (src/hooks/useTvRemote.ts),
   * which answers true when it closed something or went home. When it answers
   * anything else, such as on the home page or before the page has loaded,
   * Android handles Back as usual and the app closes.
   */
  override fun onWebViewCreate(webView: WebView) {
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("window.__cinetteBack ? window.__cinetteBack() : false") { handled ->
          if (handled != "true") {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, callback)
  }
}
