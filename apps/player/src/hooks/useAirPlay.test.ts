// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type * as Bridge from "@/lib/tauri";
import type { StreamFormat } from "@/lib/route";
import type { AirPlayNativeState } from "@/lib/airplay";
import { NOT_READY } from "@/lib/route-profiles";
import { makeMovie } from "@/test/detail-fixtures";
import { useAirPlay } from "./useAirPlay";

/** Events the backend would send, by name. */
const events = vi.hoisted(() => {
	const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();
	return {
		handlers,
		/** Events whose next listen fails. */
		failing: new Set<string>(),
		emit: (name: string, payload: unknown) => {
			for (const h of [...(handlers.get(name) ?? [])]) h({ payload });
		},
		count: (name: string) => handlers.get(name)?.size ?? 0,
	};
});

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
		if (events.failing.delete(name)) throw new Error("couldn't listen");
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
	hdr: false,
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
	airplaySetDetection: vi.fn<typeof Bridge.airplaySetDetection>(async () => null),
	airplayStop: vi.fn<typeof Bridge.airplayStop>(async () => {}),
	getStreamFormats: vi.fn<typeof Bridge.getStreamFormats>(),
}));

vi.mock("@/lib/tauri", () => tauri);

const tv = { id: "airplay:tv", name: "Living Room TV" };
const anchor = new DOMRect(10, 20, 30, 40);
const film = makeMovie({ id: "mv1", name: "A Film" });
/** The confirm step, which says yes unless a test says otherwise. */
const confirm = vi.fn(async () => true);

/** Lets pending promises settle. */
const flush = () =>
	act(async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});

beforeEach(() => {
	events.handlers.clear();
	events.failing.clear();
	tauri.getStreamFormats.mockResolvedValue({
		formats: [mp4],
		sources: [2],
		duration: null,
		generation: 5,
	});
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

	it("turns detection on only once it listens, so the first report isn't missed", async () => {
		const listening: number[] = [];
		tauri.airplaySetDetection.mockImplementationOnce(async () => {
			listening.push(events.count("airplay://available"), events.count("airplay://route"));
			return null;
		});
		renderHook(() => useAirPlay(true));
		await flush();
		expect(listening).toEqual([1, 1]);
	});

	it("takes what detection last found, which may not change again", async () => {
		// Another player turned it on, and a TV was found then.
		tauri.airplaySetDetection.mockResolvedValueOnce(true);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		expect(result.current.available).toBe(true);
		act(() => events.emit("airplay://available", false));
		expect(result.current.available).toBe(false);
	});

	it("waits for an event when detection hasn't found anything yet", async () => {
		tauri.airplaySetDetection.mockResolvedValueOnce(null);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		expect(result.current.available).toBe(false);
	});

	it("keeps a report that came before the command's answer of nothing yet", async () => {
		let answer: (known: boolean | null) => void = () => {};
		tauri.airplaySetDetection.mockImplementationOnce(
			() => new Promise((resolve) => (answer = resolve))
		);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		act(() => events.emit("airplay://available", true));
		await act(async () => answer(null));
		expect(result.current.available).toBe(true);
	});

	it("ignores an answer to a player that has turned off since", async () => {
		let first: (known: boolean | null) => void = () => {};
		tauri.airplaySetDetection
			.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
			.mockResolvedValue(null);
		const { result, rerender } = renderHook(({ on }) => useAirPlay(on), {
			initialProps: { on: true },
		});
		await flush();
		rerender({ on: false });
		await act(async () => first(true));
		rerender({ on: true });
		await flush();
		// Nothing has said a TV is in reach since it came back on.
		expect(result.current.available).toBe(false);
	});

	it("turns detection on and off in pairs even when it can't listen", async () => {
		events.failing.add("airplay://available");
		const first = renderHook(() => useAirPlay(true));
		await flush();
		first.unmount();
		await flush();
		expect(tauri.airplaySetDetection.mock.calls).toEqual([[true], [false]]);
		// The next player still gets detection.
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		expect(tauri.airplaySetDetection).toHaveBeenLastCalledWith(true);
		act(() => events.emit("airplay://available", true));
		expect(result.current.available).toBe(true);
	});

	it("takes no answer once a newer report came", async () => {
		let answer: (known: boolean | null) => void = () => {};
		tauri.airplaySetDetection.mockImplementationOnce(
			() => new Promise((resolve) => (answer = resolve))
		);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		act(() => events.emit("airplay://available", false));
		await act(async () => answer(true));
		expect(result.current.available).toBe(false);
	});

	it("ignores what detection found once the page has gone", async () => {
		let answer: (known: boolean) => void = () => {};
		tauri.airplaySetDetection.mockImplementationOnce(
			() => new Promise((resolve) => (answer = resolve))
		);
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		unmount();
		await act(async () => answer(true));
		expect(result.current.available).toBe(false);
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
		// The first on waits for its listeners, so its off comes first. The
		// backend counts them, so the order doesn't matter: on twice, off once.
		expect(tauri.airplaySetDetection.mock.calls).toEqual([[false], [true], [true]]);
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
		expect(tauri.getStreamFormats).toHaveBeenCalledWith(film);
		expect(stopLocal).toHaveBeenCalled();
		expect(tauri.airplayLoad).toHaveBeenCalledWith(film, 5, 2, 600);
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
		expect(result.current.notPicked).toBe(false);
		// The picker's own listeners are gone.
		expect(events.count("airplay://picker-closed")).toBe(0);
		// On a Mac, no receiver took it, which the player hears.
		const none = { ...native, status: "error" as const };
		act(() =>
			events.emit("airplay://state", {
				...none,
				error: { code: "openFailed", notPicked: true },
			})
		);
		expect(result.current.notPicked).toBe(true);
		expect(result.current.state).toMatchObject({ status: "opening", error: null });
	});

	it("says nothing was picked only while AirPlay plays", async () => {
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		expect(result.current.notPicked).toBe(false);
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
		expect(tauri.airplayLoad).toHaveBeenCalledWith(film, 5, 2, undefined);
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

	it("waits half a second before asking again while mpv opens the item", async () => {
		vi.useFakeTimers();
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.getStreamFormats.mockRejectedValueOnce(NOT_READY);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		let sent: Promise<unknown> = Promise.resolve();
		act(() => {
			sent = result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		await flush();
		expect(tauri.getStreamFormats).toHaveBeenCalledTimes(1);
		act(() => vi.advanceTimersByTime(499));
		await flush();
		expect(tauri.getStreamFormats).toHaveBeenCalledTimes(1);
		act(() => vi.advanceTimersByTime(1));
		await flush();
		// The check's second try, then the picked TV's own.
		expect(tauri.getStreamFormats).toHaveBeenCalledTimes(3);
		await act(async () => {
			expect(await sent).toEqual({ sent: true });
		});
	});

	it("keeps playing here when the TV can't take the stream", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.getStreamFormats.mockResolvedValue({
			formats: [{ ...mp4, container: "mkv" }],
			sources: [0],
			duration: null,
			generation: 0,
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
				stopped: false,
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

describe("useAirPlay's switching", () => {
	const mkv = {
		formats: [{ ...mp4, container: "mkv" as const }],
		sources: [0],
		duration: null,
		generation: 0,
	};

	it("checks the item before the picker, so a blocked one never moves the sound", async () => {
		tauri.getStreamFormats.mockResolvedValue(mkv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, stopLocal: async () => {}, confirm })
			).toMatchObject({ sent: false, why: "blocked" });
		});
		expect(tauri.airplayChoose).not.toHaveBeenCalled();
		// The check's own listener is gone.
		expect(events.count("airplay://state")).toBe(0);
	});

	it("starts nothing when the page goes during the check", async () => {
		let formats: (f: {
			formats: StreamFormat[];
			sources: number[];
			duration: null;
			generation: number;
		}) => void = () => {};
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.getStreamFormats.mockReturnValueOnce(new Promise((r) => (formats = r)));
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		const sent = result.current.send(film, { anchor, stopLocal, confirm });
		unmount();
		formats({ formats: [mp4], sources: [0], duration: null, generation: 0 });
		expect(await sent).toEqual({ sent: false, why: "cancelled" });
		expect(stopLocal).not.toHaveBeenCalled();
		expect(tauri.airplayLoad).not.toHaveBeenCalled();
		await flush();
		expect(events.count("airplay://state")).toBe(0);
	});

	it("starts nothing when the page goes while the receiver's route is checked", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		let second: (f: {
			formats: StreamFormat[];
			sources: number[];
			duration: null;
			generation: number;
		}) => void = () => {};
		tauri.getStreamFormats
			.mockResolvedValueOnce({ formats: [mp4], sources: [0], duration: null, generation: 0 })
			.mockReturnValueOnce(new Promise((r) => (second = r)));
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		const sent = result.current.send(film, { anchor, stopLocal, confirm });
		await flush();
		unmount();
		second({ formats: [mp4], sources: [0], duration: null, generation: 0 });
		expect(await sent).toEqual({ sent: false, why: "cancelled" });
		expect(stopLocal).not.toHaveBeenCalled();
		expect(tauri.airplayLoad).not.toHaveBeenCalled();
		// Neither destination still listens.
		await flush();
		expect(events.count("airplay://state")).toBe(0);
	});

	it("starts nothing when the page goes while this device stops", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		let stopped: () => void = () => {};
		const stopLocal = vi.fn(() => new Promise<void>((r) => (stopped = r)));
		const sent = result.current.send(film, { anchor, stopLocal, confirm });
		await flush();
		unmount();
		stopped();
		expect(await sent).toEqual({ sent: false, why: "cancelled" });
		expect(tauri.airplayLoad).not.toHaveBeenCalled();
		await flush();
		expect(events.count("airplay://state")).toBe(0);
	});

	it("doesn't open the picker once the page has gone", async () => {
		let formats: (f: {
			formats: StreamFormat[];
			sources: number[];
			duration: null;
			generation: number;
		}) => void = () => {};
		tauri.getStreamFormats.mockReturnValueOnce(new Promise((r) => (formats = r)));
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		const sent = result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		unmount();
		formats({ formats: [mp4], sources: [0], duration: null, generation: 0 });
		expect(await sent).toEqual({ sent: false, why: "cancelled" });
		expect(tauri.airplayChoose).not.toHaveBeenCalled();
	});

	it("says which picks the page went during", async () => {
		const { result, unmount } = renderHook(() => useAirPlay(true));
		await flush();
		const stopLocal = vi.fn(async () => {});
		const sent = result.current.send(film, { anchor, stopLocal, confirm });
		await flush();
		unmount();
		act(() => events.emit("airplay://route", tv));
		expect(await sent).toEqual({ sent: false, why: "cancelled" });
		expect(stopLocal).not.toHaveBeenCalled();
	});

	it("blocks an item the receiver's own check turns down", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.getStreamFormats
			.mockResolvedValueOnce({ formats: [mp4], sources: [0], duration: null, generation: 0 })
			.mockResolvedValueOnce(mkv);
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
	});

	it("takes the panel away when the TV never starts", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayLoad.mockRejectedValue("That stream format is no longer offered");
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, stopLocal: async () => {}, confirm })
			).toEqual({
				sent: false,
				why: "failed",
				error: "That stream format is no longer offered",
				stopped: true,
			});
		});
		expect(result.current.destination).toBeNull();
		expect(result.current.state).toBeNull();
		expect(tauri.airplayStop).toHaveBeenCalledTimes(1);
		expect(events.count("airplay://state")).toBe(0);
	});

	it("stops AirPlay before it resolves", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			await result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		let done: () => void = () => {};
		tauri.airplayStop.mockReturnValueOnce(new Promise((r) => (done = r)));
		let resolved = false;
		let stopping: Promise<void> = Promise.resolve();
		act(() => {
			stopping = result.current.stop().then(() => {
				resolved = true;
			});
		});
		await flush();
		expect(resolved).toBe(false);
		expect(result.current.destination).toBeNull();
		await act(async () => {
			done();
			await stopping;
		});
		expect(resolved).toBe(true);
		// Stopping again with nothing playing does nothing.
		await act(() => result.current.stop());
		expect(tauri.airplayStop).toHaveBeenCalledTimes(1);
	});

	it("brings the sound back to this device before it stops AirPlay", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			await result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		let back: Promise<void> = Promise.resolve();
		act(() => {
			back = result.current.returnHere(anchor);
		});
		await flush();
		expect(tauri.airplayChoose).toHaveBeenCalledWith({ x: 10, y: 20, width: 30, height: 40 });
		expect(tauri.airplayStop).not.toHaveBeenCalled();
		// Another receiver doesn't count; this device does.
		act(() => events.emit("airplay://route", { id: "airplay:other", name: "Other" }));
		await flush();
		expect(tauri.airplayStop).not.toHaveBeenCalled();
		act(() => events.emit("airplay://route", null));
		await act(() => back);
		expect(tauri.airplayStop).toHaveBeenCalledTimes(1);
		expect(result.current.destination).toBeNull();
	});

	it("stops AirPlay even when the picker won't open", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			await result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		tauri.airplayChoose.mockRejectedValue(new Error("no picker"));
		await act(() => result.current.returnHere(anchor));
		expect(tauri.airplayStop).toHaveBeenCalledTimes(1);
	});

	it("only stops AirPlay to come back on a Mac, whose sound never left", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		const { result } = renderHook(() => useAirPlay(true, true));
		await flush();
		await act(async () => {
			await result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		await act(() => result.current.returnHere(anchor));
		expect(tauri.airplayChoose).not.toHaveBeenCalled();
		expect(tauri.airplayStop).toHaveBeenCalledTimes(1);
		expect(result.current.destination).toBeNull();
	});

	it("doesn't open the picker to come back when the sound is already here", async () => {
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(() => result.current.returnHere(anchor));
		expect(tauri.airplayChoose).not.toHaveBeenCalled();
	});
});

describe("useAirPlay converting", () => {
	const mkv = {
		formats: [{ ...mp4, container: "mkv" as const }],
		sources: [1],
		duration: null,
		generation: 5,
	};

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
		expect(tauri.airplayLoadConverted).toHaveBeenCalledWith(film, 5, 1, 30);
		expect(tauri.airplayLoad).not.toHaveBeenCalled();
	});

	it("asks before the picker, so a no never moves the sound", async () => {
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
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(tauri.airplayChoose).not.toHaveBeenCalled();
		expect(stopLocal).not.toHaveBeenCalled();
	});

	it("asks once, before the picker, then sends to the TV picked", async () => {
		tauri.airplayConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
		tauri.getStreamFormats.mockResolvedValue(mkv);
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		let sent: Promise<unknown> = Promise.resolve();
		act(() => {
			sent = result.current.send(film, { anchor, stopLocal: async () => {}, confirm });
		});
		await flush();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(
			tauri.airplayChoose.mock.invocationCallOrder[0]
		);
		act(() => events.emit("airplay://route", tv));
		await act(async () => {
			expect(await sent).toEqual({ sent: true });
		});
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(tauri.airplayLoadConverted).toHaveBeenCalled();
	});

	it("asks after the picker when only the TV's check converts", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
		tauri.getStreamFormats
			.mockResolvedValueOnce({ formats: [mp4], sources: [0], duration: null, generation: 1 })
			.mockResolvedValueOnce(mkv);
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
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(stopLocal).not.toHaveBeenCalled();
		expect(tauri.airplayLoadConverted).not.toHaveBeenCalled();
		expect(events.count("airplay://state")).toBe(0);
	});

	it("doesn't ask for a stream the TV plays as it is", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, stopLocal: async () => {}, confirm })
			).toEqual({ sent: true });
		});
		expect(confirm).not.toHaveBeenCalled();
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

	it("takes the panel away when a conversion never starts", async () => {
		tauri.airplayGetRoute.mockResolvedValue(tv);
		tauri.airplayConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
		tauri.getStreamFormats.mockResolvedValue(mkv);
		tauri.airplayLoadConverted.mockRejectedValue("refused");
		const { result } = renderHook(() => useAirPlay(true));
		await flush();
		await act(async () => {
			expect(
				await result.current.send(film, { anchor, stopLocal: async () => {}, confirm })
			).toEqual({ sent: false, why: "failed", error: "refused", stopped: true });
		});
		await flush();
		expect(result.current.destination).toBeNull();
		expect(tauri.airplayEndConversion).toHaveBeenCalled();
		expect(tauri.airplayStop).toHaveBeenCalled();
		// The failed destination stopped listening for the TV's state.
		expect(events.count("airplay://state")).toBe(0);
	});
});
