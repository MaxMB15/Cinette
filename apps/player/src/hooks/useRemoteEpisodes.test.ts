// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
	createCinetteDestination,
	type CatalogItem,
	type RemoteSnapshot,
} from "@/lib/cinette-destination";
import { remoteCatalog, type CatalogQuery } from "@/lib/tauri";
import { deferred } from "@/test/deferred";
import { useRemoteEpisodes } from "./useRemoteEpisodes";

vi.mock("@/lib/tauri", () => ({ remoteCatalog: vi.fn() }));

const episode = (n: number, seriesId = "s1"): CatalogItem => ({
	id: `e${n}`,
	name: `Episode ${n}`,
	contentType: "series",
	group: "Drama",
	season: 1,
	episode: n,
	seriesId,
});

const snapshot = (item: CatalogItem | null): RemoteSnapshot => ({
	status: "playing",
	item,
	position: 0,
	duration: 0,
	volume: 50,
	subtitles: [],
	subtitleId: null,
	audio: [],
	audioId: null,
	capabilities: {
		pause: true,
		seek: true,
		volume: true,
		subtitles: false,
		audioTracks: false,
		resumeAt: true,
	},
	error: null,
});

/** A link to a device playing `item`. */
const linkPlaying = (item: CatalogItem | null, id = 4) => {
	const destination = createCinetteDestination("dev", "Den TV", async () => undefined);
	destination.receive({ epoch: "e", version: 1, state: snapshot(item) }, 0);
	let version = 1;
	return {
		id,
		destination,
		/** The other device plays `next` now. */
		plays: (next: CatalogItem | null) =>
			act(() =>
				destination.receive({ epoch: "e", version: ++version, state: snapshot(next) }, 0)
			),
	};
};

/** Answers each episodes query from `pages`, by series and cursor. */
const answer = (pages: Record<string, { items: CatalogItem[]; next: string | null }>) =>
	vi.mocked(remoteCatalog).mockImplementation(async (_link, q: CatalogQuery) => {
		if (q.kind !== "episodes") throw new Error(q.kind);
		const page = pages[`${q.seriesId}@${q.cursor ?? ""}`];
		if (!page) throw new Error(`unexpected ${q.seriesId}@${q.cursor}`);
		return page;
	});

const flush = () =>
	act(async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});

beforeEach(() => {
	vi.mocked(remoteCatalog).mockReset();
});

describe("useRemoteEpisodes", () => {
	it("reads every page of the series and gives the episodes around the one playing", async () => {
		answer({
			"s1@": { items: [episode(3), episode(1)], next: "p2" },
			"s1@p2": { items: [episode(2)], next: null },
		});
		const link = linkPlaying(episode(2));
		const { result } = renderHook(() => useRemoteEpisodes(link));
		expect(result.current).toEqual({ prev: null, next: null });
		await flush();
		expect(result.current.prev?.id).toBe("e1");
		expect(result.current.next?.id).toBe("e3");
		expect(remoteCatalog).toHaveBeenCalledWith(4, {
			kind: "episodes",
			seriesId: "s1",
			cursor: undefined,
			limit: 100,
		});
		expect(remoteCatalog).toHaveBeenCalledTimes(2);
		// Another episode of the same series needs no new look.
		link.plays(episode(3));
		await flush();
		expect(result.current).toMatchObject({ prev: { id: "e2" }, next: null });
		expect(remoteCatalog).toHaveBeenCalledTimes(2);
	});

	it("has none without a link, for an item that isn't an episode, or without a series", async () => {
		const none = { prev: null, next: null };
		expect(renderHook(() => useRemoteEpisodes(null)).result.current).toEqual(none);
		const movie = { id: "m1", name: "Film", contentType: "movie", group: "Films" };
		const { result } = renderHook(() => useRemoteEpisodes(linkPlaying(movie)));
		await flush();
		expect(result.current).toEqual(none);
		// An older device names no series.
		const older = { ...episode(2), seriesId: undefined };
		expect(renderHook(() => useRemoteEpisodes(linkPlaying(older))).result.current).toEqual(
			none
		);
		expect(remoteCatalog).not.toHaveBeenCalled();
	});

	it("drops a series that something else replaced before it came", async () => {
		const first = deferred<{ items: CatalogItem[]; next: string | null }>();
		vi.mocked(remoteCatalog)
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce({ items: [episode(1, "s2"), episode(2, "s2")], next: null });
		const link = linkPlaying(episode(2));
		const { result } = renderHook(() => useRemoteEpisodes(link));
		link.plays(episode(1, "s2"));
		await flush();
		first.resolve({ items: [episode(1), episode(2), episode(3)], next: null });
		await flush();
		expect(result.current).toMatchObject({ prev: null, next: { id: "e2" } });
	});

	it("stops reading pages for a series that's gone", async () => {
		const second = deferred<{ items: CatalogItem[]; next: string | null }>();
		vi.mocked(remoteCatalog)
			.mockResolvedValueOnce({ items: [episode(1)], next: "p2" })
			.mockReturnValueOnce(second.promise);
		const link = linkPlaying(episode(1));
		const { result, unmount } = renderHook(() => useRemoteEpisodes(link));
		await flush();
		unmount();
		second.resolve({ items: [episode(2)], next: "p3" });
		await flush();
		expect(remoteCatalog).toHaveBeenCalledTimes(2);
		expect(result.current).toEqual({ prev: null, next: null });
	});

	it("keeps none when the catalog can't be read", async () => {
		vi.mocked(remoteCatalog).mockRejectedValue("failed");
		const { result } = renderHook(() => useRemoteEpisodes(linkPlaying(episode(2))));
		await flush();
		expect(result.current).toEqual({ prev: null, next: null });
	});

	it("asks the new device when the link changes", async () => {
		answer({ "s1@": { items: [episode(1), episode(2)], next: null } });
		const { rerender } = renderHook(({ link }) => useRemoteEpisodes(link), {
			initialProps: { link: linkPlaying(episode(2), 4) },
		});
		await flush();
		rerender({ link: linkPlaying(episode(2), 5) });
		await flush();
		expect(vi.mocked(remoteCatalog).mock.calls.map(([link]) => link)).toEqual([4, 5]);
	});
});
