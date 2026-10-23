package app.cinette

import android.os.Bundle
import android.system.Os
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // Back goes to the page first. See onWebViewCreate.
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    useCacheForTemporaryFiles()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Android sets no TMPDIR, so Rust's `std::env::temp_dir()`, and every
   * crate that uses it, gets /data/local/tmp, which apps can't write. This
   * points it at the app's cache folder. It runs before `super.onCreate`
   * loads the Rust library and starts its threads, and only sets the
   * variable when it differs, so a later activity never writes it while
   * Rust may be reading it.
   */
  private fun useCacheForTemporaryFiles() {
    val dir = cacheDir.absolutePath
    if (Os.getenv("TMPDIR") != dir) Os.setenv("TMPDIR", dir, true)
  }

  /**
   * Hands Back to the page's `window.__cinetteBack` (src/hooks/useTvRemote.ts),
   * which only the TV layout sets. It answers true when it closed something or
   * went home, and false on the home page, where the app closes.
   *
   * Without it, on phones and tablets or before the page has loaded, Back does
   * what Tauri's own handling does: it goes back in the page's history, and
   * closes the app when there's none.
   */
  override fun onWebViewCreate(webView: WebView) {
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("window.__cinetteBack ? window.__cinetteBack() : null") { answer ->
          when (answer) {
            "true" -> {}
            "false" -> closeAsUsual()
            else -> if (webView.canGoBack()) webView.goBack() else closeAsUsual()
          }
        }
      }

      /** Lets Android handle Back, which closes the app. */
      private fun closeAsUsual() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    }
    onBackPressedDispatcher.addCallback(this, callback)
  }
}
