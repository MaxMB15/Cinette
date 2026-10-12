// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useCallback, useRef, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MpvPlayerState } from "@/lib/types";
import {
	mpvLoad,
	mpvPlay,
	mpvPause,
	mpvStop,
	mpvSeek,
	mpvSetVolume,
	mpvGetState,
} from "@/lib/tauri";
import { readHwdecEnabled, readVolumePreference, writeVolumePreference } from "@/lib/player-prefs";
import { isOpeningStream } from "@/lib/stream-opening";
import { createChangeTracker } from "@/lib/change-tracker";

const DEFAULT_STATE: MpvPlayerState = {
	isPlaying: false,
	isPaused: false,
	currentUrl: null,
	volume: 100,
	position: 0,
	duration: 0,
	playbackStarted: false,
	openFailed: false,
};

export const useMpv = () => {
	const [state, setState] = useState<MpvPlayerState>(DEFAULT_STATE);
	const [error, setError] = useState<string | null>(null);
	const [fallbackActive, setFallbackActive] = useState(false);
	const [firstFrameReady, setFirstFrameReady] = useState(false);
	// Set only by the first-frame event. The mount check below also sets
	// `firstFrameReady`, but it can't tell a stream that's still opening from
	// one that's playing, so the spinner doesn't use it.
	const [firstFrameSeen, setFirstFrameSeen] = useState(false);
	// True while `mpvLoad` is in flight. Drives the "Opening stream" spinner
	// until the polled state describes the new load.
	const [loadPending, setLoadPending] = useState(false);
	// Goes up by one on every load, so the spinner starts over even when the
	// same URL is loaded again.
	const [loadId, setLoadId] = useState(0);
	// Set while the Rust-side reconnect monitor is re-issuing loadfile after
	// a network-induced EndFile(Error). Cleared on the matching `mpv://reconnected`
	// event or whenever the user starts a fresh load.
	const [reconnecting, setReconnecting] = useState(false);
	const [reconnectAttempt, setReconnectAttempt] = useState(0);
	// `buffering` reflects mpv's `paused-for-cache` flag with a short debounce
	// so brief stalls during startup / seeks don't flash the indicator.
	const [buffering, setBuffering] = useState(false);
	// Set to true when the Rust-side reconnect monitor has exhausted its
	// retry budget. Indicates the URL is genuinely unreachable (DNS failure,
	// server down, or the user is offline). Cleared on the next successful
	// load / explicit stop.
	const [loadFailed, setLoadFailed] = useState(false);
	// `recentlyRecovered` is an explicit positive-acknowledgement signal that
	// powers the green "Connection restored" banner. We drive it directly off
	// the `mpv://reconnected` event (and the navigator.onLine auto-recovery
	// path) rather than inferring it from "all flags are false now" because
	// the flag transitions don't always collapse to idle in one render tick:
	// e.g. when our `eof-reached` path triggered the retry, the demuxer EOF'd
	// before the cache "refilled" event, so `mpv://buffered` may never fire
	// and `buffering` stays stuck true — which would mask the recovered
	// transition under the old flag-inference logic.
	const [recentlyRecovered, setRecentlyRecovered] = useState(false);
	const bufferingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const recoveredTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flashRecovered = useCallback(() => {
		if (recoveredTimerRef.current) clearTimeout(recoveredTimerRef.current);
		setRecentlyRecovered(true);
		recoveredTimerRef.current = setTimeout(() => {
			setRecentlyRecovered(false);
			recoveredTimerRef.current = null;
		}, 2500);
	}, []);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const loadingRef = useRef(false);
	// The volume the user last chose this session, or the default volume from
	// Settings. mpv is recreated on every load and starts at 100, so this is
	// re-applied after each load to keep volume / mute consistent across
	// channel and episode switches. The preference outlives the hook: the
	// player can be left and reopened (remounting it) while the app runs.
	const [savedVolume] = useState(readVolumePreference);
	const userVolumeRef = useRef(savedVolume.volume);
	// Volume to restore when unmuting.
	const preMuteVolumeRef = useRef(savedVolume.preMute);
	const volumeRef = useRef(DEFAULT_STATE.volume);
	useEffect(() => {
		volumeRef.current = state.volume;
	}, [state.volume]);
	// Seeks and volume changes show at once. A poll that started before one
	// of them finished still has the old value, so it doesn't replace it.
	const [seeks] = useState(createChangeTracker);
	const [volumeChanges] = useState(createChangeTracker);

	// Listen for fallback event emitted when embedded renderer fails.
	useEffect(() => {
		const unlistenPromise = listen<{ reason: string }>("mpv://render-fallback", (event) => {
			console.warn("[useMpv] render fallback:", event.payload.reason);
			setFallbackActive(true);
		});
		return () => {
			unlistenPromise.then((fn) => fn());
		};
	}, []);

	// Listen for first-frame event so the frontend knows when the video is actually visible.
	useEffect(() => {
		const unlistenPromise = listen("mpv://first-frame", () => {
			setFirstFrameReady(true);
			// A frame that arrives while a load runs most likely comes from
			// the stream being replaced, so it doesn't end the new stream's
			// spinner. If it was the new stream's after all, the next poll's
			// playbackStarted ends the spinner instead.
			if (!loadingRef.current) setFirstFrameSeen(true);
		});
		return () => {
			unlistenPromise.then((fn) => fn());
		};
	}, []);

	// Listen for reconnect lifecycle events emitted by the Rust-side
	// auto-reconnect monitor (see crates/tauri-plugin-mpv/src/reconnect.rs).
	useEffect(() => {
		const reconnectingP = listen<{ url: string; attempt: number }>(
			"mpv://reconnecting",
			(event) => {
				console.warn(
					`[useMpv] reconnecting (attempt #${event.payload.attempt}):`,
					event.payload.url
				);
				setReconnecting(true);
				setReconnectAttempt(event.payload.attempt);
			}
		);
		const reconnectedP = listen<{ url: string }>("mpv://reconnected", (event) => {
			console.info("[useMpv] reconnected:", event.payload.url);
			setReconnecting(false);
			setReconnectAttempt(0);
			// Defensive: if our `eof-reached` path drove the retry, the
			// demuxer EOF'd while paused-for-cache was already false, so the
			// Rust monitor's "buffered" emission would never fire and
			// `buffering` would stay stuck true. Clear it explicitly here so
			// the recovered banner isn't masked by stale buffering state.
			setBuffering(false);
			if (bufferingTimerRef.current) {
				clearTimeout(bufferingTimerRef.current);
				bufferingTimerRef.current = null;
			}
			flashRecovered();
		});
		// Buffering lifecycle (paused-for-cache observation in Rust). Debounce
		// the "true" transition by 1.5 s so brief stalls during startup or seek
		// don't flash the connection-issues indicator.
		const bufferingP = listen<{ url: string }>("mpv://buffering", () => {
			if (bufferingTimerRef.current) clearTimeout(bufferingTimerRef.current);
			bufferingTimerRef.current = setTimeout(() => {
				console.warn("[useMpv] buffering (stream stalled)");
				setBuffering(true);
				bufferingTimerRef.current = null;
			}, 1500);
		});
		const bufferedP = listen<{ url: string }>("mpv://buffered", () => {
			if (bufferingTimerRef.current) {
				clearTimeout(bufferingTimerRef.current);
				bufferingTimerRef.current = null;
			}
			setBuffering(false);
		});
		const loadFailedP = listen<{ url: string }>("mpv://load-failed", (event) => {
			console.error("[useMpv] load failed (retries exhausted):", event.payload.url);
			setLoadFailed(true);
			setReconnecting(false);
			setReconnectAttempt(0);
			setBuffering(false);
			if (bufferingTimerRef.current) {
				clearTimeout(bufferingTimerRef.current);
				bufferingTimerRef.current = null;
			}
		});
		return () => {
			reconnectingP.then((fn) => fn());
			reconnectedP.then((fn) => fn());
			bufferingP.then((fn) => fn());
			bufferedP.then((fn) => fn());
			loadFailedP.then((fn) => fn());
			if (bufferingTimerRef.current) {
				clearTimeout(bufferingTimerRef.current);
				bufferingTimerRef.current = null;
			}
			if (recoveredTimerRef.current) {
				clearTimeout(recoveredTimerRef.current);
				recoveredTimerRef.current = null;
			}
		};
	}, [flashRecovered]);

	// On mount, check if mpv is already playing (e.g. user navigated away and back).
	// If so, restore firstFrameReady immediately so the background turns transparent.
	// Skip if a load was triggered during this mount cycle — the loadedThisMountRef
	// flag prevents a race where the async mpvGetState() resolves after load()
	// completes and incorrectly sets firstFrameReady before the first frame renders.
	const loadedThisMountRef = useRef(false);
	useEffect(() => {
		mpvGetState()
			.then((s) => {
				if (
					!loadingRef.current &&
					!loadedThisMountRef.current &&
					(s.isPlaying || s.isPaused)
				) {
					setFirstFrameReady(true);
				}
			})
			.catch(() => {});
	}, []);

	// Refs that mirror state so the `online` listener (registered once)
	// reads the latest values without re-binding on every poll.
	const loadFailedRef = useRef(false);
	const openFailedRef = useRef(false);
	const reconnectingRef = useRef(false);
	const currentUrlRef = useRef<string | null>(null);
	// The URL the last load asked for. The polled state still names the
	// previous stream while a load runs, and keeps naming it if the load
	// fails, so a retry reads this first.
	const requestedUrlRef = useRef<string | null>(null);
	// Sticky last-good position. We need this (rather than `state.position`)
	// for resume-on-recovery because during a Rust-side retry the polled
	// position can briefly drop to 0 as the new loadfile is initialising —
	// capturing the position at the moment of recovery would land us at
	// 00:00. `lastKnownPositionRef` only ever takes ON forward progress,
	// so an outage-time recovery sees the pre-outage position.
	const lastKnownPositionRef = useRef(0);
	// The stream stopped before it ever played, for example because the server
	// answered with an error. Reconnect and retries-exhausted states outrank it.
	const openFailed = state.openFailed && !reconnecting && !loadFailed;
	useEffect(() => {
		loadFailedRef.current = loadFailed;
	}, [loadFailed]);
	useEffect(() => {
		openFailedRef.current = openFailed;
	}, [openFailed]);
	useEffect(() => {
		reconnectingRef.current = reconnecting;
	}, [reconnecting]);
	useEffect(() => {
		currentUrlRef.current = state.currentUrl;
	}, [state.currentUrl]);
	useEffect(() => {
		if (state.position > 1.0) {
			lastKnownPositionRef.current = state.position;
		}
	}, [state.position]);

	// `load(url)` is a fresh start from 00:00 (used for channel switches /
	// initial play). `load(url, startPos)` is a resume — used by the
	// `online`-triggered auto-recovery and by the Retry button to preserve
	// playback position across a hard restart of the mpv instance.
	const load = useCallback(async (url: string, startPos?: number) => {
		if (loadingRef.current) return;
		loadingRef.current = true;
		loadedThisMountRef.current = true;
		requestedUrlRef.current = url;
		setLoadPending(true);
		setLoadId((id) => id + 1);
		setError(null);
		setFallbackActive(false);
		setFirstFrameReady(false);
		setFirstFrameSeen(false);
		setReconnecting(false);
		setReconnectAttempt(0);
		setBuffering(false);
		setLoadFailed(false);
		setRecentlyRecovered(false);
		if (bufferingTimerRef.current) {
			clearTimeout(bufferingTimerRef.current);
			bufferingTimerRef.current = null;
		}
		if (recoveredTimerRef.current) {
			clearTimeout(recoveredTimerRef.current);
			recoveredTimerRef.current = null;
		}
		// Fresh-start load resets the sticky position so a subsequent
		// recovery for this URL can't accidentally resume into a position
		// inherited from a previous channel.
		if (startPos === undefined) {
			lastKnownPositionRef.current = 0;
		}
		// Reset playing state and position immediately so the bar doesn't show stale values.
		setState((s) => ({
			...s,
			isPlaying: false,
			isPaused: false,
			position: startPos ?? 0,
			duration: 0,
			playbackStarted: false,
			openFailed: false,
		}));
		try {
			await mpvLoad(url, startPos, readHwdecEnabled());
			const userVolume = userVolumeRef.current;
			if (userVolume !== 100) {
				try {
					await mpvSetVolume(userVolume);
					setState((s) => ({ ...s, volume: userVolume }));
				} catch (e) {
					console.warn("[useMpv] re-applying volume failed:", e);
				}
			}
			// Don't set isPlaying optimistically — let the next poll confirm it from Rust
			// so transparency only kicks in once MPV is actually rendering frames.
			setState((s) => ({ ...s, currentUrl: url }));
		} catch (e) {
			const msg = String(e);
			setError(msg);
			throw e;
		} finally {
			loadingRef.current = false;
			setLoadPending(false);
		}
	}, []);

	/**
	 * Loads the current stream again from where it got to, for the Retry
	 * buttons and the recovery below. The resume point is the sticky
	 * last-known position rather than the polled one, which can read 0 while
	 * a fresh loadfile starts. A player reopened on a stream that kept playing
	 * hasn't loaded anything itself, so it falls back to the polled URL.
	 *
	 * Resolves to false when there was nothing to load, or a load was still
	 * running. The plugin runs one load at a time, so a second one would only
	 * queue behind it.
	 */
	const reload = useCallback(async (): Promise<boolean> => {
		const url = requestedUrlRef.current ?? currentUrlRef.current;
		if (!url || loadingRef.current) return false;
		const resumeAt = lastKnownPositionRef.current;
		await load(url, resumeAt > 1.0 ? resumeAt : undefined);
		return true;
	}, [load]);

	// Auto-recover when the OS reports the network came back online while
	// we're either parked in `loadFailed` OR actively `reconnecting`. The
	// Rust-side reconnect monitor sits on an exponential backoff between
	// attempts (up to 30 s); without this hook the red banner would stay up
	// for the full backoff window even though the user knows their internet
	// is already back. By calling `reload()` we hard-reset the mpv
	// instance immediately: the new load clears `reconnecting`/`loadFailed`
	// in the same tick, and `flashRecovered()` lights the green "Connection
	// restored" banner so the user gets positive confirmation.
	//
	// A stream that failed to open is retried too, but without the green
	// banner: it never played, and the spinner shows while it tries again.
	useEffect(() => {
		const handleOnline = () => {
			const neverOpened = openFailedRef.current;
			const needsRecover = loadFailedRef.current || reconnectingRef.current || neverOpened;
			if (needsRecover) {
				console.info(
					`[useMpv] online event (loadFailed=${loadFailedRef.current} reconnecting=${reconnectingRef.current} openFailed=${neverOpened}) — auto-recovering at pos=${lastKnownPositionRef.current.toFixed(2)}`
				);
				reload()
					.then((reloaded) => {
						if (reloaded && !neverOpened) flashRecovered();
					})
					.catch((e) => {
						console.warn("[useMpv] auto-recover load failed:", e);
					});
			}
		};
		window.addEventListener("online", handleOnline);
		return () => window.removeEventListener("online", handleOnline);
	}, [reload, flashRecovered]);

	const play = useCallback(async () => {
		console.log("[useMpv] play called");
		try {
			await mpvPlay();
			setState((s) => ({ ...s, isPlaying: true, isPaused: false }));
		} catch (e) {
			console.error("[useMpv] mpvPlay failed:", e);
		}
	}, []);

	const pause = useCallback(async () => {
		console.log("[useMpv] pause called");
		try {
			await mpvPause();
			setState((s) => ({ ...s, isPaused: true }));
		} catch (e) {
			console.error("[useMpv] mpvPause failed:", e);
		}
	}, []);

	const stop = useCallback(async () => {
		console.log("[useMpv] stop called");
		try {
			await mpvStop();
			requestedUrlRef.current = null;
			setState(DEFAULT_STATE);
		} catch (e) {
			console.error("[useMpv] mpvStop failed:", e);
		}
	}, []);

	const seek = useCallback(
		async (position: number) => {
			console.log("[useMpv] seek position=", position);
			// If the seek fails, the next poll puts the real position back.
			setState((s) => ({ ...s, position }));
			const done = seeks.begin();
			try {
				await mpvSeek(position);
			} catch (e) {
				console.error("[useMpv] mpvSeek failed:", e);
			} finally {
				done();
			}
		},
		[seeks]
	);

	const setVolume = useCallback(
		async (volume: number) => {
			console.log("[useMpv] setVolume volume=", volume);
			userVolumeRef.current = volume;
			volumeRef.current = volume;
			writeVolumePreference({ volume, preMute: preMuteVolumeRef.current });
			setState((s) => ({ ...s, volume }));
			const done = volumeChanges.begin();
			try {
				await mpvSetVolume(volume);
			} catch (e) {
				console.error("[useMpv] mpvSetVolume failed:", e);
			} finally {
				done();
			}
		},
		[volumeChanges]
	);

	// Mute is volume 0; unmuting restores the volume from before the mute.
	const toggleMute = useCallback(async () => {
		const current = volumeRef.current;
		if (current > 0) {
			preMuteVolumeRef.current = current;
			await setVolume(0);
		} else {
			await setVolume(preMuteVolumeRef.current > 0 ? preMuteVolumeRef.current : 100);
		}
	}, [setVolume]);

	// Read-only accessor for the sticky last-known position. Callers (e.g.
	// a source switch) should prefer this over `state.position` for resume
	// points across hard restarts — `state.position` is polled and can read 0
	// transiently if a fresh `loadfile` is in flight; `lastKnownPositionRef`
	// only ever takes ON forward progress, so it survives the retry window.
	const getLastKnownPosition = useCallback(() => lastKnownPositionRef.current, []);

	const refresh = useCallback(async () => {
		const seekMark = seeks.mark();
		const volumeMark = volumeChanges.mark();
		try {
			const s = await mpvGetState();
			console.debug("[useMpv] poll state:", JSON.stringify(s));
			// A poll that lands mid-load may describe the previous stream (or
			// none at all). Keep the reset state until the load returns.
			if (loadingRef.current) return;
			setState((prev) => ({
				isPlaying: s.isPlaying,
				isPaused: s.isPaused,
				currentUrl: s.currentUrl,
				volume: volumeChanges.isStale(volumeMark) ? prev.volume : s.volume,
				position: seeks.isStale(seekMark) ? prev.position : s.position,
				duration: s.duration,
				playbackStarted: s.playbackStarted,
				openFailed: s.openFailed,
			}));
		} catch (e) {
			console.warn("[useMpv] poll failed:", e);
		}
	}, [seeks, volumeChanges]);

	useEffect(() => {
		console.log("[useMpv] starting poll interval");
		refresh();
		pollRef.current = setInterval(refresh, 1000);
		return () => {
			console.log("[useMpv] clearing poll interval");
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, [refresh]);

	const opening = isOpeningStream({
		loadPending,
		currentUrl: state.currentUrl,
		playbackStarted: state.playbackStarted,
		firstFrameReady: firstFrameSeen,
		error,
		failed: loadFailed || openFailed,
		reconnecting,
	});

	return {
		state,
		error,
		fallbackActive,
		firstFrameReady,
		opening,
		loadId,
		reconnecting,
		reconnectAttempt,
		buffering,
		loadFailed,
		openFailed,
		recentlyRecovered,
		load,
		reload,
		getLastKnownPosition,
		play,
		pause,
		stop,
		seek,
		setVolume,
		toggleMute,
		refresh,
	};
};
