// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackDestination } from "./destination";
import { createNowPlaying, RELEASE_RETRY_MS, type SendOptions } from "./now-playing";
import * as tauri from "./tauri";
import type { RouteDecision } from "./route";
import { deferred } from "@/test/deferred";
import { fakeDestination, playbackState } from "@/test/destination-fixtures";
import { makeMovie } from "@/test/detail-fixtures";

const direct: RouteDecision = { ok: true, route: { via: "direct", format: 0 } };
const converted: RouteDecision = {
	ok: true,
	route: {
		via: "converted",
		format: 0,
		video: "copy",
		audio: "copy",
		output: "matroska",
		keep: "on",
	},
};

const film = makeMovie({ id: "mv1", name: "A Film" });
const other = makeMovie({ id: "mv2", name: "Another Film" });

/** A TV whose route is `decision`, which also has release and dispose. */
const tv = (name = "Hotel TV", decision: RouteDecision = direct) => {
	const d = fakeDestination("cast", name);
	return {
		...d,
		route: vi.fn<PlaybackDestination["route"]>().mockResolvedValue(decision),
		release: vi.fn<() => Promise<void>>(() => Promise.resolve()),
		dispose: vi.fn(),
	};
};

vi.mock("./tauri", () => ({
	savePlaybackPosition: vi.fn(async () => {}),
	deletePlaybackPosition: vi.fn(async () => {}),
	markPositionFinished: vi.fn(async () => {}),
}));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.mocked(tauri.savePlaybackPosition).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

const setUp = () => {
	const waits: number[] = [];
	const store = createNowPlaying({
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	const changes = vi.fn();
	store.subscribe(changes);
	return {
		store,
		save: vi.mocked(tauri.savePlaybackPosition),
		waits,
		changes,
		tick: (ms: number) => vi.advanceTimersByTime(ms),
	};
};

const opts = (more: Partial<SendOptions> = {}): SendOptions => ({
	stopLocal: vi.fn(() => Promise.resolve()),
	...more,
});

describe("createNowPlaying", () => {
	it("has nothing at first", () => {
		const { store } = setUp();
		expect(store.getState()).toEqual({ destination: null, channel: null, ended: null });
	});

	it("works out the route, stops this device's player, and loads it there", async () => {
		const { store, changes } = setUp();
		const target = tv();
		const order: string[] = [];
		target.route.mockImplementation(async () => {
			order.push("route");
			return direct;
		});
		target.load.mockImplementation(async () => {
			order.push(`load with ${store.getState().destination?.name}`);
		});
		const stopLocal = vi.fn(async () => {
			order.push("stopLocal");
		});
		expect(await store.send(target, film, { startAt: 600, stopLocal })).toEqual({ ok: true });
		expect(order).toEqual(["route", "stopLocal", "load with Hotel TV"]);
		expect(target.route).toHaveBeenCalledWith({ kind: "local", channel: film });
		expect(target.load).toHaveBeenCalledWith(
			{ kind: "local", channel: film },
			{ startAt: 600, route: direct.ok && direct.route, freed: true }
		);
		expect(store.getState()).toEqual({ destination: target, channel: film, ended: null });
		expect(changes).toHaveBeenCalled();
	});

	it("takes the route the picker worked out", async () => {
		const { store } = setUp();
		const target = tv();
		await store.send(target, film, opts({ decision: converted }));
		expect(target.route).not.toHaveBeenCalled();
		expect(target.load).toHaveBeenCalledWith(
			{ kind: "local", channel: film },
			expect.objectContaining({ route: converted.ok && converted.route })
		);
	});

	it("says why it can't go there, and leaves this device playing", async () => {
		const { store } = setUp();
		const blocked: RouteDecision = { ok: false, reason: "unreachable" };
		const target = tv("Hotel TV", blocked);
		const o = opts();
		expect(await store.send(target, film, o)).toEqual({
			ok: false,
			why: "blocked",
			decision: blocked,
			released: false,
		});
		expect(o.stopLocal).not.toHaveBeenCalled();
		expect(store.getState().destination).toBeNull();
	});

	it("asks before converting, and sends nothing on a no", async () => {
		const { store } = setUp();
		const target = tv("Hotel TV", converted);
		const confirm = vi.fn(async () => false);
		const o = opts({ confirm });
		expect(await store.send(target, film, o)).toEqual({
			ok: false,
			why: "declined",
			released: false,
		});
		expect(confirm).toHaveBeenCalledWith("on");
		expect(o.stopLocal).not.toHaveBeenCalled();
		expect(target.load).not.toHaveBeenCalled();
		confirm.mockResolvedValueOnce(true);
		expect(await store.send(target, film, o)).toEqual({ ok: true });
	});

	it("doesn't ask for a route it doesn't convert", async () => {
		const { store } = setUp();
		const confirm = vi.fn(async () => false);
		expect(await store.send(tv(), film, opts({ confirm }))).toEqual({ ok: true });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("lets the newest send win wherever the older one is", async () => {
		const { store } = setUp();
		const first = tv("Den TV");
		const routed = deferred<RouteDecision>();
		first.route.mockReturnValueOnce(routed.promise);
		const o = opts();
		const older = store.send(first, film, o);
		const second = tv("Hotel TV");
		expect(await store.send(second, other, opts())).toEqual({ ok: true });
		routed.resolve(direct);
		expect(await older).toEqual({ ok: false, why: "overtaken" });
		expect(o.stopLocal).not.toHaveBeenCalled();
		expect(store.getState().destination).toBe(second);
	});

	it("gives up when a send overtakes it while this device stops", async () => {
		const { store } = setUp();
		const target = tv();
		const stopping = deferred();
		const older = store.send(target, film, opts({ stopLocal: () => stopping.promise }));
		await vi.waitFor(() => expect(target.route).toHaveBeenCalled());
		const newer = store.send(target, other, opts());
		stopping.resolve();
		expect(await older).toEqual({ ok: false, why: "overtaken" });
		expect(await newer).toEqual({ ok: true });
		expect(target.load).toHaveBeenCalledTimes(1);
	});

	it("gives up when a stop comes while it asks", async () => {
		const { store } = setUp();
		const target = tv("Hotel TV", converted);
		const answer = deferred<boolean>();
		const o = opts({ confirm: () => answer.promise });
		const sending = store.send(target, film, o);
		await vi.waitFor(() => expect(target.route).toHaveBeenCalled());
		await store.stop();
		answer.resolve(true);
		expect(await sending).toEqual({ ok: false, why: "overtaken" });
		expect(o.stopLocal).not.toHaveBeenCalled();
		expect(target.load).not.toHaveBeenCalled();
	});

	it("stops the TV that played before when another takes over", async () => {
		const { store } = setUp();
		const first = tv("Den TV");
		await store.send(first, film, opts());
		const second = tv("Hotel TV");
		await store.send(second, other, opts());
		expect(first.stop).toHaveBeenCalled();
		expect(first.dispose).toHaveBeenCalled();
		expect(second.load).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ freed: true })
		);
	});

	it("keeps the TV that plays when it switches items there", async () => {
		const { store } = setUp();
		const target = tv();
		await store.send(target, film, opts());
		await store.send(target, other, opts());
		expect(target.stop).not.toHaveBeenCalled();
		expect(target.dispose).not.toHaveBeenCalled();
		// The TV closes its own connection when it switches.
		expect(target.load).toHaveBeenLastCalledWith(
			{ kind: "local", channel: other },
			expect.objectContaining({ freed: false })
		);
		expect(store.getState().channel).toBe(other);
	});

	it("stops a first TV that couldn't load it, and says why", async () => {
		const { store } = setUp();
		const target = tv();
		target.load.mockRejectedValueOnce("refused");
		expect(await store.send(target, film, opts())).toEqual({
			ok: false,
			why: "failed",
			error: "refused",
			switching: false,
		});
		expect(store.getState().destination).toBeNull();
		await vi.waitFor(() => expect(target.dispose).toHaveBeenCalled());
		expect(target.stop).toHaveBeenCalled();
	});

	it("keeps a TV whose switch to another item failed", async () => {
		const { store } = setUp();
		const target = tv();
		await store.send(target, film, opts());
		target.load.mockRejectedValueOnce("refused");
		expect(await store.send(target, other, opts())).toEqual({
			ok: false,
			why: "failed",
			error: "refused",
			switching: true,
		});
		expect(store.getState().destination).toBe(target);
		expect(target.stop).not.toHaveBeenCalled();
	});

	it("leaves a newer send alone when an older load fails", async () => {
		const { store } = setUp();
		const target = tv();
		const loading = deferred();
		target.load.mockReturnValueOnce(loading.promise);
		const older = store.send(target, film, opts());
		await vi.waitFor(() => expect(target.load).toHaveBeenCalled());
		const newer = store.send(target, other, opts());
		loading.reject("superseded");
		expect(await older).toEqual({ ok: false, why: "overtaken" });
		expect(await newer).toEqual({ ok: true });
		expect(store.getState().destination).toBe(target);
	});

	describe("a route that fails", () => {
		it("lets the TV that plays go of its stream, and looks again", async () => {
			const { store, waits } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			target.route
				.mockRejectedValueOnce("refused")
				.mockRejectedValueOnce("refused")
				.mockResolvedValueOnce(direct);
			expect(await store.send(target, other, opts())).toEqual({ ok: true });
			expect(target.release).toHaveBeenCalledTimes(1);
			expect(waits).toEqual(RELEASE_RETRY_MS.slice(0, 2));
		});

		it("says so once every look failed, and that it let go", async () => {
			const { store, waits } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			target.route.mockRejectedValue("refused");
			expect(await store.send(target, other, opts())).toEqual({
				ok: false,
				why: "unrouted",
				error: "refused",
				released: true,
			});
			expect(waits).toEqual(RELEASE_RETRY_MS);
			expect(target.route).toHaveBeenCalledTimes(2 + RELEASE_RETRY_MS.length);
		});

		it("says so at once for a TV that doesn't play", async () => {
			const { store, waits } = setUp();
			const target = tv();
			target.route.mockRejectedValue("unreachable");
			expect(await store.send(target, film, opts())).toEqual({
				ok: false,
				why: "unrouted",
				error: "unreachable",
				released: false,
			});
			expect(target.release).not.toHaveBeenCalled();
			expect(waits).toEqual([]);
		});

		it("doesn't let go of another TV's stream", async () => {
			const { store } = setUp();
			const playing = tv("Den TV");
			await store.send(playing, film, opts());
			const target = tv();
			target.route.mockRejectedValue("refused");
			expect(await store.send(target, other, opts())).toMatchObject({ released: false });
			expect(playing.release).not.toHaveBeenCalled();
			expect(target.release).not.toHaveBeenCalled();
		});

		it("gives up when another send overtook it while it waited", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			const released = deferred();
			target.release.mockReturnValueOnce(released.promise);
			target.route.mockRejectedValueOnce("refused");
			const older = store.send(target, other, opts());
			await vi.waitFor(() => expect(target.release).toHaveBeenCalled());
			const newer = store.send(target, film, opts({ decision: direct }));
			released.resolve();
			expect(await older).toEqual({ ok: false, why: "overtaken" });
			expect(await newer).toEqual({ ok: true });
		});
	});

	describe("the resume point", () => {
		it("saves where the TV is, once it got to where it started", async () => {
			const { store, save, tick } = setUp();
			const target = tv();
			await store.send(target, film, opts({ startAt: 600 }));
			// Where the item starts, before the TV got there, changes nothing.
			tick(5000);
			target.set(playbackState({ position: 2 }));
			target.set(playbackState({ position: 594 }));
			expect(save).not.toHaveBeenCalled();
			target.set(playbackState({ position: 595 }));
			expect(save).toHaveBeenLastCalledWith("movie:a film", 595, 5400);
		});

		it("saves as soon as it's paused, and otherwise every few seconds", async () => {
			const { store, save, tick } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			save.mockClear();
			target.set(playbackState({ position: 610 }));
			expect(save).not.toHaveBeenCalled();
			target.set(playbackState({ position: 611, status: "paused" }));
			expect(save).toHaveBeenCalledTimes(1);
			tick(4999);
			target.set(playbackState({ position: 612 }));
			expect(save).toHaveBeenCalledTimes(1);
			tick(1);
			target.set(playbackState({ position: 613 }));
			expect(save).toHaveBeenCalledTimes(2);
		});

		it("ignores what the TV says about another item", async () => {
			const { store, save, tick } = setUp();
			const target = tv();
			await store.send(target, other, opts());
			save.mockClear();
			tick(5000);
			// The fixture's item is the film, not the one sent.
			target.set(playbackState({ position: 900 }));
			expect(save).not.toHaveBeenCalled();
		});

		it("keeps no resume point for live", async () => {
			const { store, save, tick } = setUp();
			const target = tv();
			const live = makeMovie({ id: "mv1", contentType: "live" });
			await store.send(target, live, opts());
			save.mockClear();
			tick(5000);
			target.set(playbackState({ position: 900 }));
			expect(save).not.toHaveBeenCalled();
		});

		it("saves the last item's place when another starts, and on stop", async () => {
			const { store, save, tick } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			tick(1000);
			target.set(playbackState({ position: 700 }));
			expect(save).not.toHaveBeenCalled();
			await store.send(target, other, opts());
			expect(save).toHaveBeenLastCalledWith("movie:a film", 700, 5400);
			const item = { title: "Another Film", contentType: "movie" as const, ref: "mv2" };
			target.set(playbackState({ item, position: 800 }));
			await store.stop();
			expect(save).toHaveBeenLastCalledWith("movie:another film", 800, 5400);
		});

		it("stops following a TV once it's gone", async () => {
			const { store, save } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			await store.stop();
			save.mockClear();
			target.set(playbackState({ position: 800, status: "paused" }));
			expect(save).not.toHaveBeenCalled();
		});
	});

	describe("stop", () => {
		it("stops the TV, forgets it, and lets go of it", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			await store.stop();
			expect(target.stop).toHaveBeenCalled();
			expect(target.dispose).toHaveBeenCalled();
			expect(store.getState()).toEqual({ destination: null, channel: null, ended: null });
		});

		it("lets go of the TV even when it couldn't stop", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			target.stop.mockRejectedValueOnce("gone");
			await expect(store.stop()).rejects.toBe("gone");
			expect(target.dispose).toHaveBeenCalled();
		});

		it("does nothing with nothing playing", async () => {
			const { store, changes } = setUp();
			await store.stop();
			expect(changes).not.toHaveBeenCalled();
		});
	});

	describe("a lost connection", () => {
		it("ends a TV that ends when lost, and says why", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(
				target,
				film,
				opts({ lost: () => "Lost the connection to Hotel TV." })
			);
			target.set(playbackState({ connection: "lost" }));
			expect(store.getState()).toEqual({
				destination: null,
				channel: null,
				ended: "Lost the connection to Hotel TV.",
			});
			expect(target.stop).toHaveBeenCalled();
			store.dismiss();
			expect(store.getState().ended).toBeNull();
		});

		it("keeps one that waits for the user", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			target.set(playbackState({ connection: "lost" }));
			expect(store.getState().destination).toBe(target);
			expect(target.stop).not.toHaveBeenCalled();
		});

		it("forgets why the last one ended once another starts", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts({ lost: () => "Lost." }));
			target.set(playbackState({ connection: "lost" }));
			await store.send(target, film, opts());
			expect(store.getState().ended).toBeNull();
		});
	});

	it("stops telling a listener that went", async () => {
		const { store } = setUp();
		const listener = vi.fn();
		const unsubscribe = store.subscribe(listener);
		unsubscribe();
		await store.send(tv(), film, opts());
		expect(listener).not.toHaveBeenCalled();
	});
});
