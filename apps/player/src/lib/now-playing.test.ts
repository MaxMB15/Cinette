// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackDestination, PlaybackState } from "./destination";
import {
	createNowPlaying,
	RELEASE_RETRY_MS,
	sentMessage,
	type SendOptions,
	type UpNext,
} from "./now-playing";
import * as tauri from "./tauri";
import type { RouteDecision } from "./route";
import { deferred } from "@/test/deferred";
import { fakeDestination, playbackState } from "@/test/destination-fixtures";
import { makeEpisode, makeMovie } from "@/test/detail-fixtures";
import type { Channel } from "./types";

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
		release: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
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

const lostEnds = (s: PlaybackState) =>
	s.connection === "lost" ? "Lost the connection to Hotel TV." : null;

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

	it("loads it with the subtitle it was given", async () => {
		const { store } = setUp();
		const target = tv();
		const subtitle = { cues: [], delay: 0, name: "English", language: "en" };
		await store.send(target, film, opts({ subtitle }));
		expect(target.load).toHaveBeenCalledWith(
			{ kind: "local", channel: film },
			expect.objectContaining({ subtitle })
		);
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
			// It let go of the stream itself, so the provider may still count it.
			expect(target.load).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.objectContaining({ freed: true })
			);
		});

		it("keeps a TV that had nothing to let go of, and doesn't look again", async () => {
			const { store, waits } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			target.release.mockResolvedValueOnce(false);
			target.route.mockRejectedValueOnce("refused");
			expect(await store.send(target, other, opts())).toEqual({
				ok: false,
				why: "unrouted",
				error: "refused",
				released: false,
			});
			expect(waits).toEqual([]);
			expect(store.getState().destination).toBe(target);
			expect(target.stop).not.toHaveBeenCalled();
		});

		it("counts a TV that couldn't let go as one that may have", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			target.release.mockRejectedValueOnce("failed");
			target.route.mockRejectedValue("refused");
			expect(await store.send(target, other, opts())).toMatchObject({ released: true });
			expect(store.getState().destination).toBeNull();
		});

		it("leaves a newer send alone when its last look fails after that one started", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			const last = deferred<RouteDecision>();
			// Every look fails but the last, which waits.
			for (let i = 0; i < RELEASE_RETRY_MS.length; i++)
				target.route.mockRejectedValueOnce("x");
			target.route.mockReturnValueOnce(last.promise);
			const older = store.send(target, other, opts());
			await vi.waitFor(() =>
				expect(target.route).toHaveBeenCalledTimes(2 + RELEASE_RETRY_MS.length)
			);
			const newer = store.send(target, film, opts({ decision: direct }));
			expect(await newer).toEqual({ ok: true });
			last.reject("refused");
			expect(await older).toEqual({ ok: false, why: "overtaken" });
			expect(store.getState()).toMatchObject({ destination: target, channel: film });
			expect(target.stop).not.toHaveBeenCalled();
		});

		it("leaves a newer send alone when the user says no to an older one after", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			target.route.mockRejectedValueOnce("refused").mockResolvedValueOnce(converted);
			const answer = deferred<boolean>();
			const older = store.send(target, other, opts({ confirm: () => answer.promise }));
			await vi.waitFor(() => expect(target.route).toHaveBeenCalledTimes(3));
			const newer = store.send(target, film, opts({ decision: direct }));
			expect(await newer).toEqual({ ok: true });
			answer.resolve(false);
			expect(await older).toEqual({ ok: false, why: "overtaken" });
			expect(store.getState()).toMatchObject({ destination: target, channel: film });
			expect(target.stop).not.toHaveBeenCalled();
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
			// It let go of its stream and got nothing new, so it goes.
			expect(store.getState().destination).toBeNull();
			expect(target.stop).toHaveBeenCalled();
		});

		it("stops the TV that let go when the next item is blocked or called off", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			const blocked: RouteDecision = { ok: false, reason: "unreachable" };
			target.route.mockRejectedValueOnce("refused").mockResolvedValueOnce(blocked);
			expect(await store.send(target, other, opts())).toMatchObject({
				why: "blocked",
				released: true,
			});
			expect(store.getState().destination).toBeNull();
			await store.send(target, film, opts());
			target.route.mockRejectedValueOnce("refused").mockResolvedValueOnce(converted);
			expect(
				await store.send(target, other, opts({ confirm: async () => false }))
			).toMatchObject({ why: "declined", released: true });
			expect(store.getState().destination).toBeNull();
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
			const released = deferred<boolean>();
			target.release.mockReturnValueOnce(released.promise);
			target.route.mockRejectedValueOnce("refused");
			const older = store.send(target, other, opts());
			await vi.waitFor(() => expect(target.release).toHaveBeenCalled());
			const newer = store.send(target, film, opts({ decision: direct }));
			released.resolve(true);
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

	it("saves where the TV got to when asked", async () => {
		const { store, save, tick } = setUp();
		const target = tv();
		await store.send(target, film, opts());
		tick(1000);
		target.set(playbackState({ position: 700 }));
		expect(save).not.toHaveBeenCalled();
		await store.flush();
		expect(save).toHaveBeenCalledWith("movie:a film", 700, 5400);
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

	describe("the next episode", () => {
		const ep1 = makeEpisode(1, 1, "Pilot");
		const ep2 = makeEpisode(1, 2, "Second");
		/** The TV's state at the end of `ep`. */
		const ended = (ep: Channel) =>
			playbackState({
				status: "ended",
				item: { title: ep.name, contentType: "series", ref: ep.id },
			});
		const upNext = (more: Partial<UpNext> = {}): UpNext => ({
			episodes: [ep1, ep2],
			autoplay: true,
			play: null,
			...more,
		});
		/** Lets a send the store started run as far as it can. */
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

		it("plays through the player page while it's open, once", async () => {
			const { store } = setUp();
			const target = tv();
			const play = vi.fn();
			store.setUpNext(upNext({ play }));
			await store.send(target, ep1, opts());
			// Still playing it, or at an end that names no item, isn't its end.
			target.set(playbackState({ item: ended(ep1).item }));
			target.set(playbackState({ status: "ended", item: null }));
			expect(play).not.toHaveBeenCalled();
			target.set(ended(ep1));
			target.set(ended(ep1));
			expect(play).toHaveBeenCalledTimes(1);
			expect(play).toHaveBeenCalledWith(ep2);
			expect(target.load).toHaveBeenCalledTimes(1);
		});

		it("goes to the TV by itself with the page closed", async () => {
			const { store } = setUp();
			const target = tv();
			store.setUpNext(upNext());
			await store.send(target, ep1, opts());
			target.set(ended(ep1));
			await vi.waitFor(() => expect(target.load).toHaveBeenCalledTimes(2));
			expect(target.load).toHaveBeenLastCalledWith(
				{ kind: "local", channel: ep2 },
				expect.objectContaining({ startAt: undefined })
			);
			expect(store.getState()).toMatchObject({ destination: target, channel: ep2 });
		});

		it("doesn't start converting with no one there to ask", async () => {
			const { store } = setUp();
			const target = tv("Hotel TV", converted);
			store.setUpNext(upNext());
			await store.send(target, ep1, opts({ decision: direct }));
			target.set(ended(ep1));
			await settle();
			expect(target.route).toHaveBeenCalledTimes(1);
			expect(target.load).toHaveBeenCalledTimes(1);
			expect(store.getState().channel).toBe(ep1);
		});

		it("goes on converting on a TV that already converts", async () => {
			const { store } = setUp();
			const target = { ...tv("Hotel TV", converted), converted: () => true };
			store.setUpNext(upNext());
			await store.send(target, ep1, opts({ decision: converted }));
			target.set(ended(ep1));
			await vi.waitFor(() => expect(target.load).toHaveBeenCalledTimes(2));
			expect(store.getState().channel).toBe(ep2);
		});

		it("does nothing at the end before the page said what's up next", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, ep1, opts());
			expect(() => target.set(ended(ep1))).not.toThrow();
			await settle();
			expect(target.load).toHaveBeenCalledTimes(1);
			expect(store.getState().channel).toBe(ep1);
		});

		it("does nothing with autoplay off, after the last episode, or at another item's end", async () => {
			const { store } = setUp();
			const target = tv();
			const play = vi.fn();
			store.setUpNext(upNext({ autoplay: false, play }));
			await store.send(target, ep1, opts());
			target.set(ended(ep1));
			store.setUpNext(upNext({ play }));
			await store.send(target, ep2, opts());
			target.set(ended(ep2));
			await store.send(target, ep1, opts());
			target.set(ended(ep2));
			await settle();
			expect(play).not.toHaveBeenCalled();
			expect(target.load).toHaveBeenCalledTimes(3);
		});
	});

	describe("a lost connection", () => {
		it("ends a TV that ends when lost, and says why", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts({ ends: lostEnds }));
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
			await store.send(target, film, opts({ ends: lostEnds }));
			target.set(playbackState({ connection: "lost" }));
			await store.send(target, film, opts());
			expect(store.getState().ended).toBeNull();
		});

		it("keeps why a TV ends when it switches items there, but not on another TV", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts({ ends: lostEnds }));
			await store.send(target, other, opts());
			target.set(playbackState({ connection: "lost" }));
			expect(store.getState().ended).toBe("Lost the connection to Hotel TV.");
			const elsewhere = tv("Den TV");
			await store.send(target, film, opts({ ends: lostEnds }));
			await store.send(elsewhere, other, opts());
			elsewhere.set(playbackState({ connection: "lost" }));
			expect(store.getState().destination).toBe(elsewhere);
		});

		it("hears nothing more from a TV it stopped or switched from", async () => {
			const { store, save, tick } = setUp();
			const first = tv("Den TV");
			await store.send(first, film, opts({ ends: lostEnds }));
			// Another TV plays the same film, from the start.
			const second = tv();
			await store.send(second, film, opts({ ends: lostEnds }));
			tick(5000);
			first.set(playbackState({ position: 900, status: "paused" }));
			first.set(playbackState({ connection: "lost" }));
			expect(save).not.toHaveBeenCalled();
			expect(store.getState()).toMatchObject({ destination: second, ended: null });
			await store.stop();
			await store.send(first, film, opts());
			tick(5000);
			second.set(playbackState({ position: 900, status: "paused" }));
			expect(save).not.toHaveBeenCalled();
		});

		it("forgets why a TV ends once it's stopped", async () => {
			const { store } = setUp();
			const target = tv();
			await store.send(target, film, opts({ ends: lostEnds }));
			await store.stop();
			// The same TV, sent to again with nothing to say when it ends.
			await store.send(target, other, opts());
			target.set(playbackState({ connection: "lost" }));
			expect(store.getState().destination).toBe(target);
		});

		it("follows an update with no item, keeping no resume point", async () => {
			const { store, save, tick } = setUp();
			const target = tv();
			await store.send(target, film, opts());
			tick(5000);
			target.set(playbackState({ item: null, position: 900 }));
			expect(save).not.toHaveBeenCalled();
			expect(store.getState().destination).toBe(target);
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

describe("sentMessage", () => {
	const cast = fakeDestination("cast", "Hotel TV");
	const airplay = fakeDestination("airplay", "Living Room TV");

	it("says nothing for a send that went, was overtaken or called off", () => {
		expect(sentMessage(cast, { ok: true })).toBeNull();
		expect(sentMessage(cast, { ok: false, why: "overtaken" })).toBeNull();
		expect(sentMessage(cast, { ok: false, why: "declined", released: true })).toBeNull();
	});

	it("says why a route is blocked, in each kind of TV's words", () => {
		const decision = { ok: false as const, reason: "unreachable" as const };
		const blocked = { ok: false as const, why: "blocked" as const, decision, released: false };
		expect(sentMessage(cast, blocked)).toBe("Couldn't reach the stream");
		expect(sentMessage(airplay, blocked)).toMatch(/\S/);
		expect(sentMessage(airplay, blocked)).not.toBe(sentMessage(cast, blocked));
	});

	it("says why it failed, and that nothing plays when nothing does", () => {
		const failed = (switching: boolean) => ({
			ok: false as const,
			why: "failed" as const,
			error: "unreachable",
			switching,
		});
		expect(sentMessage(cast, failed(false))).toBe(
			"Couldn't reach Hotel TV. Nothing is playing."
		);
		// The switch failed, so nothing plays there either.
		expect(sentMessage(cast, failed(true))).toBe(
			"Couldn't reach Hotel TV. Nothing is playing."
		);
		const unrouted = (released: boolean) => ({
			ok: false as const,
			why: "unrouted" as const,
			error: "refused",
			released,
		});
		expect(sentMessage(airplay, unrouted(false))).toBe(
			"The provider refused the stream. The login may have expired, or another device may be using it."
		);
		expect(sentMessage(airplay, unrouted(true))).toMatch(/ Nothing is playing\.$/);
	});
});
