// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

package app.cinette.mpv

import android.app.Activity
import android.graphics.Color
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** The Rust half of the plugin, in `src/android.rs`. */
object MpvNative {
    /**
     * Hands mpv a new surface, or none. mpv has let go of the old one when
     * this returns, so Android may release it.
     */
    @JvmStatic
    external fun surfaceChanged(surface: Surface?, width: Int, height: Int)
}

@InvokeArg
class FrameArgs {
    var x: Double = 0.0
    var y: Double = 0.0
    var width: Double = 0.0
    var height: Double = 0.0
}

@InvokeArg
class VisibleArgs {
    var visible: Boolean = false
}

@InvokeArg
class KeepScreenOnArgs {
    var on: Boolean = false
}

/**
 * Keeps a SurfaceView under the web view for mpv to draw into. The web view
 * turns transparent, and the page shows the video by leaving the player
 * area clear.
 */
@TauriPlugin
class MpvPlugin(private val activity: Activity) : Plugin(activity) {
    private var surfaceView: SurfaceView? = null
    private var webView: WebView? = null

    override fun load(webView: WebView) {
        this.webView = webView
        val parent = webView.parent as? ViewGroup ?: return
        val view = SurfaceView(activity)
        view.holder.addCallback(object : SurfaceHolder.Callback {
            // surfaceChanged always follows with the size.
            override fun surfaceCreated(holder: SurfaceHolder) {}

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                MpvNative.surfaceChanged(holder.surface, width, height)
            }

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                MpvNative.surfaceChanged(null, 0, 0)
            }
        })
        // A hidden view has no surface. A load shows it.
        view.visibility = View.GONE
        parent.addView(view, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView.setBackgroundColor(Color.TRANSPARENT)
        surfaceView = view
    }

    /** Moves the view to a rect in the page's CSS pixels. */
    @Command
    fun setFrame(invoke: Invoke) {
        val args = invoke.parseArgs(FrameArgs::class.java)
        activity.runOnUiThread {
            val view = surfaceView
            val web = webView
            if (view != null && web != null) {
                val density = activity.resources.displayMetrics.density
                val params = view.layoutParams
                params.width = Math.round(args.width * density).toInt().coerceAtLeast(1)
                params.height = Math.round(args.height * density).toInt().coerceAtLeast(1)
                view.layoutParams = params
                view.x = web.x + (args.x * density).toFloat()
                view.y = web.y + (args.y * density).toFloat()
            }
            invoke.resolve()
        }
    }

    /** Shows or hides the view. Hiding it destroys its surface. */
    @Command
    fun setVisible(invoke: Invoke) {
        val args = invoke.parseArgs(VisibleArgs::class.java)
        activity.runOnUiThread {
            surfaceView?.visibility = if (args.visible) View.VISIBLE else View.GONE
            invoke.resolve()
        }
    }

    /** Keeps the screen on, and a TV's screensaver off, while a stream plays. */
    @Command
    fun setKeepScreenOn(invoke: Invoke) {
        val args = invoke.parseArgs(KeepScreenOnArgs::class.java)
        activity.runOnUiThread {
            if (args.on) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            invoke.resolve()
        }
    }
}
