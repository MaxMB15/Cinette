// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

package app.cinette.mpv

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.media.AudioManager
import android.os.Build
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
import androidx.appcompat.app.AppCompatActivity

/** The Rust half of the plugin, in `src/android.rs`. */
object MpvNative {
    /**
     * Hands mpv a new surface, or none. mpv has let go of the old one when
     * this returns, so Android may release it.
     */
    @JvmStatic
    external fun surfaceChanged(surface: Surface?, width: Int, height: Int)

    /** Pauses the stream that plays, if one does. */
    @JvmStatic
    external fun pause()
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

    /**
     * Pauses when the HDMI output goes, as when the TV turns off or the
     * stick is unplugged from it, and Fire TV's test criteria ask. Playback
     * stays paused when it comes back. The broadcast is sticky, so the one
     * that arrives on registering only reports the current state.
     */
    private val hdmiReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (isInitialStickyBroadcast) return
            if (intent.getIntExtra(AudioManager.EXTRA_AUDIO_PLUG_STATE, 1) == 0) {
                MpvNative.pause()
            }
        }
    }

    override fun load(webView: WebView) {
        this.webView = webView
        val filter = IntentFilter(AudioManager.ACTION_HDMI_AUDIO_PLUG)
        // A system broadcast, which reaches a receiver that isn't exported.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(hdmiReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            activity.registerReceiver(hdmiReceiver, filter)
        }
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

    /**
     * Pauses when the app leaves the screen, as on Home. Android has already
     * taken the surface, and nothing plays in the background: there's no
     * media notification or MediaSession to control it from, and Fire TV
     * expects playback to stop. The player page shows it paused on return.
     */
    override fun onStop(activity: AppCompatActivity) {
        MpvNative.pause()
    }

    override fun onDestroy(activity: AppCompatActivity) {
        activity.unregisterReceiver(hdmiReceiver)
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
