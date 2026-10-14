// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Mock Tauri event listener
const mockListenCallbacks = new Map<string, (event: unknown) => void>();
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((eventName: string, callback: (event: unknown) => void) => {
		mockListenCallbacks.set(eventName, callback);
		const unlisten = vi.fn();
		return Promise.resolve(unlisten);
	}),
}));

// Defaults are the mocks' own implementations, so `vi.resetAllMocks()` before
// each test puts them back after a test overrides one.
vi.mock("@/lib/tauri", () => ({
	mpvLoad: vi.fn(async () => {}),
	mpvPlay: vi.fn(async () => {}),
	mpvPause: vi.fn(async () => {}),
	mpvStop: vi.fn(async () => {}),
	mpvSeek: vi.fn(async () => {}),
	mpvSetVolume: vi.fn(async () => {}),
	mpvGetState: vi.fn(async () => ({
		isPlaying: false,
		isPaused: false,
		currentUrl: null,
		volume: 100,
		position: 0,
		duration: 0,
		playbackStarted: false,
		openFailed: false,
		reachedEnd: false,
		waiting: false,
		fallbackActive: false,
	})),
}));

import {
	mpvLoad,
	mpvPlay,
	mpvPause,
	mpvStop,
	mpvSeek,
	mpvSetVolume,
	mpvGetState,
} from "@/lib/tauri";
import { listen } from "@tauri-apps/api/event";
import { deferred } from "@/test/deferred";
import { useMpv } from "./useMpv";

const mockMpvLoad = vi.mocked(mpvLoad);
const mockMpvPlay = vi.mocked(mpvPlay);
const mockMpvPause = vi.mocked(mpvPause);
const mockMpvStop = vi.mocked(mpvStop);
const mockMpvSeek = vi.mocked(mpvSeek);
const mockMpvSetVolume = vi.mocked(mpvSetVolume);
const mockMpvGetState = vi.mocked(mpvGetState);

describe("useMpv", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockListenCallbacks.clear();
		sessionStorage.clear();
		localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── Initial state ─────────────────────────────────────────────────

	it("returns default state on mount", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		expect(result.current.state).toEqual({
			isPlaying: false,
			isPaused: false,
			currentUrl: null,
			volume: 100,
			position: 0,
			duration: 0,
			playbackStarted: false,
			openFailed: false,
			reachedEnd: false,
			waiting: false,
			fallbackActive: false,
			positionAt: expect.any(Number),
		});
		expect(result.current.error).toBeNull();
		expect(result.current.fallbackActive).toBe(false);
		expect(result.current.firstFrameReady).toBe(false);
	});

	it("restores firstFrameReady when already playing on mount", async () => {
		mockMpvGetState.mockResolvedValue({
			isPlaying: true,
			isPaused: false,
			currentUrl: "http://stream.url",
			volume: 80,
			position: 30,
			duration: 120,
		} as never);

		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(result.current.firstFrameReady).toBe(true));
	});

	// ── load ──────────────────────────────────────────────────────────

	it("calls mpvLoad and updates currentUrl", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.load("http://stream.url");
		});

		expect(mockMpvLoad).toHaveBeenCalledWith("http://stream.url", undefined, true, false);
		expect(result.current.state.currentUrl).toBe("http://stream.url");
	});

	it("prevents double-load while loading", async () => {
		let resolveLoad: () => void;
		mockMpvLoad.mockImplementation(
			() =>
				new Promise<void>((r) => {
					resolveLoad = r;
				})
		);

		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		// Start first load
		let loadPromise: Promise<void>;
		act(() => {
			loadPromise = result.current.load("http://first.url");
		});

		// Try second load while first is in progress
		await act(async () => {
			await result.current.load("http://second.url");
		});

		// Only one call should have been made
		expect(mockMpvLoad).toHaveBeenCalledTimes(1);
		expect(mockMpvLoad).toHaveBeenCalledWith("http://first.url", undefined, true, false);

		// Resolve first load
		await act(async () => {
			resolveLoad!();
			await loadPromise!;
		});
	});

	it("sets error on load failure", async () => {
		mockMpvLoad.mockRejectedValue(new Error("codec not found"));

		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		let caught: Error | null = null;
		await act(async () => {
			try {
				await result.current.load("http://bad.url");
			} catch (e) {
				caught = e as Error;
			}
		});

		expect((caught as Error | null)?.message).toBe("codec not found");
		expect(result.current.error).toContain("codec not found");
	});

	it("resets state immediately when load is called", async () => {
		// Start from a video the poll reports held on its last frame, while
		// mpv waits for more of it.
		mockMpvGetState.mockResolvedValue({
			isPlaying: false,
			isPaused: true,
			currentUrl: "http://old.url",
			volume: 80,
			position: 120,
			duration: 120,
			reachedEnd: true,
			waiting: true,
		} as never);

		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(result.current.state.reachedEnd).toBe(true));
		expect(result.current.state.waiting).toBe(true);

		// Now load resets position/duration immediately
		mockMpvLoad.mockResolvedValue(undefined);
		vi.spyOn(performance, "now").mockReturnValue(4321);
		await act(async () => {
			await result.current.load("http://new.url");
		});

		expect(result.current.state.position).toBe(0);
		expect(result.current.state.positionAt).toBe(4321);
		expect(result.current.state.waiting).toBe(false);
		expect(result.current.state.duration).toBe(0);
		expect(result.current.state.reachedEnd).toBe(false);
		expect(result.current.firstFrameReady).toBe(false);
	});

	// ── play / pause / stop ───────────────────────────────────────────

	it("play calls mpvPlay and sets isPlaying optimistically", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.play();
		});

		expect(mockMpvPlay).toHaveBeenCalledTimes(1);
		expect(result.current.state.isPlaying).toBe(true);
		expect(result.current.state.isPaused).toBe(false);
	});

	it("pause calls mpvPause and sets isPaused", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.pause();
		});

		expect(mockMpvPause).toHaveBeenCalledTimes(1);
		expect(result.current.state.isPaused).toBe(true);
	});

	it("stop resets all state to defaults", async () => {
		mockMpvGetState.mockResolvedValue({
			isPlaying: true,
			isPaused: false,
			currentUrl: "http://stream.url",
			volume: 80,
			position: 45,
			duration: 120,
		} as never);

		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(result.current.state.isPlaying).toBe(true));

		await act(async () => {
			await result.current.stop();
		});

		expect(mockMpvStop).toHaveBeenCalledTimes(1);
		expect(result.current.state).toEqual({
			isPlaying: false,
			isPaused: false,
			currentUrl: null,
			volume: 100,
			position: 0,
			duration: 0,
			playbackStarted: false,
			openFailed: false,
			reachedEnd: false,
			waiting: false,
			fallbackActive: false,
			positionAt: expect.any(Number),
		});
	});

	// ── seek / volume ─────────────────────────────────────────────────

	it("seek calls mpvSeek with position and updates state", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.seek(42.5);
		});

		expect(mockMpvSeek).toHaveBeenCalledWith(42.5);
		expect(result.current.state.position).toBe(42.5);
	});

	it("setVolume calls mpvSetVolume and updates state", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.setVolume(75);
		});

		expect(mockMpvSetVolume).toHaveBeenCalledWith(75);
		expect(result.current.state.volume).toBe(75);
	});

	describe("polls that cross a seek or volume change", () => {
		const playingAt = (position: number, volume = 100, waiting = false) =>
			({
				isPlaying: true,
				isPaused: false,
				currentUrl: "http://vod.url",
				volume,
				position,
				duration: 1800,
				playbackStarted: true,
				openFailed: false,
				reachedEnd: false,
				waiting,
			}) as never;

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("times each position it reads", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			vi.spyOn(performance, "now").mockReturnValue(1234);
			mockMpvGetState.mockResolvedValueOnce(playingAt(120));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.state.position).toBe(120);
			expect(result.current.state.positionAt).toBe(1234);
		});

		it("says when mpv waits for more of the stream", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			mockMpvGetState.mockResolvedValueOnce(playingAt(120, 100, true));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.state.waiting).toBe(true);
		});

		it("shows the seek position before mpv confirms it", async () => {
			const seekCall = deferred<void>();
			mockMpvSeek.mockReturnValueOnce(seekCall.promise);
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			let seekDone: Promise<void>;
			act(() => {
				seekDone = result.current.seek(600);
			});
			expect(result.current.state.position).toBe(600);

			await act(async () => {
				seekCall.resolve();
				await seekDone!;
			});
		});

		it("keeps the seek position when an older poll lands after the seek", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			const oldPoll = deferred<never>();
			mockMpvGetState.mockReturnValueOnce(oldPoll.promise);
			let pollDone: Promise<void>;
			act(() => {
				pollDone = result.current.refresh();
			});
			await act(async () => {
				await result.current.seek(600);
			});
			await act(async () => {
				oldPoll.resolve(playingAt(120));
				await pollDone!;
			});
			expect(result.current.state.position).toBe(600);
			// Everything else in the poll is still taken.
			expect(result.current.state.duration).toBe(1800);

			mockMpvGetState.mockResolvedValueOnce(playingAt(601));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.state.position).toBe(601);
		});

		it("keeps the seek position when a poll lands while the seek runs", async () => {
			const seekCall = deferred<void>();
			mockMpvSeek.mockReturnValueOnce(seekCall.promise);
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			const now = vi.spyOn(performance, "now").mockReturnValue(500);
			let seekDone: Promise<void>;
			act(() => {
				seekDone = result.current.seek(600);
			});
			expect(result.current.state.positionAt).toBe(500);
			now.mockReturnValue(900);
			mockMpvGetState.mockResolvedValueOnce(playingAt(120));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.state.position).toBe(600);
			// The position is still the one set at the seek.
			expect(result.current.state.positionAt).toBe(500);

			await act(async () => {
				seekCall.resolve();
				await seekDone!;
			});
		});

		it("takes the polled position again after a failed seek", async () => {
			mockMpvSeek.mockRejectedValueOnce(new Error("no stream"));
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			await act(async () => {
				await result.current.seek(600);
			});
			mockMpvGetState.mockResolvedValueOnce(playingAt(120));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.state.position).toBe(120);
		});

		it("keeps a new volume when an older poll lands after the change", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			const oldPoll = deferred<never>();
			mockMpvGetState.mockReturnValueOnce(oldPoll.promise);
			let pollDone: Promise<void>;
			act(() => {
				pollDone = result.current.refresh();
			});
			await act(async () => {
				await result.current.setVolume(40);
			});
			await act(async () => {
				oldPoll.resolve(playingAt(130, 100));
				await pollDone!;
			});
			expect(result.current.state.volume).toBe(40);
			// The position isn't held back by a volume change.
			expect(result.current.state.position).toBe(130);
		});
	});

	it("toggleMute mutes and restores the previous volume", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.setVolume(60);
		});
		await act(async () => {
			await result.current.toggleMute();
		});
		expect(mockMpvSetVolume).toHaveBeenLastCalledWith(0);
		expect(result.current.state.volume).toBe(0);

		await act(async () => {
			await result.current.toggleMute();
		});
		expect(mockMpvSetVolume).toHaveBeenLastCalledWith(60);
		expect(result.current.state.volume).toBe(60);
	});

	it("re-applies the user's volume after a load", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.setVolume(40);
		});
		mockMpvSetVolume.mockClear();
		await act(async () => {
			await result.current.load("http://test/next.m3u8");
		});
		expect(mockMpvSetVolume).toHaveBeenCalledWith(40);
		expect(result.current.state.volume).toBe(40);
	});

	it("does not touch volume on load when the user never changed it", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.load("http://test/next.m3u8");
		});
		expect(mockMpvSetVolume).not.toHaveBeenCalled();
	});

	it("starts at the default volume from Settings", async () => {
		localStorage.setItem("mvp_default_volume", "60");
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.load("http://test/next.m3u8");
		});
		expect(mockMpvSetVolume).toHaveBeenCalledWith(60);
	});

	it("passes the hardware decoding setting to mpvLoad", async () => {
		localStorage.setItem("mvp_hwdec", "off");
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.load("http://test/next.m3u8");
		});
		expect(mockMpvLoad).toHaveBeenCalledWith("http://test/next.m3u8", undefined, false, false);
	});

	it("keeps the volume and mute state when the player is reopened", async () => {
		const first = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
		await act(async () => {
			await first.result.current.setVolume(40);
		});
		await act(async () => {
			await first.result.current.toggleMute();
		});
		first.unmount();

		mockMpvSetVolume.mockClear();
		const { result } = renderHook(() => useMpv());
		await act(async () => {
			await result.current.load("http://test/next.m3u8");
		});
		expect(mockMpvSetVolume).toHaveBeenCalledWith(0);

		await act(async () => {
			await result.current.toggleMute();
		});
		expect(mockMpvSetVolume).toHaveBeenLastCalledWith(40);
	});

	// ── Tauri events ──────────────────────────────────────────────────

	it("sets fallbackActive when render-fallback event fires", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		const callback = mockListenCallbacks.get("mpv://render-fallback");
		expect(callback).toBeDefined();

		act(() => {
			callback!({ payload: { reason: "OpenGL failed" } });
		});

		expect(result.current.fallbackActive).toBe(true);
	});

	describe("the fallback window", () => {
		const reporting = (fallbackActive: boolean, currentUrl: string | null = "http://s") =>
			({
				isPlaying: true,
				isPaused: false,
				currentUrl,
				volume: 100,
				position: 5,
				duration: 0,
				playbackStarted: true,
				openFailed: false,
				reachedEnd: false,
				waiting: false,
				fallbackActive,
			}) as never;

		const fallBack = () =>
			mockListenCallbacks.get("mpv://render-fallback")!({ payload: { reason: "no GL" } });

		it("is known to a player reopened on it", async () => {
			mockMpvGetState.mockResolvedValue(reporting(true));
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(result.current.fallbackActive).toBe(true));
		});

		it("is cleared by a load, until the plugin reports it again", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			act(fallBack);
			expect(result.current.fallbackActive).toBe(true);

			await act(async () => {
				await result.current.load("http://s");
			});
			expect(result.current.fallbackActive).toBe(false);

			mockMpvGetState.mockResolvedValue(reporting(true));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.fallbackActive).toBe(true);
		});

		it("isn't undone by a poll sent before the load returned", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			const poll = deferred<never>();
			mockMpvGetState.mockReturnValueOnce(poll.promise);
			let refreshed: Promise<void>;
			act(() => {
				refreshed = result.current.refresh();
			});
			mockMpvLoad.mockImplementation(async () => fallBack());
			await act(async () => {
				await result.current.load("http://s");
			});
			expect(result.current.fallbackActive).toBe(true);

			await act(async () => {
				poll.resolve(reporting(false));
				await refreshed!;
			});
			expect(result.current.fallbackActive).toBe(true);
		});

		describe("closing it", () => {
			const closeWindow = (url: string) =>
				act(() => mockListenCallbacks.get("mpv://window-closed")!({ payload: { url } }));

			it("is counted for the stream the player loaded", async () => {
				const { result } = renderHook(() => useMpv());
				await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
				await act(async () => {
					await result.current.load("http://s");
				});

				closeWindow("http://s");
				expect(result.current.windowClosedId).toBe(1);
				closeWindow("http://s");
				expect(result.current.windowClosedId).toBe(2);
			});

			it("is counted on a player reopened on the stream", async () => {
				mockMpvGetState.mockResolvedValue(reporting(true, "http://s"));
				const { result } = renderHook(() => useMpv());
				await waitFor(() => expect(result.current.state.currentUrl).toBe("http://s"));

				closeWindow("http://s");
				expect(result.current.windowClosedId).toBe(1);
			});

			it("is counted on a reopened player before its first poll", async () => {
				const poll = deferred<never>();
				mockMpvGetState.mockReturnValue(poll.promise);
				const { result } = renderHook(() => useMpv());
				await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

				closeWindow("http://s");
				expect(result.current.windowClosedId).toBe(1);
			});

			it("is counted on a reopened player after a poll of the stopped player", async () => {
				mockMpvGetState.mockResolvedValue(reporting(true, "http://s"));
				const { result } = renderHook(() => useMpv());
				await waitFor(() => expect(result.current.state.currentUrl).toBe("http://s"));
				mockMpvGetState.mockResolvedValue(reporting(false, null));
				await act(async () => {
					await result.current.refresh();
				});
				expect(result.current.state.currentUrl).toBeNull();

				closeWindow("http://other");
				expect(result.current.windowClosedId).toBe(0);
				closeWindow("http://s");
				expect(result.current.windowClosedId).toBe(1);
			});

			it("is ignored for another stream", async () => {
				const { result } = renderHook(() => useMpv());
				await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
				await act(async () => {
					await result.current.load("http://s");
				});

				closeWindow("http://other");
				expect(result.current.windowClosedId).toBe(0);
			});

			it("is ignored while a load replaces the player", async () => {
				const loading = deferred();
				mockMpvLoad.mockReturnValue(loading.promise);
				const { result } = renderHook(() => useMpv());
				await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
				let loaded: Promise<void>;
				act(() => {
					loaded = result.current.load("http://s");
				});

				closeWindow("http://s");
				await act(async () => {
					loading.resolve();
					await loaded!;
				});
				expect(result.current.windowClosedId).toBe(0);
			});

			it("stops being listened for when the player page closes", async () => {
				const { unmount } = renderHook(() => useMpv());
				await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
				const mockListen = vi.mocked(listen);
				const index = mockListen.mock.calls.findIndex(
					([name]) => name === "mpv://window-closed"
				);
				const unlisten = await mockListen.mock.results[index]!.value;
				expect(unlisten).not.toHaveBeenCalled();

				unmount();
				await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
			});
		});
	});

	it("sets firstFrameReady when first-frame event fires", async () => {
		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		const callback = mockListenCallbacks.get("mpv://first-frame");
		expect(callback).toBeDefined();

		act(() => {
			callback!({});
		});

		expect(result.current.firstFrameReady).toBe(true);
	});

	// ── Error resilience ──────────────────────────────────────────────

	it("play does not throw when mpvPlay fails", async () => {
		mockMpvPlay.mockRejectedValue(new Error("play failed"));

		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		// Should not throw
		await act(async () => {
			await result.current.play();
		});
	});

	it("pause does not throw when mpvPause fails", async () => {
		mockMpvPause.mockRejectedValue(new Error("pause failed"));

		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		await act(async () => {
			await result.current.pause();
		});
	});

	it("poll failure does not crash the hook", async () => {
		// First call succeeds (initial), then next poll fails
		mockMpvGetState
			.mockResolvedValueOnce({
				isPlaying: false,
				isPaused: false,
				currentUrl: null,
				volume: 100,
				position: 0,
				duration: 0,
			} as never)
			.mockRejectedValueOnce(new Error("poll failed"));

		const { result } = renderHook(() => useMpv());
		await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

		// Hook should still be usable
		expect(result.current.state).toBeDefined();
	});

	// ── Opening spinner ───────────────────────────────────────────────

	describe("opening a stream", () => {
		// What the plugin reports for a live stream that's loading: mpv is
		// unpaused with a URL, so isPlaying is already true, and duration stays 0.
		const polled = (overrides: Record<string, unknown> = {}) =>
			({
				isPlaying: true,
				isPaused: false,
				currentUrl: "http://live.url",
				volume: 100,
				position: 0,
				duration: 0,
				playbackStarted: false,
				openFailed: false,
				reachedEnd: false,
				fallbackActive: false,
				...overrides,
			}) as never;

		const loadAndWait = async (result: { current: ReturnType<typeof useMpv> }) => {
			mockMpvLoad.mockResolvedValue(undefined);
			mockMpvGetState.mockResolvedValue(polled());
			await act(async () => {
				await result.current.load("http://live.url");
			});
			await act(async () => {
				await result.current.refresh();
			});
		};

		it("shows from the start of a load until the plugin reports playback", async () => {
			let resolveLoad: () => void;
			mockMpvLoad.mockImplementation(
				() =>
					new Promise<void>((r) => {
						resolveLoad = r;
					})
			);

			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			expect(result.current.opening).toBe(false);

			let loadPromise: Promise<void>;
			act(() => {
				loadPromise = result.current.load("http://live.url");
			});
			expect(result.current.opening).toBe(true);

			mockMpvGetState.mockResolvedValue(polled());
			await act(async () => {
				resolveLoad!();
				await loadPromise!;
			});
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.opening).toBe(true);

			mockMpvGetState.mockResolvedValue(polled({ position: 0.4, playbackStarted: true }));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.opening).toBe(false);
		});

		it("hides on the first-frame event before the next poll", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			await loadAndWait(result);
			expect(result.current.opening).toBe(true);

			act(() => {
				mockListenCallbacks.get("mpv://first-frame")!({ payload: null });
			});
			expect(result.current.opening).toBe(false);
		});

		it("keeps showing when the user pauses before the first frame", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			await loadAndWait(result);

			await act(async () => {
				await result.current.pause();
			});
			// mpv goes on opening the stream while paused.
			expect(result.current.opening).toBe(true);

			mockMpvGetState.mockResolvedValue(
				polled({ isPlaying: false, isPaused: true, playbackStarted: true })
			);
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.opening).toBe(false);
		});

		it("ignores a first-frame event that arrives while a load is in flight", async () => {
			let resolveLoad: () => void;
			mockMpvLoad.mockImplementation(
				() =>
					new Promise<void>((r) => {
						resolveLoad = r;
					})
			);
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			let loadPromise: Promise<void>;
			act(() => {
				loadPromise = result.current.load("http://live.url");
			});
			// A late frame from the stream being replaced.
			act(() => {
				mockListenCallbacks.get("mpv://first-frame")!({ payload: null });
			});

			mockMpvGetState.mockResolvedValue(polled());
			await act(async () => {
				resolveLoad!();
				await loadPromise!;
			});
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.opening).toBe(true);
		});

		it("hides when the user stops", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			await loadAndWait(result);

			await act(async () => {
				await result.current.stop();
			});
			expect(result.current.opening).toBe(false);
		});

		it("ignores a poll that lands while the load is in flight", async () => {
			let resolveLoad: () => void;
			mockMpvLoad.mockImplementation(
				() =>
					new Promise<void>((r) => {
						resolveLoad = r;
					})
			);
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			let loadPromise: Promise<void>;
			act(() => {
				loadPromise = result.current.load("http://live.url");
			});

			// The previous stream, already playing.
			mockMpvGetState.mockResolvedValue(
				polled({ currentUrl: "http://old.url", position: 300, playbackStarted: true })
			);
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.state.playbackStarted).toBe(false);
			expect(result.current.state.position).toBe(0);

			await act(async () => {
				resolveLoad!();
				await loadPromise!;
			});
		});

		it("reports a stream that stops before it plays as openFailed", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			await loadAndWait(result);

			mockMpvGetState.mockResolvedValue(polled({ isPlaying: true, openFailed: true }));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.openFailed).toBe(true);
			expect(result.current.opening).toBe(false);

			// The reconnect monitor's banner outranks it.
			act(() => {
				mockListenCallbacks.get("mpv://reconnecting")!({
					payload: { url: "http://live.url", attempt: 1 },
				});
			});
			expect(result.current.openFailed).toBe(false);
			expect(result.current.opening).toBe(false);
		});

		it("retries a stream that failed to open when the network comes back", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			await loadAndWait(result);

			mockMpvGetState.mockResolvedValue(polled({ openFailed: true }));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.openFailed).toBe(true);

			mockMpvLoad.mockClear();
			await act(async () => {
				window.dispatchEvent(new Event("online"));
			});
			expect(mockMpvLoad).toHaveBeenCalledWith("http://live.url", undefined, true, true);
			// It never played, so "playing again" would be wrong. The spinner
			// shows instead.
			expect(result.current.recentlyRecovered).toBe(false);
			expect(result.current.opening).toBe(true);
		});

		it("keeps showing after the player is left and reopened mid-open", async () => {
			// The mount check sees isPlaying, which is true from loadfile on.
			mockMpvGetState.mockResolvedValue(polled());
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(result.current.firstFrameReady).toBe(true));
			await waitFor(() => expect(result.current.state.currentUrl).toBe("http://live.url"));
			expect(result.current.opening).toBe(true);

			mockMpvGetState.mockResolvedValue(polled({ position: 0.4, playbackStarted: true }));
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.opening).toBe(false);
		});

		it("reloads the stream the last load asked for, not the one still polled", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			await loadAndWait(result);

			mockMpvLoad.mockRejectedValueOnce(new Error("loadfile: error"));
			await act(async () => {
				await result.current.load("http://next.url").catch(() => {});
			});
			expect(result.current.state.currentUrl).toBe("http://live.url");

			mockMpvLoad.mockClear();
			await act(async () => {
				expect(await result.current.reload()).toBe(true);
			});
			expect(mockMpvLoad).toHaveBeenCalledWith("http://next.url", undefined, true, true);
		});

		it("reloads from the last known position", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			await loadAndWait(result);
			mockMpvGetState.mockResolvedValue(polled({ position: 75, playbackStarted: true }));
			await act(async () => {
				await result.current.refresh();
			});

			mockMpvLoad.mockClear();
			await act(async () => {
				await result.current.reload();
			});
			expect(mockMpvLoad).toHaveBeenCalledWith("http://live.url", 75, true, true);
		});

		it("doesn't reload while a load is in flight or after a stop", async () => {
			let resolveLoad: () => void;
			mockMpvLoad.mockImplementation(
				() =>
					new Promise<void>((r) => {
						resolveLoad = r;
					})
			);
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			let loadPromise: Promise<void>;
			act(() => {
				loadPromise = result.current.load("http://live.url");
			});
			await act(async () => {
				expect(await result.current.reload()).toBe(false);
			});
			expect(mockMpvLoad).toHaveBeenCalledTimes(1);
			await act(async () => {
				resolveLoad!();
				await loadPromise!;
			});

			await act(async () => {
				await result.current.stop();
			});
			await act(async () => {
				expect(await result.current.reload()).toBe(false);
			});
			expect(mockMpvLoad).toHaveBeenCalledTimes(1);
		});

		it("counts loads, including a reload of the same URL", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());
			const before = result.current.loadId;

			await loadAndWait(result);
			expect(result.current.loadId).toBe(before + 1);

			await loadAndWait(result);
			expect(result.current.loadId).toBe(before + 2);
		});
	});

	// ── Reconnect / buffering / recovery ──────────────────────────────
	//
	// Covers the auto-reconnect lifecycle wired up to the Rust monitor in
	// `crates/tauri-plugin-mpv/src/reconnect.rs`:
	//   mpv://reconnecting   →  red banner + attempt counter
	//   mpv://reconnected    →  clears red, flashes green, clears buffering
	//   mpv://buffering      →  amber banner (debounced 1.5 s)
	//   mpv://buffered       →  clears amber
	//   mpv://load-failed    →  red "Stream unavailable" + retries exhausted
	//   online (navigator)   →  hard-reset load when reconnecting/loadFailed,
	//                           resuming at the sticky last-known position
	describe("reconnect lifecycle", () => {
		it("mpv://reconnecting sets reconnecting + attempt counter", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			const cb = mockListenCallbacks.get("mpv://reconnecting");
			expect(cb).toBeDefined();

			act(() => {
				cb!({ payload: { url: "http://s", attempt: 3 } });
			});

			expect(result.current.reconnecting).toBe(true);
			expect(result.current.reconnectAttempt).toBe(3);
		});

		it("mpv://reconnected clears reconnecting and lights recentlyRecovered", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			act(() => {
				mockListenCallbacks.get("mpv://reconnecting")!({
					payload: { url: "http://s", attempt: 2 },
				});
			});
			expect(result.current.reconnecting).toBe(true);

			act(() => {
				mockListenCallbacks.get("mpv://reconnected")!({ payload: { url: "http://s" } });
			});

			expect(result.current.reconnecting).toBe(false);
			expect(result.current.reconnectAttempt).toBe(0);
			expect(result.current.recentlyRecovered).toBe(true);
		});

		it("mpv://reconnected defensively clears buffering (stuck via eof-reached path)", async () => {
			vi.useFakeTimers();
			try {
				const { result } = renderHook(() => useMpv());
				await mockMpvGetState.mock.results[0]?.value;

				act(() => {
					mockListenCallbacks.get("mpv://buffering")!({ payload: { url: "http://s" } });
				});
				act(() => {
					vi.advanceTimersByTime(1500);
				});
				expect(result.current.buffering).toBe(true);

				act(() => {
					mockListenCallbacks.get("mpv://reconnected")!({
						payload: { url: "http://s" },
					});
				});

				expect(result.current.buffering).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it("mpv://buffering is debounced and mpv://buffered cancels the pending flip", async () => {
			vi.useFakeTimers();
			try {
				const { result } = renderHook(() => useMpv());
				await mockMpvGetState.mock.results[0]?.value;

				act(() => {
					mockListenCallbacks.get("mpv://buffering")!({ payload: { url: "http://s" } });
				});
				expect(result.current.buffering).toBe(false);

				act(() => {
					vi.advanceTimersByTime(1000);
				});
				expect(result.current.buffering).toBe(false);

				act(() => {
					mockListenCallbacks.get("mpv://buffered")!({ payload: { url: "http://s" } });
				});
				act(() => {
					vi.advanceTimersByTime(2000);
				});
				expect(result.current.buffering).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it("mpv://buffering flips to true after the 1.5s debounce", async () => {
			vi.useFakeTimers();
			try {
				const { result } = renderHook(() => useMpv());
				await mockMpvGetState.mock.results[0]?.value;

				act(() => {
					mockListenCallbacks.get("mpv://buffering")!({ payload: { url: "http://s" } });
				});
				act(() => {
					vi.advanceTimersByTime(1500);
				});

				expect(result.current.buffering).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("mpv://load-failed sets loadFailed and clears reconnecting/buffering", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			act(() => {
				mockListenCallbacks.get("mpv://reconnecting")!({
					payload: { url: "http://s", attempt: 5 },
				});
			});

			act(() => {
				mockListenCallbacks.get("mpv://load-failed")!({ payload: { url: "http://s" } });
			});

			expect(result.current.loadFailed).toBe(true);
			expect(result.current.reconnecting).toBe(false);
			expect(result.current.reconnectAttempt).toBe(0);
			expect(result.current.buffering).toBe(false);
		});

		it("recentlyRecovered auto-clears after 2.5s", async () => {
			vi.useFakeTimers();
			try {
				const { result } = renderHook(() => useMpv());
				await mockMpvGetState.mock.results[0]?.value;

				act(() => {
					mockListenCallbacks.get("mpv://reconnected")!({
						payload: { url: "http://s" },
					});
				});
				expect(result.current.recentlyRecovered).toBe(true);

				act(() => {
					vi.advanceTimersByTime(2500);
				});
				expect(result.current.recentlyRecovered).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("online auto-recovery", () => {
		it("online event triggers load when reconnecting + currentUrl is set", async () => {
			// Polled state seeds the currentUrl ref the online listener reads.
			mockMpvGetState.mockResolvedValue({
				isPlaying: true,
				isPaused: false,
				currentUrl: "http://s",
				volume: 100,
				position: 42,
				duration: 120,
			} as never);

			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(result.current.state.currentUrl).toBe("http://s"));
			await waitFor(() => expect(result.current.state.position).toBe(42));

			act(() => {
				mockListenCallbacks.get("mpv://reconnecting")!({
					payload: { url: "http://s", attempt: 1 },
				});
			});

			mockMpvLoad.mockClear();
			await act(async () => {
				window.dispatchEvent(new Event("online"));
			});

			expect(mockMpvLoad).toHaveBeenCalledTimes(1);
			expect(mockMpvLoad).toHaveBeenCalledWith("http://s", 42, true, true);
			expect(result.current.recentlyRecovered).toBe(true);
		});

		it("online event is a no-op when not in a failure state", async () => {
			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(mockMpvGetState).toHaveBeenCalled());

			expect(result.current.reconnecting).toBe(false);
			expect(result.current.loadFailed).toBe(false);

			mockMpvLoad.mockClear();
			act(() => {
				window.dispatchEvent(new Event("online"));
			});

			expect(mockMpvLoad).not.toHaveBeenCalled();
		});

		it("getLastKnownPosition reflects forward progress and survives state.position=0", async () => {
			// Seed with forward progress so the sticky ref captures 42.
			mockMpvGetState.mockResolvedValue({
				isPlaying: true,
				isPaused: false,
				currentUrl: "http://s",
				volume: 100,
				position: 42,
				duration: 120,
			} as never);

			const { result } = renderHook(() => useMpv());
			await waitFor(() => expect(result.current.state.position).toBe(42));
			expect(result.current.getLastKnownPosition()).toBe(42);

			// Now mid-retry: position drops to 0. The sticky ref must hold.
			mockMpvGetState.mockResolvedValue({
				isPlaying: false,
				isPaused: false,
				currentUrl: "http://s",
				volume: 100,
				position: 0,
				duration: 0,
			} as never);
			await act(async () => {
				await result.current.refresh();
			});

			expect(result.current.state.position).toBe(0);
			expect(result.current.getLastKnownPosition()).toBe(42);
		});
	});
});
