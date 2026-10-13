// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import {
	aggregateForSeries,
	DownloadsProvider,
	groupDownloads,
	supersedes,
	useDownloads,
} from "./useDownloads";
import { getDownloadRetention, listDownloads, setDownloadRetention } from "@/lib/tauri";
import type { DownloadRecord } from "@/lib/types";

/** The backend's download events, with the handlers the provider registered. */
const events = vi.hoisted(() => ({
	handlers: new Map<string, (event: { payload: unknown }) => void>(),
	unlisteners: new Map<string, () => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
		events.handlers.set(name, handler);
		const unlisten = vi.fn();
		events.unlisteners.set(name, unlisten);
		return unlisten;
	}),
}));

vi.mock("@/lib/tauri", () => ({
	listDownloads: vi.fn(),
	getDownloadRetention: vi.fn(),
	setDownloadRetention: vi.fn(),
}));

const rec = (over: Partial<DownloadRecord>): DownloadRecord => ({
	id: "x",
	channelId: "x",
	title: "t",
	kind: "episode",
	seriesChannelId: "S1",
	status: "completed",
	destPath: "/p",
	totalBytes: null,
	downloadedBytes: 0,
	avgRateBps: null,
	error: null,
	createdAt: 0,
	finishedAt: null,
	keep: false,
	lastPlayedAt: null,
	...over,
});

describe("aggregateForSeries", () => {
	it("returns none when no episodes downloaded", () => {
		expect(aggregateForSeries([], 24)).toBe("none");
	});
	it("returns downloading when any in progress", () => {
		const recs = [rec({ status: "downloading" }), rec({ status: "completed" })];
		expect(aggregateForSeries(recs, 24)).toBe("downloading");
	});
	it("returns partial when some but not all complete", () => {
		const recs = [rec({ status: "completed" }), rec({ status: "completed" })];
		expect(aggregateForSeries(recs, 24)).toBe("partial");
	});
	it("returns complete when all episodes downloaded", () => {
		const recs = Array.from({ length: 24 }, () => rec({ status: "completed" }));
		expect(aggregateForSeries(recs, 24)).toBe("complete");
	});
});

describe("supersedes", () => {
	it("a completed record always wins", () => {
		const completed = rec({ id: "a", status: "completed", createdAt: 1 });
		const failed = rec({ id: "b", status: "failed", createdAt: 100 });
		expect(supersedes(completed, failed)).toBe(true);
	});
	it("does not replace a completed record with a newer non-completed one", () => {
		const completed = rec({ id: "a", status: "completed", createdAt: 1 });
		const downloading = rec({ id: "b", status: "downloading", createdAt: 100 });
		expect(supersedes(downloading, completed)).toBe(false);
	});
	it("a newer attempt supersedes an older non-completed one", () => {
		const oldFailed = rec({ id: "a", status: "failed", createdAt: 10 });
		const retry = rec({ id: "b", status: "queued", createdAt: 20 });
		expect(supersedes(retry, oldFailed)).toBe(true);
	});
});

describe("groupDownloads", () => {
	it("keeps one record per channel, preferring completed over a stale failure", () => {
		const failed = rec({ id: "f", channelId: "c1", status: "failed", createdAt: 10 });
		const done = rec({ id: "d", channelId: "c1", status: "completed", createdAt: 20 });
		const { byChannel } = groupDownloads([failed, done]);
		expect(byChannel.size).toBe(1);
		expect(byChannel.get("c1")?.id).toBe("d");
	});

	it("counts episodes individually but never the series container", () => {
		// 12 episodes of one series — the series container has no record itself.
		const eps = Array.from({ length: 12 }, (_, i) =>
			rec({ id: `e${i}`, channelId: `ep-${i}`, status: "completed", seriesChannelId: "S1" })
		);
		const { byChannel, bySeries } = groupDownloads(eps);
		expect(byChannel.size).toBe(12); // tab badge count
		expect(bySeries.get("S1")?.length).toBe(12);
	});

	it("dedupes per episode within a series (retry replaces failed)", () => {
		const failed = rec({
			id: "f",
			channelId: "ep-1",
			status: "failed",
			seriesChannelId: "S1",
			createdAt: 1,
		});
		const done = rec({
			id: "d",
			channelId: "ep-1",
			status: "completed",
			seriesChannelId: "S1",
			createdAt: 2,
		});
		const { bySeries } = groupDownloads([failed, done]);
		expect(bySeries.get("S1")?.length).toBe(1);
		expect(bySeries.get("S1")?.[0].id).toBe("d");
	});

	it("treats movies as standalone channels", () => {
		const movie = rec({ id: "m", channelId: "mv-1", kind: "movie", seriesChannelId: null });
		const { byChannel, bySeries } = groupDownloads([movie]);
		expect(byChannel.size).toBe(1);
		expect(bySeries.size).toBe(0);
	});
});

describe("DownloadsProvider", () => {
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(DownloadsProvider, null, children);

	/** Mounts the provider and waits until it has loaded and is listening. */
	const mount = async () => {
		const hook = renderHook(() => useDownloads(), { wrapper });
		await waitFor(() => expect(events.handlers.size).toBe(2));
		await act(async () => {});
		return hook;
	};

	const emit = (name: string, payload: unknown) =>
		act(() => events.handlers.get(name)?.({ payload }));

	const movie = rec({ id: "d1", channelId: "mv-1", kind: "movie", seriesChannelId: null });

	beforeEach(() => {
		events.handlers.clear();
		events.unlisteners.clear();
		vi.mocked(listDownloads).mockResolvedValue([movie]);
		vi.mocked(getDownloadRetention).mockResolvedValue(14);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("loads the downloads and the retention setting when it mounts", async () => {
		const { result } = await mount();

		expect(result.current.downloads).toEqual([movie]);
		expect(result.current.byChannel.get("mv-1")).toBe(movie);
		expect(result.current.retentionDays).toBe(14);
	});

	it("keeps downloads until removed when the retention setting can't be read", async () => {
		vi.mocked(getDownloadRetention).mockRejectedValueOnce(new Error("store missing"));
		const { result } = await mount();

		expect(result.current.retentionDays).toBeNull();
		expect(result.current.downloads).toEqual([movie]);
	});

	it("updates a download in place as progress comes in and adds new ones", async () => {
		const { result } = await mount();

		emit("download://progress", { ...movie, status: "downloading", downloadedBytes: 512 });
		expect(result.current.downloads).toHaveLength(1);
		expect(result.current.downloads[0]).toMatchObject({ id: "d1", downloadedBytes: 512 });

		const episode = rec({ id: "d2", channelId: "ep-1", status: "queued" });
		emit("download://progress", episode);
		expect(result.current.downloads.map((d) => d.id)).toEqual(["d1", "d2"]);
		expect(result.current.bySeries.get("S1")).toEqual([episode]);
	});

	it("drops a download the backend removed", async () => {
		const { result } = await mount();

		emit("download://removed", "d1");

		expect(result.current.downloads).toEqual([]);
		expect(result.current.byChannel.has("mv-1")).toBe(false);
	});

	it("reloads the list on request", async () => {
		const { result } = await mount();
		const episode = rec({ id: "d2", channelId: "ep-1" });
		vi.mocked(listDownloads).mockResolvedValueOnce([movie, episode]);

		await act(() => result.current.refresh());

		expect(result.current.downloads).toEqual([movie, episode]);
	});

	it("saves the retention setting and reports how many downloads it deleted", async () => {
		const { result } = await mount();
		vi.mocked(setDownloadRetention).mockResolvedValueOnce(3);

		let deleted = 0;
		await act(async () => {
			deleted = await result.current.setRetentionDays(7);
		});

		expect(setDownloadRetention).toHaveBeenCalledWith(7);
		expect(deleted).toBe(3);
		expect(result.current.retentionDays).toBe(7);
	});

	it("keeps the old retention setting when saving fails", async () => {
		const { result } = await mount();
		vi.mocked(setDownloadRetention).mockRejectedValueOnce(new Error("disk full"));

		await act(() => expect(result.current.setRetentionDays(null)).rejects.toThrow("disk full"));

		expect(result.current.retentionDays).toBe(14);
	});

	it("stops listening for download events when it unmounts", async () => {
		const { unmount } = await mount();

		unmount();
		await act(async () => {});

		expect(events.unlisteners.get("download://progress")).toHaveBeenCalledOnce();
		expect(events.unlisteners.get("download://removed")).toHaveBeenCalledOnce();
	});

	it("refuses to run outside the provider", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() => renderHook(() => useDownloads())).toThrow(
				"useDownloads must be used within DownloadsProvider"
			);
		} finally {
			consoleError.mockRestore();
		}
	});
});
