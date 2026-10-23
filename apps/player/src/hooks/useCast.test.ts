// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type * as Bridge from "@/lib/tauri";
import type { StreamFormats } from "@/lib/route-profiles";
import type { StreamFormat } from "@/lib/route";
import { makeMovie } from "@/test/detail-fixtures";
import { writeStreamThrough } from "@/lib/player-prefs";
import { RELEASE_RETRY_MS, type NowPlaying } from "@/lib/now-playing";

// The cast and the store outlive a page, so each test gets its own.
let useCast: typeof import("./useCast").useCast;
let nowPlaying: NowPlaying;

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
	castRelease: vi.fn<typeof Bridge.castRelease>(async () => {}),
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

beforeEach(async () => {
	vi.resetModules();
	({ useCast } = await import("./useCast"));
	({ nowPlaying } = await import("@/lib/now-playing"));
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
	const hook = renderHook(() => useCast(enabled));
	await flush();
	return hook;
};

describe("useCast", () => {
	it("lists nothing and asks for nothing when it's off", async () => {
		const { result } = await render(false);
		expect(result.current.receivers).toEqual([]);
		expect(result.current).toMatchObject({ localNetworkDenied: false, vpnActive: false });
		expect(tauri.getCastReceivers).not.toHaveBeenCalled();
		expect(tauri.holdCastReceivers).not.toHaveBeenCalled();
		expect(events.count("cast://receivers")).toBe(0);
	});

	it("starts looking once it's turned on, and holds nothing until asked", async () => {
		tauri.getCastReceivers.mockReturnValueOnce(new Promise(() => {}));
		const hook = renderHook(({ on }) => useCast(on), { initialProps: { on: false } });
		hook.rerender({ on: true });
		await flush();
		expect(tauri.getCastReceivers).toHaveBeenCalledTimes(1);
		// Nothing is known before the first list comes.
		expect(hook.result.current).toMatchObject({
			receivers: [],
			localNetworkDenied: false,
			vpnActive: false,
		});
		expect(tauri.holdCastReceivers).toHaveBeenCalledWith([]);
	});

	it("drops answers that come after it was turned off", async () => {
		let list: (l: Bridge.CastReceiverList) => void = () => {};
		let vpn: (on: boolean) => void = () => {};
		tauri.getCastReceivers.mockReturnValueOnce(new Promise((r) => (list = r)));
		tauri.getVpnActive.mockReturnValueOnce(new Promise((r) => (vpn = r)));
		const hook = renderHook(({ on }) => useCast(on), { initialProps: { on: true } });
		hook.rerender({ on: false });
		list(receivers(1, [tv]));
		vpn(true);
		await flush();
		expect(hook.result.current.receivers).toEqual([]);
		expect(hook.result.current.vpnActive).toBe(false);
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

	it("clears the last item's routes as soon as another is checked", async () => {
		const { result } = await render();
		act(() => result.current.check(film));
		await flush();
		expect(result.current.statuses.size).toBe(1);
		tauri.getStreamFormats.mockReturnValueOnce(new Promise(() => {}));
		act(() => result.current.check(makeMovie({ id: "mv2", name: "Another" })));
		expect(result.current.statuses.size).toBe(0);
	});

	it("drops a route from a check that a release and a new check came after", async () => {
		const answers: ((f: StreamFormats) => void)[] = [];
		tauri.getStreamFormats.mockImplementation(() => new Promise((r) => answers.push(r)));
		const { result } = await render();
		const other = makeMovie({ id: "mv2", name: "Another" });
		act(() => result.current.check(film));
		act(() => result.current.release());
		act(() => result.current.check(other));
		// The first check's answer comes last, for the film.
		answers[0]({
			formats: [{ ...mp4, container: "other" }],
			sources: [0],
			duration: null,
			generation: 1,
		});
		await flush();
		expect(result.current.statuses.size).toBe(0);
		answers[1]({ formats: [mp4], sources: [0], duration: null, generation: 2 });
		await flush();
		expect(result.current.statuses.get("cast:tv")).toEqual({ via: "direct" });
	});

	it("casts by the route the picker showed, without working it out again", async () => {
		const { result } = await render();
		act(() => result.current.check(film));
		await flush();
		expect(tauri.getConverterSupport).toHaveBeenCalledTimes(1);
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		expect(tauri.getConverterSupport).toHaveBeenCalledTimes(1);
	});

	it("holds the receiver it casts to, with no picker open", async () => {
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		expect(tauri.holdCastReceivers).toHaveBeenLastCalledWith(["cast:tv"]);
	});

	it("leaves a cast that's opening alone when the next item can't go", async () => {
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		expect(result.current.state?.status).toBe("opening");
		tauri.getConverterSupport.mockResolvedValue({ convert: false, hardwareEncoder: false });
		tauri.getStreamFormats.mockResolvedValue({
			formats: [{ ...mp4, container: "other" }],
			sources: [0],
			duration: null,
			generation: 6,
		});
		let why: string | null = null;
		await act(async () => {
			why = await result.current.send("cast:tv", makeMovie({ id: "mv2", name: "B" }), {
				stopLocal,
			});
		});
		expect(why).toBe("Can't play this format (other)");
		expect(result.current.state?.status).toBe("opening");
		expect(tauri.castRelease).not.toHaveBeenCalled();
	});

	it("says nothing of a loss that comes just after a stop", async () => {
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		await act(async () => {
			const stopping = result.current.stop();
			events.emit("cast://update", {
				receiverId: "cast:tv",
				update: { kind: "closed", reason: "timeout" },
			});
			await stopping;
		});
		expect(nowPlaying.getState().ended).toBeNull();
	});

	it("lets an older cast's failure go quietly once a newer one is under way", async () => {
		tauri.getCastReceivers.mockResolvedValue(receivers(1, [tv, den]));
		let fail: (e: unknown) => void = () => {};
		tauri.castLoad.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
		const { result } = await render();
		let first: Promise<string | null> = Promise.resolve(null);
		act(() => {
			first = result.current.send("cast:tv", film, { stopLocal });
		});
		await flush();
		await act(async () => {
			await result.current.send("cast:den", film, { stopLocal });
		});
		fail("unreachable");
		let why: string | null = null;
		await act(async () => {
			why = await first;
		});
		expect(why).toBeNull();
		expect(result.current.destination?.id).toBe("cast:den");
	});

	describe("a cast that something overtakes", () => {
		const other = makeMovie({ id: "mv2", name: "Another" });

		const casting = async () => {
			const hook = await render();
			await act(async () => {
				await hook.result.current.send("cast:tv", film, { stopLocal });
			});
			tauri.castLoad.mockClear();
			return hook;
		};

		/** Holds the next lookup until the test answers it. */
		const heldLookup = () => {
			let answer: () => void = () => {};
			tauri.getStreamFormats.mockReturnValueOnce(
				new Promise(
					(r) =>
						(answer = () =>
							r({ formats: [mp4], sources: [0], duration: 5400, generation: 9 }))
				)
			);
			return () => answer();
		};

		it("plays nothing when the cast stops while the next item is looked up", async () => {
			const { result } = await casting();
			const answer = heldLookup();
			let sent: Promise<string | null> = Promise.resolve("");
			act(() => {
				sent = result.current.send("cast:tv", other, { stopLocal });
			});
			await act(() => result.current.stop());
			answer();
			let why: string | null = "";
			await act(async () => {
				why = await sent;
			});
			expect(why).toBeNull();
			expect(tauri.castLoad).not.toHaveBeenCalled();
			expect(result.current.destination).toBeNull();
		});

		it("goes on casting when the page goes while a cast starts", async () => {
			const answer = heldLookup();
			const hook = await render();
			let sent: Promise<string | null> = Promise.resolve("");
			act(() => {
				sent = hook.result.current.send("cast:tv", film, { stopLocal });
			});
			hook.unmount();
			answer();
			await sent;
			expect(stopLocal).toHaveBeenCalled();
			expect(tauri.castLoad).toHaveBeenCalled();
			expect(nowPlaying.getState().destination?.id).toBe("cast:tv");
		});

		it("asks nothing when the cast stops while the next item is looked up", async () => {
			const { result } = await casting();
			let answer: () => void = () => {};
			tauri.getStreamFormats.mockReturnValueOnce(
				new Promise(
					(r) =>
						(answer = () =>
							r({ formats: [ac3], sources: [0], duration: 5400, generation: 9 }))
				)
			);
			const confirm = vi.fn(async () => true);
			let sent: Promise<string | null> = Promise.resolve("");
			act(() => {
				sent = result.current.send("cast:tv", other, { stopLocal, confirm });
			});
			await act(() => result.current.stop());
			answer();
			await act(async () => {
				await sent;
			});
			expect(confirm).not.toHaveBeenCalled();
		});

		it("plays nothing when the cast stops while it asks", async () => {
			const { result } = await casting();
			tauri.getStreamFormats.mockResolvedValue({
				formats: [ac3],
				sources: [0],
				duration: 5400,
				generation: 9,
			});
			let yes: (ok: boolean) => void = () => {};
			const confirm = vi.fn(() => new Promise<boolean>((r) => (yes = r)));
			let sent: Promise<string | null> = Promise.resolve("");
			act(() => {
				sent = result.current.send("cast:tv", other, { stopLocal, confirm });
			});
			await flush();
			expect(confirm).toHaveBeenCalled();
			stopLocal.mockClear();
			await act(() => result.current.stop());
			yes(true);
			let why: string | null = "";
			await act(async () => {
				why = await sent;
			});
			expect(why).toBeNull();
			expect(stopLocal).not.toHaveBeenCalled();
			expect(tauri.castLoad).not.toHaveBeenCalled();
		});

		it("plays nothing when the cast stops while this device stops", async () => {
			const { result } = await casting();
			let stopped: () => void = () => {};
			const slowStop = vi.fn(() => new Promise<void>((r) => (stopped = r)));
			let sent: Promise<string | null> = Promise.resolve("");
			act(() => {
				sent = result.current.send("cast:tv", other, { stopLocal: slowStop });
			});
			await flush();
			expect(slowStop).toHaveBeenCalled();
			await act(() => result.current.stop());
			stopped();
			await act(async () => {
				await sent;
			});
			expect(tauri.castLoad).not.toHaveBeenCalled();
			expect(result.current.destination).toBeNull();
		});

		it("looks no further once the cast stops while it waits to look again", async () => {
			vi.useFakeTimers();
			try {
				const { result } = await casting();
				tauri.getStreamFormats.mockRejectedValue("refused");
				let sent: Promise<string | null> = Promise.resolve("");
				act(() => {
					sent = result.current.send("cast:tv", other, { stopLocal });
				});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(RELEASE_RETRY_MS[0]);
				});
				const looks = tauri.getStreamFormats.mock.calls.length;
				await act(() => result.current.stop());
				await act(async () => {
					await vi.advanceTimersByTimeAsync(RELEASE_RETRY_MS[1] + RELEASE_RETRY_MS[2]);
				});
				let why: string | null = "";
				await act(async () => {
					why = await sent;
				});
				expect(why).toBeNull();
				expect(tauri.getStreamFormats).toHaveBeenCalledTimes(looks);
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps an older send quiet across a stop and a newer send", async () => {
			const { result } = await casting();
			const answer = heldLookup();
			let first: Promise<string | null> = Promise.resolve("");
			act(() => {
				first = result.current.send("cast:tv", other, { stopLocal });
			});
			await act(() => result.current.stop());
			// A newer one, still looking.
			tauri.getStreamFormats.mockReturnValueOnce(new Promise(() => {}));
			act(() => {
				void result.current.send("cast:tv", makeMovie({ id: "mv3", name: "C" }), {
					stopLocal,
				});
			});
			answer();
			let why: string | null = "";
			await act(async () => {
				why = await first;
			});
			expect(why).toBeNull();
			expect(tauri.castLoad).not.toHaveBeenCalled();
		});

		it("plays only the newest of two quick switches", async () => {
			const { result } = await casting();
			const answer = heldLookup();
			let first: Promise<string | null> = Promise.resolve("");
			act(() => {
				first = result.current.send("cast:tv", other, { stopLocal });
			});
			const third = makeMovie({ id: "mv3", name: "Third" });
			await act(async () => {
				await result.current.send("cast:tv", third, { stopLocal });
			});
			answer();
			let why: string | null = "";
			await act(async () => {
				why = await first;
			});
			expect(why).toBeNull();
			expect(tauri.castLoad).toHaveBeenCalledTimes(1);
			expect(tauri.castLoad).toHaveBeenLastCalledWith(
				"cast:tv",
				third,
				expect.anything(),
				undefined,
				false,
				false
			);
		});

		it("says nothing when the backend says a newer load or a stop came", async () => {
			const { result } = await casting();
			tauri.castLoad.mockRejectedValueOnce("superseded");
			let why: string | null = "";
			await act(async () => {
				why = await result.current.send("cast:tv", other, { stopLocal });
			});
			expect(why).toBeNull();
			expect(result.current.destination?.id).toBe("cast:tv");
		});

		it("keeps the cast, saying why, when a switch fails", async () => {
			const { result } = await casting();
			tauri.castLoad.mockRejectedValueOnce("refused");
			let why: string | null = "";
			await act(async () => {
				why = await result.current.send("cast:tv", other, { stopLocal });
			});
			expect(why).toBe(
				"The provider refused the stream. The login may have expired. Nothing is playing."
			);
			expect(result.current.destination?.id).toBe("cast:tv");
			expect(result.current.state).toMatchObject({
				status: "error",
				error: { message: "refused" },
			});
			expect(tauri.castStop).not.toHaveBeenCalled();
		});
	});

	it("checks a receiver found while the picker is open", async () => {
		const { result } = await render();
		act(() => result.current.check(film));
		await flush();
		expect(result.current.statuses.has("cast:den")).toBe(false);
		act(() => events.emit("cast://receivers", receivers(2, [tv, den])));
		await flush();
		expect(result.current.statuses.get("cast:den")).toEqual({ via: "direct" });
		// Only the new one was asked about.
		expect(tauri.getConverterSupport).toHaveBeenCalledTimes(2);
		// Once it's closed, a new one waits for the next time it opens.
		act(() => result.current.release());
		const third = { ...tv, id: "cast:third", name: "Third" };
		act(() => events.emit("cast://receivers", receivers(3, [tv, den, third])));
		await flush();
		expect(result.current.statuses.has("cast:third")).toBe(false);
		// Opened again, it checks it. One that's unavailable isn't.
		act(() => result.current.check(film));
		await flush();
		expect(result.current.statuses.get("cast:third")).toEqual({ via: "direct" });
		const gone = { ...tv, id: "cast:gone", name: "Gone", available: false };
		act(() => events.emit("cast://receivers", receivers(4, [tv, gone])));
		await flush();
		expect(result.current.statuses.has("cast:gone")).toBe(false);
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
			600,
			false,
			// This device's player just let go of the stream.
			true
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

	it("asks before this computer converts, and a no casts nothing", async () => {
		tauri.getStreamFormats.mockResolvedValue({
			formats: [ac3],
			sources: [0],
			duration: 5400,
			generation: 5,
		});
		const { result } = await render();
		const confirm = vi.fn(async () => false);
		let why: string | null = "";
		await act(async () => {
			why = await result.current.send("cast:tv", film, { stopLocal, confirm });
		});
		expect(why).toBeNull();
		expect(confirm).toHaveBeenCalledWith("on");
		expect(stopLocal).not.toHaveBeenCalled();
		expect(tauri.castLoad).not.toHaveBeenCalled();
		expect(result.current.destination).toBeNull();
		confirm.mockResolvedValueOnce(true);
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal, confirm });
		});
		expect(stopLocal).toHaveBeenCalled();
		expect(tauri.castLoad).toHaveBeenCalled();
		expect(result.current.current()?.id).toBe("cast:tv");
		// A direct route doesn't ask.
		tauri.getStreamFormats.mockResolvedValue({
			formats: [mp4],
			sources: [0],
			duration: 5400,
			generation: 6,
		});
		const other = makeMovie({ id: "mv2", name: "Another" });
		confirm.mockClear();
		await act(async () => {
			await result.current.send("cast:tv", other, { stopLocal, confirm });
		});
		expect(confirm).not.toHaveBeenCalled();
	});

	it("keeps the routes the picker showed for the item it showed them for", async () => {
		const { result } = await render();
		act(() => result.current.check(film));
		await flush();
		const other = makeMovie({ id: "mv2", name: "Another" });
		tauri.getStreamFormats.mockResolvedValue({
			formats: [{ ...mp4, container: "other" }],
			sources: [0],
			duration: null,
			generation: 6,
		});
		tauri.getConverterSupport.mockResolvedValue({ convert: false, hardwareEncoder: false });
		let why: string | null = null;
		await act(async () => {
			why = await result.current.send("cast:tv", other, { stopLocal });
		});
		// The film's direct route isn't taken for another item.
		expect(why).toBe("Can't play this format (other)");
	});

	it("knows at once when the cast stops", async () => {
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		expect(result.current.current()?.id).toBe("cast:tv");
		let during: unknown = "unset";
		await act(async () => {
			const stopping = result.current.stop();
			during = result.current.current();
			await stopping;
		});
		expect(during).toBeNull();
	});

	describe("switching to another item on an account with one connection", () => {
		const other = makeMovie({ id: "mv2", name: "Another" });
		const formats = (generation: number): StreamFormats => ({
			formats: [mp4],
			sources: [0],
			duration: 5400,
			generation,
		});

		/** A provider that refuses a second connection while the cast holds one. */
		const oneConnection = () => {
			let held = true;
			tauri.castRelease.mockImplementation(async () => {
				held = false;
			});
			tauri.getStreamFormats.mockImplementation(async () => {
				if (held) throw "refused";
				return formats(6);
			});
		};

		const casting = async () => {
			const hook = await render();
			await act(async () => {
				await hook.result.current.send("cast:tv", film, { stopLocal });
			});
			return hook;
		};

		it("lets go of the stream, then looks again and plays the new item", async () => {
			const { result } = await casting();
			oneConnection();
			let why: string | null = "";
			await act(async () => {
				why = await result.current.send("cast:tv", other, { stopLocal });
			});
			expect(why).toBeNull();
			expect(tauri.castRelease).toHaveBeenCalledWith("cast:tv");
			expect(tauri.castStop).not.toHaveBeenCalled();
			expect(tauri.castLoad).toHaveBeenLastCalledWith(
				"cast:tv",
				other,
				expect.objectContaining({ via: "direct", generation: 6 }),
				undefined,
				false,
				false
			);
			expect(result.current.destination?.id).toBe("cast:tv");
		});

		it("waits a moment longer for a receiver that's slow to hang up", async () => {
			vi.useFakeTimers();
			try {
				const { result } = await casting();
				let tries = 0;
				tauri.getStreamFormats.mockImplementation(async () => {
					tries++;
					if (tries < 3) throw "refused";
					return formats(6);
				});
				let why: string | null = "";
				const sent = result.current
					.send("cast:tv", other, { stopLocal })
					.then((w) => (why = w));
				// It waits for each look.
				await flush();
				expect(tries).toBe(1);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(RELEASE_RETRY_MS[0]);
				});
				expect(tries).toBe(2);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(RELEASE_RETRY_MS[1] - 1);
				});
				expect(tries).toBe(2);
				// While it waits, the receiver shows the next item on its way.
				expect(result.current.state?.status).toBe("opening");
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1);
				});
				expect(tries).toBe(3);
				await act(() => sent);
				expect(why).toBeNull();
			} finally {
				vi.useRealTimers();
			}
		});

		it("says why once it let go and the provider still refuses, never before", async () => {
			vi.useFakeTimers();
			try {
				const { result } = await casting();
				tauri.getStreamFormats.mockRejectedValue("refused");
				let why: string | null = "";
				const sent = result.current
					.send("cast:tv", other, { stopLocal })
					.then((w) => (why = w));
				await act(async () => {
					await vi.advanceTimersByTimeAsync(RELEASE_RETRY_MS.reduce((a, b) => a + b, 0));
				});
				await act(() => sent);
				expect(tauri.castRelease).toHaveBeenCalledTimes(1);
				expect(tauri.getStreamFormats).toHaveBeenCalledTimes(
					1 + RELEASE_RETRY_MS.length + 1
				);
				expect(why).toBe(
					"The provider refused the stream. The login may have expired. Nothing is playing."
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("shows the cast stopped when the user says no after it let go", async () => {
			const { result } = await casting();
			oneConnection();
			tauri.getStreamFormats.mockImplementation(async () => {
				if (tauri.castRelease.mock.calls.length === 0) throw "refused";
				return { formats: [ac3], sources: [0], duration: 5400, generation: 6 };
			});
			let why: string | null = "";
			await act(async () => {
				why = await result.current.send("cast:tv", other, {
					stopLocal,
					confirm: async () => false,
				});
			});
			expect(why).toBeNull();
			expect(result.current.state).toMatchObject({ status: "idle" });
			expect(result.current.destination?.id).toBe("cast:tv");
		});

		it("doesn't let go of anything for a first cast that can't be routed", async () => {
			tauri.getStreamFormats.mockRejectedValue("refused");
			const { result } = await render();
			let why: string | null = "";
			await act(async () => {
				why = await result.current.send("cast:tv", film, { stopLocal });
			});
			expect(why).toBe("Couldn't reach the stream");
			expect(tauri.castRelease).not.toHaveBeenCalled();
		});
	});

	it("works out the route at cast time when the picker didn't", async () => {
		const { result } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		expect(tauri.castLoad).toHaveBeenCalledWith(
			"cast:tv",
			film,
			expect.anything(),
			undefined,
			false,
			true
		);
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
		expect(tauri.castStop).not.toHaveBeenCalled();
		act(() =>
			events.emit("cast://update", {
				receiverId: "cast:tv",
				update: { kind: "closed", reason: "appStopped" },
			})
		);
		expect(result.current.destination).toBeNull();
		expect(result.current.state).toBeNull();
		expect(nowPlaying.getState().ended).toBe("Playback was stopped on Hotel TV.");
		// The destination is stopped too, so nothing it had under way, such
		// as starting its stream again, brings it back.
		expect(tauri.castStop).toHaveBeenCalledWith("cast:tv");
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
		expect(nowPlaying.getState().ended).toBe("Lost the connection to Hotel TV.");
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

	it("goes on casting, with the receiver's updates, when the page goes", async () => {
		const { result, unmount } = await render();
		await act(async () => {
			await result.current.send("cast:tv", film, { stopLocal });
		});
		unmount();
		await flush();
		expect(tauri.castStop).not.toHaveBeenCalled();
		expect(events.count("cast://receivers")).toBe(0);
		const cast = nowPlaying.getState().destination!;
		events.emit("cast://update", { receiverId: "cast:tv", update: { kind: "ready" } });
		expect(cast.getState().connection).toBe("connected");
		// A page that opens again finds it.
		const again = await render();
		expect(again.result.current.destination).toBe(cast);
		expect(again.result.current.current()).toBe(cast);
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
