// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type * as Bridge from "@/lib/tauri";
import type { StreamFormats } from "@/lib/route-profiles";
import type { StreamFormat } from "@/lib/route";
import { makeMovie } from "@/test/detail-fixtures";
import { writeStreamThrough } from "@/lib/player-prefs";
import { useCast } from "./useCast";

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

const tauri = vi.hoisted(() => ({
	CAST_RECEIVERS_EVENT: "cast://receivers",
	CAST_UPDATE_EVENT: "cast://update",
	castControl: vi.fn<typeof Bridge.castControl>(async () => {}),
	castLoad: vi.fn<typeof Bridge.castLoad>(async () => {}),
	castStop: vi.fn<typeof Bridge.castStop>(async () => {}),
	getCastReceivers: vi.fn<typeof Bridge.getCastReceivers>(),
	getConverterSupport: vi.fn<typeof Bridge.getConverterSupport>(),
	getStreamFormats: vi.fn<typeof Bridge.getStreamFormats>(),
	getVpnActive: vi.fn<typeof Bridge.getVpnActive>(async () => false),
	holdCastReceivers: vi.fn<typeof Bridge.holdCastReceivers>(async () => {}),
}));

vi.mock("@/lib/tauri", () => tauri);

const mp4: StreamFormat = {
	container: "mp4",
	video: "h264",
	interlaced: false,
	hdr: false,
	audio: "aac",
	cors: false,
};
const ac3: StreamFormat = { ...mp4, container: "mkv", audio: "ac3" };

const tv = { id: "cast:tv", name: "Hotel TV", model: "Chromecast", status: null, available: true };
const den = { ...tv, id: "cast:den", name: "Den" };
const film = makeMovie({ id: "mv1", name: "A Film" });

const receivers = (revision: number, list: (typeof tv)[]): Bridge.CastReceiverList => ({
	revision,
	receivers: list,
	localNetworkDenied: false,
});

/** Lets pending promises settle. */
const flush = () =>
	act(async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});

const stopLocal = vi.fn(async () => {});
/** What the hook says about a cast that ended by itself. */
const report = vi.fn();

beforeEach(() => {
	events.handlers.clear();
	localStorage.clear();
	tauri.getCastReceivers.mockResolvedValue(receivers(1, [tv]));
	tauri.getStreamFormats.mockResolvedValue({
		formats: [mp4],
		sources: [2],
		duration: 5400,
		generation: 5,
	});
	tauri.getConverterSupport.mockResolvedValue({ convert: true, hardwareEncoder: false });
	stopLocal.mockResolvedValue(undefined);
	tauri.getVpnActive.mockResolvedValue(false);
});

afterEach(() => {
	vi.resetAllMocks();
});

const render = async (enabled = true) => {
	const hook = renderHook(() => useCast(enabled, report));
	await flush();
	return hook;
};

describe("useCast", () => {
	it("lists nothing and asks for nothing when it's off", async () => {
		const { result } = await render(false);
		expect(result.current.receivers).toEqual([]);
		expect(tauri.getCastReceivers).not.toHaveBeenCalled();
		expect(events.count("cast://receivers")).toBe(0);
	});

	it("keeps the newest list of receivers", async () => {
		const { result } = await render();
		expect(result.current.receivers).toEqual([tv]);
		act(() => events.emit("cast://receivers", receivers(3, [tv, den])));
		expect(result.current.receivers).toEqual([tv, den]);
		act(() => events.emit("cast://receivers", receivers(2, [])));
		expect(result.current.receivers).toEqual([tv, den]);
		act(() =>
			events.emit("cast://receivers", { ...receivers(4, []), localNetworkDenied: true })
		);
		expect(result.current.localNetworkDenied).toBe(true);
	});

	it("asks whether a VPN is on, and again each time the picker opens", async () => {
		tauri.getVpnActive.mockResolvedValueOnce(true);
		const { result } = await render();
		expect(result.current.vpnActive).toBe(true);
		act(() => result.current.check(film));
		await flush();
		expect(result.current.vpnActive).toBe(false);
		// An answer for a picker that closed meanwhile is dropped.
		let answer: (on: boolean) => void = () => {};
		tauri.getVpnActive.mockReturnValueOnce(new Promise((r) => (answer = r)));
		act(() => result.current.check(film));
		act(() => result.current.release());
		answer(true);
		await flush();
		expect(result.current.vpnActive).toBe(false);
		tauri.getVpnActive.mockRejectedValueOnce(new Error("no"));
		act(() => result.current.check(film));
		await flush();
		expect(result.current.vpnActive).toBe(false);
	});

	it("works out each receiver's route for the picker, and holds them while it's open", async () => {
		tauri.getCastReceivers.mockResolvedValue(
			receivers(1, [tv, den, { ...tv, id: "cast:gone", available: false }])
		);
		tauri.getStreamFormats.mockResolvedValue({
			formats: [ac3],
			sources: [0],
			duration: 5400,
			generation: 5,
		});
		const { result } = await render();
		act(() => result.current.check(film));
		expect(result.current.statuses.size).toBe(0);
		await flush();
		expect(result.current.statuses.get("cast:tv")).toEqual({ via: "converted", keep: "on" });
		expect(result.current.statuses.get("cast:den")).toEqual({ via: "converted", keep: "on" });
		expect(result.current.statuses.has("cast:gone")).toBe(false);
		expect(tauri.holdCastReceivers).toHaveBeenLastCalledWith([
			"cast:tv",
			"cast:den",
			"cast:gone",
		]);
		act(() => result.current.release());
		await flush();
		expect(tauri.holdCastReceivers).toHaveBeenLastCalledWith([]);
	});

	it("drops routes worked out for an item checked before the last", async () => {
		let answer: (f: StreamFormats) => void = () => {};
		tauri.getStreamFormats.mockReturnValueOnce(new Promise((r) => (answer = r)));
		const { result } = await render();
		act(() => result.current.check(film));
		act(() => result.current.release());
		answer({ formats: [mp4], sources: [0], duration: null, generation: 1 });
		await flush();
		expect(result.current.statuses.size).toBe(0);
	});

	it("shows a receiver it couldn't check as unreachable", async () => {
		tauri.getStreamFormats.mockRejectedValue("unreachable");
		const { result } = await render();
		act(() => result.current.check(film));
		await flush();
		expect(result.current.statuses.get("cast:tv")).toEqual({
			blocked: "unreachable",
			detail: undefined,
		});
	});

	it("stops this device, then casts from where it was, by the route it showed", async () => {
		const { result } = await render();
		act(() => result.current.check(film));
		await flush();
		let why: string | null = "";
		await act(async () => {
			why = await result.current.send("cast:tv", film, { startAt: 600, stopLocal });
		});
		expect(why).toBeNull();
		expect(stopLocal).toHaveBeenCalled();
		expect(stopLocal.mock.invocationCallOrder[0]).toBeLessThan(
			tauri.castLoad.mock.invocationCallOrder[0]
		);
		expect(tauri.castLoad).toHaveBeenCalledWith(
			"cast:tv",
			film,
			{ via: "direct", generation: 5, source: 2, container: "mp4" },
			600
		);
		expect(result.current.destination?.id).toBe("cast:tv");
		expect(result.current.state?.status).toBe("opening");
		expect(tauri.holdCastReceivers).toHaveBeenLastCalledWith(["cast:tv"]);
		// The receiver's updates reach it.
		act(() =>
			events.emit("cast://update", {
				receiverId: "cast:tv",
				update: {
					kind: "media",
					media: {
						player: "playing",
						idleReason: null,
						position: 1,
						duration: 5400,
						live: false,
						canPause: true,
						canSeek: true,
					},
				},
			})
		);
		expect(result.current.state?.status).toBe("playing");
		// One for another receiver doesn't.
		act(() =>
			events.emit("cast://update", { receiverId: "cast:den", update: { kind: "ready" } })
		);
		expect(result.current.state?.status).toBe("playing");
	});

	it("works out the route at cast time when the picker didn't", async () => {
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		expect(tauri.castLoad).toHaveBeenCalledWith("cast:tv", film, expect.anything(), undefined);
	});

	it("says why it can't cast, before stopping anything", async () => {
		tauri.getStreamFormats.mockResolvedValue({
			formats: [{ ...mp4, container: "other" }],
			sources: [0],
			duration: null,
			generation: 1,
		});
		// Without the converter, nothing plays this.
		tauri.getConverterSupport.mockResolvedValue({ convert: false, hardwareEncoder: false });
		const { result } = await render();
		let why: string | null = null;
		await act(async () => {
			why = await result.current.send("cast:tv", film, { stopLocal });
		});
		expect(why).toBe("Can't play this format (other)");
		await act(async () => {
			why = await result.current.send("cast:nowhere", film, { stopLocal });
		});
		expect(why).toBe("That receiver is gone.");
		expect(stopLocal).not.toHaveBeenCalled();
	});

	it("says why a cast failed once this device has stopped, and lets the receiver go", async () => {
		tauri.castLoad.mockRejectedValueOnce("unreachable");
		const { result } = await render();
		let why: string | null = null;
		await act(async () => {
			why = await result.current.send("cast:tv", film, { stopLocal });
		});
		expect(why).toBe("Couldn't reach Hotel TV. Nothing is playing.");
		expect(result.current.destination).toBeNull();
		expect(tauri.castStop).toHaveBeenCalledWith("cast:tv");
	});

	it("goes back to this device when the cast is lost, and says why", async () => {
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		act(() =>
			events.emit("cast://update", { receiverId: "cast:tv", update: { kind: "ready" } })
		);
		act(() =>
			events.emit("cast://update", {
				receiverId: "cast:tv",
				update: { kind: "closed", reason: "appStopped" },
			})
		);
		expect(result.current.destination).toBeNull();
		expect(result.current.state).toBeNull();
		expect(report).toHaveBeenCalledWith("Playback was stopped on Hotel TV.");
	});

	it("says it lost the connection when the receiver gave no reason", async () => {
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		act(() =>
			events.emit("cast://update", {
				receiverId: "cast:tv",
				update: { kind: "closed", reason: "timeout" },
			})
		);
		expect(report).toHaveBeenCalledWith("Lost the connection to Hotel TV.");
	});

	it("ends the cast on a stop, and when another receiver takes over", async () => {
		tauri.getCastReceivers.mockResolvedValue(receivers(1, [tv, den]));
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		await act(async () => {
			await result.current.send("cast:den", film, { stopLocal });
		});
		expect(tauri.castStop).toHaveBeenCalledWith("cast:tv");
		expect(result.current.destination?.id).toBe("cast:den");
		// A stop of the old one doesn't count as losing the new one.
		act(() =>
			events.emit("cast://update", {
				receiverId: "cast:tv",
				update: { kind: "closed", reason: "stopped" },
			})
		);
		expect(result.current.destination?.id).toBe("cast:den");
		await act(() => result.current.stop());
		expect(tauri.castStop).toHaveBeenCalledWith("cast:den");
		expect(result.current.destination).toBeNull();
		await act(() => result.current.stop());
	});

	it("ends the cast when the page goes", async () => {
		const { result, unmount } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		unmount();
		await flush();
		expect(tauri.castStop).toHaveBeenCalledWith("cast:tv");
		expect(events.count("cast://update")).toBe(0);
	});

	it("streams through this computer once Settings turns that on", async () => {
		const { result } = await render();
		act(() => result.current.check(film));
		await flush();
		expect(result.current.statuses.get("cast:tv")).toEqual({ via: "direct" });
		act(() => writeStreamThrough(true));
		act(() => result.current.check(film));
		await flush();
		expect(result.current.statuses.get("cast:tv")).toEqual({ via: "converted", keep: "on" });
		act(() => writeStreamThrough(false));
		act(() => result.current.check(film));
		await flush();
		expect(result.current.statuses.get("cast:tv")).toEqual({ via: "direct" });
	});
});
