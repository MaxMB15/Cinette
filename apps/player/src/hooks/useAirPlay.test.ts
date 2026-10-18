// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type * as Bridge from "@/lib/tauri";
import type { StreamFormat } from "@/lib/route";
import type { AirPlayNativeState } from "@/lib/airplay";
import { makeMovie } from "@/test/detail-fixtures";
import { useAirPlay } from "./useAirPlay";

/** Events the backend would send, by name. */
const events = vi.hoisted(() => {
	const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();
	return {
		handlers,
		emit: (name: string, payload: unknown) => {
			for (const h of [...(handlers.get(name) ?? [])]) h({ payload });
		},
		count: (name: string) => handlers.get(name)?.size ?? 0,
	};
});

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
		const set = events.handlers.get(name) ?? new Set();
		set.add(handler);
		events.handlers.set(name, set);
		return () => set.delete(handler);
	},
}));

const mp4: StreamFormat = {
	container: "mp4",
	video: "h264",
	interlaced: false,
	audio: "aac",
	cors: false,
};

const tauri = vi.hoisted(() => ({
	airplayChoose: vi.fn<typeof Bridge.airplayChoose>(async () => {}),
	airplayConverterSupport: vi.fn<typeof Bridge.airplayConverterSupport>(),
	airplayEndConversion: vi.fn<typeof Bridge.airplayEndConversion>(async () => {}),
	airplayLoadConverted: vi.fn<typeof Bridge.airplayLoadConverted>(async () => {}),
	airplayGetRoute: vi.fn<typeof Bridge.airplayGetRoute>(async () => null),
	airplayLoad: vi.fn<typeof Bridge.airplayLoad>(async () => {}),
	airplayPause: vi.fn<typeof Bridge.airplayPause>(async () => {}),
	airplayPlay: vi.fn<typeof Bridge.airplayPlay>(async () => {}),
	airplaySeek: vi.fn<typeof Bridge.airplaySeek>(async () => {}),
	airplaySelectAudio: vi.fn<typeof Bridge.airplaySelectAudio>(async () => {}),
	airplaySelectSubtitle: vi.fn<typeof Bridge.airplaySelectSubtitle>(async () => {}),
	airplaySetDetection: vi.fn<typeof Bridge.airplaySetDetection>(async () => {}),
	airplayStop: vi.fn<typeof Bridge.airplayStop>(async () => {}),
	getStreamFormats: vi.fn<typeof Bridge.getStreamFormats>(),
	mpvGetMediaInfo: vi.fn<typeof Bridge.mpvGetMediaInfo>(),
}));

vi.mock("@/lib/tauri", () => tauri);

const tv = { id: "airplay:tv", name: "Living Room TV" };
const anchor = new DOMRect(10, 20, 30, 40);
const film = makeMovie({ id: "mv1", name: "A Film" });
const info = { fileFormat: "mov", videoCodec: "h264", audioCodec: "aac", interlaced: false };
/** The confirm step, which says yes unless a test says otherwise. */
const confirm = vi.fn(async () => true);

/** Lets pending promises settle. */
const flush = () =>
	act(async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});

beforeEach(() => {
	events.handlers.clear();
	tauri.getStreamFormats.mockResolvedValue({ formats: [mp4], sources: [2], duration: null });
	tauri.mpvGetMediaInfo.mockResolvedValue(info);
	tauri.airplayConverterSupport.mockResolvedValue({ convert: false, hardwareEncoder: false });
	confirm.mockResolvedValue(true);
});

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("useAirPlay", () => {
	it("does nothing when it's off", async () => {
		const { result } = renderHook(() => useAirPlay(false));
		await flush();
		expect(tauri.airplaySetDetection).not.toHaveBeenCalled();
		expect(tauri.airplayGetRoute).not.toHaveBeenCalled();
		expect(events.count("airplay://available")).toBe(0);
		act(() => events.emit("airplay://available", true));
		expect(result.current.available).toBe(false);
		expect(result.current.destination).toBeNull();
		expect(result.current.state).toBeNull();
	});

	it("looks for receivers while it's on, and stops when it goes", async () => {
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		expect(tauri.airplaySetDetection).toHaveBeenCalledWith(true);
		expect(result.current.available).toBe(false);
		act(() => events.emit("airplay://available", true));
		expect(result.current.available).toBe(true);
		act(() => events.emit("airplay://available", false));
		expect(result.current.available).toBe(false);
		unmount();
		await flush();
		expect(tauri.airplaySetDetection).toHaveBeenLastCalledWith(false);
		expect(events.count("airplay://available")).toBe(0);
		expect(events.count("airplay://route")).toBe(0);
	});

	it("counts as available while the audio route is already AirPlay", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		expect(result.current.available).toBe(true);
		act(() => events.emit("airplay://route", null));
		expect(result.current.available).toBe(false);
	});

	it("ignores a route asked for before it was turned off and on", async () => {
		let answer: (r: typeof tv) => void = () => {};
		tauri.airplayGetRoute
			.mockReturnValueOnce(new Promise((r) => (answer = r)))
			.mockResolvedValueOnce(null);
		const { result, rerender } = renderHook(({ on }) => useAirPlay(on), {
			initialProps: { on: true },
		});
		rerender({ on: false });
		rerender({ on: true });
		await flush();
		expect(tauri.airplaySetDetection.mock.calls).toEqual([[true], [false], [true]]);
		answer(tv);
		await flush();
		expect(result.current.available).toBe(false);
	});

	it("ignores a route that arrives after it's gone", async () => {
		let answer: (r: typeof tv) => void = () => {};
		tauri.airplayGetRoute.mockReturnValue(new Promise((r) => (answer = r)));
		const { result, unmount } = renderHook(() => useAirPlay(true));
		unmount();
		answer(tv);
		await flush();
		expect(result.current.available).toBe(false);
	});

	it("survives the backend failing", async () => {
		tauri.airplaySetDetection.mockRejectedValue(new Error("no"));
		tauri.airplayGetRoute.mockRejectedValue(new Error("no"));
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		expect(result.current.available).toBe(false);
		unmount();
		await flush();
	});

	it("has the user pick a receiver, then stops this device and loads there", async () => {
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		let sent: Promise<unknown> = Promise.resolve();
		act(() => {
			sent = result.current.send(film, { anchor, startAt: 600, stopLocal, confirm });
		});
		await flush();
		expect(tauri.airplayChoose).toHaveBeenCalledWith({ x: 10, y: 20, width: 30, height: 40 });
		expect(stopLocal).not.toHaveBeenCalled();
		act(() => events.emit("airplay://route", tv));
		await act(async () => {
			expect(await sent).toEqual({ sent: true });
		});
		expect(tauri.mpvGetMediaInfo).toHaveBeenCalled();
		expect(tauri.getStreamFormats).toHaveBeenCalledWith(film, info);
		expect(stopLocal).toHaveBeenCalled();
		expect(tauri.airplayLoad).toHaveBeenCalledWith(film, 2, 600);
		expect(stopLocal.mock.invocationCallOrder[0]).toBeLessThan(
			tauri.airplayLoad.mock.invocationCallOrder[0]
		);
		expect(result.current.destination?.name).toBe("Living Room TV");
		expect(result.current.state).toMatchObject({ status: "opening" });

		const native: AirPlayNativeState = {
			status: "playing",
			position: 601,
			duration: 5400,
			subtitles: [],
			subtitleId: null,
			audio: [],
			audioId: null,
			connection: "connected",
			error: null,
		};
		act(() => events.emit("airplay://state", native));
		expect(result.current.state).toMatchObject({ status: "playing", position: 601 });
		expect(result.current.state?.positionAt).toEqual(expect.any(Number));
		// The picker's own listeners are gone.
		expect(events.count("airplay://picker-closed")).toBe(0);
	});

	it("skips the picker when the audio route is already AirPlay", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		await act(async () => {
			expect(await result.current.send(film, { anchor, stopLocal, confirm })).toEqual({
				sent: true,
			});
		});
		expect(tauri.airplayChoose).not.toHaveBeenCalled();
		expect(tauri.airplayLoad).toHaveBeenCalledWith(film, 2, undefined);
	});

	it("ignores a route change to this device while the picker is up", async () => {
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		let sent: Promise<unknown> = Promise.resolve();
		act(() => {
			sent = result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		await flush();
		act(() => events.emit("airplay://route", null));
		act(() => events.emit("airplay://route", tv));
		await act(async () => {
			expect(await sent).toEqual({ sent: true });
		});
	});

	it("waits a moment after the picker closes, for a route that comes late", async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		let sent: Promise<unknown> = Promise.resolve();
		act(() => {
			sent = result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		await flush();
		act(() => events.emit("airplay://picker-closed", null));
		act(() => vi.advanceTimersByTime(900));
		act(() => events.emit("airplay://route", tv));
		await act(async () => {
			expect(await sent).toEqual({ sent: true });
		});
		// The grace timer went with the picker.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("gives up when the picker closes with nothing picked", async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		let sent: Promise<unknown> = Promise.resolve();
		act(() => {
			sent = result.current.send(film, { anchor, stopLocal, confirm });
		});
		await flush();
		act(() => events.emit("airplay://picker-closed", null));
		act(() => vi.advanceTimersByTime(999));
		let settled = false;
		void sent.then(() => (settled = true));
		await flush();
		expect(settled).toBe(false);
		act(() => vi.advanceTimersByTime(1));
		await act(async () => {
			expect(await sent).toEqual({ sent: false, why: "cancelled" });
		});
		expect(stopLocal).not.toHaveBeenCalled();
		expect(events.count("airplay://route")).toBe(1);
		expect(events.count("airplay://picker-closed")).toBe(0);
	});

	it("keeps playing here when the TV can't take the stream", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.getStreamFormats.mockResolvedValue({
			formats: [{ ...mp4, container: "mkv" }],
			sources: [0],
			duration: null,
		});
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		await act(async () => {
			expect(await result.current.send(film, { anchor, stopLocal, confirm })).toEqual({
				sent: false,
				why: "blocked",
				decision: { ok: false, reason: "container", detail: "mkv" },
			});
		});
		expect(stopLocal).not.toHaveBeenCalled();
		expect(result.current.destination).toBeNull();
		expect(events.count("airplay://state")).toBe(0);
	});

	it("reports a picker that won't open", async () => {
		tauri.airplayChoose.mockRejectedValue(new Error("no picker"));
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, stopLocal: async () => {}, confirm })
			).toEqual({
				sent: false,
				why: "failed",
				error: new Error("no picker"),
			});
		});
		expect(events.count("airplay://route")).toBe(1);
		expect(events.count("airplay://picker-closed")).toBe(0);
	});

	it("ends AirPlay when told to and when the page goes", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			await result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		expect(events.count("airplay://state")).toBe(1);
		await act(() => result.current.stop());
		expect(tauri.airplayStop).toHaveBeenCalledTimes(1);
		expect(result.current.destination).toBeNull();
		expect(result.current.state).toBeNull();
		expect(events.count("airplay://state")).toBe(0);

		await act(async () => {
			await result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		tauri.airplayStop.mockRejectedValue(new Error("gone"));
		unmount();
		await flush();
		expect(tauri.airplayStop).toHaveBeenCalledTimes(2);
		expect(events.count("airplay://state")).toBe(0);
	});
});

describe("useAirPlay converting", () => {
	const mkv = { formats: [{ ...mp4, container: "mkv" as const }], sources: [1], duration: null };

	it("converts on this device when it can, after asking", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
		tauri.getStreamFormats.mockResolvedValue(mkv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, startAt: 30, stopLocal, confirm })
			).toEqual({ sent: true });
		});
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(
			stopLocal.mock.invocationCallOrder[0]
		);
		expect(tauri.airplayLoadConverted).toHaveBeenCalledWith(film, 1, 30);
		expect(tauri.airplayLoad).not.toHaveBeenCalled();
	});

	it("keeps playing here when the user says no", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
		tauri.getStreamFormats.mockResolvedValue(mkv);
		confirm.mockResolvedValue(false);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		await act(async () => {
			expect(await result.current.send(film, { anchor, stopLocal, confirm })).toEqual({
				sent: false,
				why: "cancelled",
			});
		});
		expect(stopLocal).not.toHaveBeenCalled();
		expect(tauri.airplayLoadConverted).not.toHaveBeenCalled();
		expect(events.count("airplay://state")).toBe(0);
	});

	it("doesn't ask for a direct route", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			await result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		expect(confirm).not.toHaveBeenCalled();
	});

	it("can't convert until the backend says it can", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayConverterSupport.mockRejectedValue(new Error("no"));
		tauri.getStreamFormats.mockResolvedValue(mkv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, stopLocal: async () => {}, confirm })
			).toMatchObject({ sent: false, why: "blocked" });
		});
	});

	it("ignores the support answer once it's gone", async () => {
		let answer: (s: { convert: boolean; hardwareEncoder: boolean }) => void = () => {};
		tauri.airplayConverterSupport
			.mockReturnValueOnce(new Promise((r) => (answer = r)))
			.mockResolvedValueOnce({ convert: false, hardwareEncoder: false });
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.getStreamFormats.mockResolvedValue(mkv);
		const { result, rerender } = renderHook(({ on }) => useAirPlay(on), {
			initialProps: { on: true },
		});
		rerender({ on: false });
		rerender({ on: true });
		await flush();
		answer({ convert: true, hardwareEncoder: false });
		await flush();
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, stopLocal: async () => {}, confirm })
			).toMatchObject({ sent: false, why: "blocked" });
		});
	});

	it("takes the panel away when the TV never starts", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
		tauri.getStreamFormats.mockResolvedValue(mkv);
		tauri.airplayLoadConverted.mockRejectedValue("refused");
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, stopLocal: async () => {}, confirm })
			).toEqual({ sent: false, why: "failed", error: "refused" });
		});
		await flush();
		expect(result.current.destination).toBeNull();
		expect(tauri.airplayEndConversion).toHaveBeenCalled();
		expect(tauri.airplayStop).toHaveBeenCalled();
		// The failed destination stopped listening for the TV's state.
		expect(events.count("airplay://state")).toBe(0);
	});
});
