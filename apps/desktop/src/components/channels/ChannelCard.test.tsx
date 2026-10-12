// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { Channel, DownloadRecord, EpgProgram } from "@/lib/types";
import { nowSeconds } from "@/lib/date";
import { makeChannel, makeDownload, makeEpisode, makeMovie } from "@/test/detail-fixtures";

const tauri = vi.hoisted(() => ({
	enqueueMovieDownload: vi.fn<(id: string) => Promise<string>>(),
	stopDownload: vi.fn<(id: string) => Promise<void>>(),
	removeDownload: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock("@/lib/tauri", () => tauri);

const downloads = vi.hoisted(() => ({
	byChannel: new Map<string, DownloadRecord>(),
	bySeries: new Map<string, DownloadRecord[]>(),
}));

vi.mock("@/hooks/useDownloads", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useDownloads")>()),
	useDownloads: () => downloads,
}));

import { ChannelCard } from "./ChannelCard";

const channel: Channel = {
	id: "ch1",
	name: "News 24",
	url: "http://example.test/news.ts",
	groupTitle: "News",
	isFavorite: false,
	contentType: "live",
	sources: [],
};

const now = nowSeconds();
const programme = (title: string, start: number, end: number): EpgProgram => ({
	channelId: "news24",
	title,
	startTime: now + start,
	endTime: now + end,
});

describe("ChannelCard compact variant", () => {
	afterEach(cleanup);

	it("shows the programme on now and not the ones around it", () => {
		render(
			<ChannelCard
				channel={channel}
				onPlay={vi.fn()}
				variant="compact"
				epgPrograms={[
					programme("Morning Show", -7200, -1800),
					programme("Midday Report", -1800, 1800),
					programme("Evening News", 1800, 5400),
				]}
			/>
		);
		expect(screen.getByText("Midday Report")).toBeDefined();
		expect(screen.queryByText("Morning Show")).toBeNull();
		expect(screen.queryByText("Evening News")).toBeNull();
	});

	it("shows the group when there's no guide data", () => {
		render(<ChannelCard channel={channel} onPlay={vi.fn()} variant="compact" />);
		expect(screen.getByText("News")).toBeDefined();
	});

	it("toggles the favorite without starting playback", () => {
		const onPlay = vi.fn();
		const onToggleFavorite = vi.fn();
		render(
			<ChannelCard
				channel={channel}
				onPlay={onPlay}
				variant="compact"
				onToggleFavorite={onToggleFavorite}
			/>
		);
		fireEvent.click(screen.getByLabelText("Add to favorites"));
		expect(onToggleFavorite).toHaveBeenCalledWith(channel);
		expect(onPlay).not.toHaveBeenCalled();

		fireEvent.click(screen.getByText("News 24"));
		expect(onPlay).toHaveBeenCalledWith(channel);
	});

	it("keeps the play and favorite buttons apart for VoiceOver", () => {
		render(
			<ChannelCard
				channel={channel}
				onPlay={vi.fn()}
				variant="compact"
				onToggleFavorite={vi.fn()}
			/>
		);
		const play = screen.getByRole("button", { name: /News 24/ });
		const favorite = screen.getByRole("button", { name: "Add to favorites" });
		expect(play.contains(favorite)).toBe(false);
		expect(favorite.contains(play)).toBe(false);
	});
});

describe("ChannelCard poster variant", () => {
	beforeEach(() => {
		downloads.byChannel = new Map();
		downloads.bySeries = new Map();
		tauri.enqueueMovieDownload.mockResolvedValue("dl1");
		tauri.stopDownload.mockResolvedValue();
		tauri.removeDownload.mockResolvedValue();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	const movie: Channel = { ...channel, id: "mv1", name: "The Film", contentType: "movie" };

	it("keeps the favorite button out of the play button", () => {
		render(
			<ChannelCard
				channel={movie}
				onPlay={vi.fn()}
				variant="poster"
				onToggleFavorite={vi.fn()}
			/>
		);
		const play = screen.getByRole("button", { name: /The Film/ });
		const favorite = screen.getByRole("button", { name: "Add to favorites" });
		expect(favorite.tagName).toBe("BUTTON");
		expect(play.contains(favorite)).toBe(false);
	});

	it("toggles the favorite without starting playback", () => {
		const onPlay = vi.fn();
		const onToggleFavorite = vi.fn();
		render(
			<ChannelCard
				channel={movie}
				onPlay={onPlay}
				variant="poster"
				onToggleFavorite={onToggleFavorite}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(onToggleFavorite).toHaveBeenCalledWith(movie);
		expect(onPlay).not.toHaveBeenCalled();
	});

	const withDownload = (overrides: Partial<DownloadRecord>) => {
		downloads.byChannel = new Map([["mv1", makeDownload(overrides)]]);
	};

	/** The bar along the poster's bottom edge that fills as a download runs. */
	const progressBar = (container: HTMLElement) =>
		container.querySelector<HTMLElement>('[class~="bg-blue-400"]');

	const confirmIn = (label: string) =>
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));

	it("starts a movie download without playing it", () => {
		const onPlay = vi.fn();
		render(<ChannelCard channel={makeMovie()} onPlay={onPlay} variant="poster" />);
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect(tauri.enqueueMovieDownload).toHaveBeenCalledExactlyOnceWith("mv1");
		expect(onPlay).not.toHaveBeenCalled();
	});

	it("shows how far a download has got and stops it after asking", () => {
		withDownload({ status: "downloading", totalBytes: 1000, downloadedBytes: 250 });
		const { container } = render(
			<ChannelCard channel={makeMovie()} onPlay={vi.fn()} variant="poster" />
		);
		expect(progressBar(container)).toHaveStyle({ width: "25%" });

		fireEvent.click(screen.getByRole("button", { name: "Downloading" }));
		confirmIn("Stop");
		expect(tauri.stopDownload).toHaveBeenCalledExactlyOnceWith("dl1");
	});

	it("keeps the progress bar empty until the size is known and full past it", () => {
		withDownload({ status: "queued", totalBytes: null, downloadedBytes: 0 });
		const { container, rerender } = render(
			<ChannelCard channel={makeMovie()} onPlay={vi.fn()} variant="poster" />
		);
		expect(progressBar(container)).toHaveStyle({ width: "0%" });

		withDownload({ status: "downloading", totalBytes: 1000, downloadedBytes: 1500 });
		rerender(<ChannelCard channel={makeMovie()} onPlay={vi.fn()} variant="poster" />);
		expect(progressBar(container)).toHaveStyle({ width: "100%" });
	});

	it("removes a finished download after asking", () => {
		withDownload({ status: "completed" });
		const { container } = render(
			<ChannelCard channel={makeMovie()} onPlay={vi.fn()} variant="poster" />
		);
		expect(progressBar(container)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
		confirmIn("Remove");
		expect(tauri.removeDownload).toHaveBeenCalledExactlyOnceWith("dl1");
	});

	it("retries a failed download", () => {
		withDownload({ status: "failed" });
		render(<ChannelCard channel={makeMovie()} onPlay={vi.fn()} variant="poster" />);
		fireEvent.click(screen.getByRole("button", { name: "Download failed — retry" }));
		expect(tauri.enqueueMovieDownload).toHaveBeenCalledExactlyOnceWith("mv1");
	});

	it("shows a series' episode downloads but leaves starting and stopping them to its page", () => {
		const series = makeChannel({ id: "series-1", name: "Show", contentType: "series" });
		const episode = makeEpisode(1, 1, "Pilot");
		const { container, rerender } = render(
			<ChannelCard channel={series} onPlay={vi.fn()} variant="poster" />
		);
		fireEvent.click(screen.getByRole("button", { name: "Download" }));
		expect(tauri.enqueueMovieDownload).not.toHaveBeenCalled();

		downloads.bySeries = new Map([
			[
				"series-1",
				[makeDownload({ id: "dl-ep", channelId: episode.id, status: "downloading" })],
			],
		]);
		rerender(<ChannelCard channel={{ ...series }} onPlay={vi.fn()} variant="poster" />);
		fireEvent.click(screen.getByRole("button", { name: "Downloading" }));
		confirmIn("Stop");
		expect(tauri.stopDownload).not.toHaveBeenCalled();
		expect(progressBar(container)).toBeNull();

		// The card doesn't know how many episodes there are, so it never says all are done.
		downloads.bySeries = new Map([
			[
				"series-1",
				[makeDownload({ id: "dl-ep", channelId: episode.id, status: "completed" })],
			],
		]);
		rerender(<ChannelCard channel={{ ...series }} onPlay={vi.fn()} variant="poster" />);
		expect(screen.getByRole("button", { name: "Partially downloaded" })).toBeInTheDocument();
	});

	it("shows the poster and falls back to a placeholder when it fails to load", () => {
		const { container } = render(
			<ChannelCard
				channel={makeMovie({ logoUrl: "https://img.example.test/broken-poster.jpg" })}
				onPlay={vi.fn()}
				variant="poster"
			/>
		);
		const img = container.querySelector("img") as HTMLImageElement;
		expect(img).toHaveAttribute("src", "https://img.example.test/broken-poster.jpg");
		expect(screen.queryByText("No poster")).toBeNull();

		fireEvent.error(img);
		expect(container.querySelector("img")).toBeNull();
		expect(screen.getByText("No poster")).toBeInTheDocument();
	});

	it("counts every source on the poster", () => {
		render(
			<ChannelCard
				channel={makeMovie({
					sources: [
						"https://mirror.example.test/sintel.mp4",
						"https://backup.example.test/sintel.ts",
					],
				})}
				onPlay={vi.fn()}
				variant="poster"
			/>
		);
		expect(
			within(screen.getByRole("button", { name: /Sintel/ })).getByText("3")
		).toBeInTheDocument();
	});
});

describe("ChannelCard row variant", () => {
	afterEach(cleanup);

	it("toggles the favorite without starting playback", () => {
		const onPlay = vi.fn();
		const onToggleFavorite = vi.fn();
		render(
			<ChannelCard channel={channel} onPlay={onPlay} onToggleFavorite={onToggleFavorite} />
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(onToggleFavorite).toHaveBeenCalledWith(channel);
		expect(onPlay).not.toHaveBeenCalled();
	});

	it("plays the channel once from its button", () => {
		const onPlay = vi.fn();
		render(<ChannelCard channel={channel} onPlay={onPlay} onToggleFavorite={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /News 24/ }));
		expect(onPlay).toHaveBeenCalledExactlyOnceWith(channel);
	});

	it("plays the channel from a click on the timeline", () => {
		const onPlay = vi.fn();
		render(<ChannelCard channel={channel} onPlay={onPlay} onToggleFavorite={vi.fn()} />);
		fireEvent.click(screen.getByText("no epg"));
		expect(onPlay).toHaveBeenCalledWith(channel);
	});

	it("keeps the play and favorite buttons apart for screen readers", () => {
		render(<ChannelCard channel={channel} onPlay={vi.fn()} onToggleFavorite={vi.fn()} />);
		const play = screen.getByRole("button", { name: /News 24/ });
		const favorite = screen.getByRole("button", { name: "Add to favorites" });
		expect(play.tagName).toBe("BUTTON");
		expect(play.contains(favorite)).toBe(false);
		expect(favorite.contains(play)).toBe(false);
		expect(screen.getAllByRole("button")).toHaveLength(2);
	});

	it("draws the guide timeline and plays the channel from a click on a programme", () => {
		const onPlay = vi.fn();
		render(
			<ChannelCard
				channel={channel}
				onPlay={onPlay}
				epgPrograms={[programme("Midday Report", -1800, 1800)]}
				windowStart={now - 3600}
				windowEnd={now + 7200}
			/>
		);
		expect(screen.queryByText("no epg")).toBeNull();
		fireEvent.click(screen.getByTitle("Midday Report"));
		expect(onPlay).toHaveBeenCalledExactlyOnceWith(channel);
	});
});
