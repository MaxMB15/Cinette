// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, DownloadRecord } from "@/lib/types";
import { nowSeconds } from "@/lib/date";
import { makeChannel, makeDownload } from "@/test/channel-fixtures";
import { DownloadsTab } from "./DownloadsTab";

const state = vi.hoisted(() => ({
	channels: [] as Channel[],
	downloads: [] as DownloadRecord[],
	retentionDays: null as number | null,
}));

vi.mock("@/hooks/useChannels", () => ({
	useChannels: () => ({ channels: state.channels }),
}));

vi.mock("@/hooks/useDownloads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/useDownloads")>();
	return {
		...actual,
		useDownloads: () => ({
			downloads: state.downloads,
			...actual.groupDownloads(state.downloads),
			retentionDays: state.retentionDays,
		}),
	};
});

vi.mock("@/lib/tauri", () => ({
	enqueueMovieDownload: vi.fn(),
	stopDownload: vi.fn(),
	removeDownload: vi.fn(),
	setDownloadKeep: vi.fn(),
}));

const DAY = 24 * 60 * 60;

const dune = makeChannel({ id: "m1", name: "Dune", contentType: "movie", groupTitle: "Sci-Fi" });
const arrival = makeChannel({ id: "m2", name: "Arrival", contentType: "movie" });
const harbor = makeChannel({ id: "s1", name: "Harbor Lights", contentType: "series" });
const episode = makeChannel({ id: "e1", name: "Harbor Lights S01E01", contentType: "series" });

const movieDownload = (channelId: string, extra: Partial<DownloadRecord> = {}) =>
	makeDownload({ id: `dl-${channelId}`, channelId, ...extra });

const episodeDownload = (channelId: string, extra: Partial<DownloadRecord> = {}) =>
	makeDownload({
		id: `dl-${channelId}`,
		channelId,
		kind: "episode",
		seriesChannelId: "s1",
		...extra,
	});

const renderTab = () => {
	const onPlay = vi.fn();
	const onToggleFavorite = vi.fn();
	render(<DownloadsTab onPlay={onPlay} onToggleFavorite={onToggleFavorite} />);
	return { onPlay, onToggleFavorite };
};

describe("DownloadsTab", () => {
	afterEach(() => {
		cleanup();
		state.channels = [];
		state.downloads = [];
		state.retentionDays = null;
	});

	it("says there are no downloads yet", () => {
		state.channels = [dune];
		renderTab();
		expect(screen.getByText("No downloads yet.")).toBeInTheDocument();
	});

	it("leaves out downloads whose title is no longer in any playlist", () => {
		state.channels = [arrival];
		state.downloads = [movieDownload("m1")];
		renderTab();
		expect(screen.getByText("No downloads yet.")).toBeInTheDocument();
	});

	it("shows a downloaded movie and the show of a downloaded episode, not the episode", () => {
		state.channels = [dune, arrival, harbor, episode];
		state.downloads = [movieDownload("m1"), episodeDownload("e1")];
		renderTab();

		expect(screen.getByText("Dune")).toBeInTheDocument();
		expect(screen.getByText("Harbor Lights")).toBeInTheDocument();
		expect(screen.queryByText("Arrival")).toBeNull();
		expect(screen.queryByText("Harbor Lights S01E01")).toBeNull();
	});

	it("plays a card and toggles its favorite", () => {
		state.channels = [dune];
		state.downloads = [movieDownload("m1")];
		const { onPlay, onToggleFavorite } = renderTab();

		fireEvent.click(screen.getByText("Dune"));
		expect(onPlay).toHaveBeenCalledWith(dune);

		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(onToggleFavorite).toHaveBeenCalledWith(dune);
	});

	it("says when the retention setting deletes a movie and a show's episodes", () => {
		const now = nowSeconds();
		// Half a day off a whole number, so the count can't flip as the clock ticks.
		const finishedAt = now - Math.round(1.5 * DAY);
		state.channels = [dune, harbor];
		state.downloads = [
			movieDownload("m1", { finishedAt }),
			episodeDownload("e1", { finishedAt }),
			episodeDownload("e2", { finishedAt }),
		];
		state.retentionDays = 7;
		renderTab();

		expect(screen.getByText("Deletes in 6 days")).toBeInTheDocument();
		expect(screen.getByText("Episodes start deleting in 6 days")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Keep all" })).toBeInTheDocument();
	});

	it("shows one card for a show however many of its episodes are downloaded", () => {
		state.channels = [harbor];
		state.downloads = [episodeDownload("e1"), episodeDownload("e2")];
		renderTab();
		expect(screen.getAllByText("Harbor Lights")).toHaveLength(1);
	});
});
