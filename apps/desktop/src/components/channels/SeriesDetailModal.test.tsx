// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, DownloadRecord, OmdbData, WhatsonData } from "@/lib/types";
import { makeDownload, makeEpisode, makeOmdb } from "@/test/detail-fixtures";

const tauri = vi.hoisted(() => ({
	getOmdbApiKey: vi.fn<() => Promise<string | null>>(),
	fetchOmdbData: vi.fn<(id: string, name: string, kind: string) => Promise<OmdbData | null>>(),
	fetchWhatsonData: vi.fn<(imdbId: string, kind: string) => Promise<WhatsonData | null>>(),
	enqueueEpisodeDownload:
		vi.fn<(ep: Channel, seriesId: string, title: string) => Promise<string>>(),
	enqueueEpisodesBatch:
		vi.fn<(eps: Channel[], seriesId: string, title: string) => Promise<string[]>>(),
	stopDownload: vi.fn<(id: string) => Promise<void>>(),
	stopDownloads: vi.fn<(ids: string[]) => Promise<void>>(),
	removeDownload: vi.fn<(id: string) => Promise<void>>(),
	removeDownloads: vi.fn<(ids: string[]) => Promise<void>>(),
	cacheSeriesEpisodes: vi.fn<(seriesId: string, eps: Channel[]) => Promise<void>>(),
	setDownloadKeep: vi.fn<(id: string, keep: boolean) => Promise<void>>(),
}));

vi.mock("@/lib/tauri", () => tauri);

const downloads = vi.hoisted(() => ({
	byChannel: new Map<string, DownloadRecord>(),
	bySeries: new Map<string, DownloadRecord[]>(),
	retentionDays: null as number | null,
}));

vi.mock("@/hooks/useDownloads", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useDownloads")>()),
	useDownloads: () => downloads,
}));

import { SeriesDetailModal } from "./SeriesDetailModal";
import { rememberHasOmdbKey } from "@/hooks/useHasOmdbKey";

const SERIES = "series-1";
const MIRROR = "https://mirror.example.test/show/s1e1.mp4";

const pilot = makeEpisode(1, 1, "Pilot");
const second = makeEpisode(1, 2, "Second");
// The same episode from another provider. It becomes the pilot's second source.
const pilotMirror = makeEpisode(1, 1, "Pilot", { id: "s1e1-mirror", url: MIRROR });
const comeback = makeEpisode(2, 1, "Comeback");
const bonus = makeEpisode(0, 0, "", {
	id: "bonus",
	name: "Show Bonus Clip",
	url: "https://cdn.example.test/show/bonus.mkv",
	season: undefined,
	episode: undefined,
});
const episodes = [second, pilot, pilotMirror, comeback, bonus];
const mergedPilot: Channel = { ...pilot, sources: [MIRROR] };

const showOmdb = makeOmdb({
	title: "Show",
	genre: "Drama",
	runtime: "49 min",
	director: "Jane Doe",
	plot: "A family runs a hotel by the sea.",
	posterUrl: "https://img.example.test/show.jpg",
});

type Props = ComponentProps<typeof SeriesDetailModal>;

const renderModal = (props: Partial<Props> = {}) => {
	const all: Props = {
		showTitle: "Show",
		episodes,
		seriesChannelId: SERIES,
		onClose: vi.fn(),
		onPlay: vi.fn(),
		...props,
	};
	const ui = (p: Props) => (
		<MemoryRouter>
			<SeriesDetailModal {...p} />
		</MemoryRouter>
	);
	const result = render(ui(all));
	return {
		...result,
		...all,
		rerenderWith: (more: Partial<Props>) => result.rerender(ui({ ...all, ...more })),
	};
};

/** Waits until the OMDb and Whatson lookups have settled. */
const loaded = async () => {
	await waitFor(() => expect(screen.queryByText("Loading info…")).toBeNull());
	await act(async () => {});
};

const epDownload = (ep: Channel, status: DownloadRecord["status"]) =>
	makeDownload({
		id: `dl-${ep.id}`,
		channelId: ep.id,
		title: ep.name,
		kind: "episode",
		seriesChannelId: SERIES,
		status,
		destPath: `/downloads/${ep.id}.mkv`,
	});

const withDownloads = (...records: DownloadRecord[]) => {
	downloads.bySeries = new Map([[SERIES, records]]);
};

/** The header row, which holds the whole series' download button. */
const header = () => screen.getByRole("button", { name: "Close" }).parentElement as HTMLElement;

/** The row around a season or episode button, which also holds its download button. */
const rowOf = (text: string) =>
	screen.getByText(text).closest("button")!.parentElement as HTMLElement;

const open = (text: string) => fireEvent.click(screen.getByText(text).closest("button")!);

const back = (label: string) => fireEvent.click(screen.getByRole("button", { name: label }));

const confirmIn = (label: string) =>
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));

/** The ids sent in the one call to `fn`, sorted, since their order doesn't matter. */
const idsSentTo = (fn: typeof tauri.stopDownloads) => {
	expect(fn).toHaveBeenCalledTimes(1);
	return [...fn.mock.calls[0][0]].sort();
};

describe("SeriesDetailModal", () => {
	beforeEach(() => {
		rememberHasOmdbKey(null);
		tauri.getOmdbApiKey.mockResolvedValue("saved-key");
		tauri.fetchOmdbData.mockResolvedValue(showOmdb);
		tauri.fetchWhatsonData.mockResolvedValue(null);
		tauri.enqueueEpisodeDownload.mockResolvedValue("new");
		tauri.enqueueEpisodesBatch.mockResolvedValue([]);
		tauri.stopDownload.mockResolvedValue();
		tauri.stopDownloads.mockResolvedValue();
		tauri.removeDownload.mockResolvedValue();
		tauri.removeDownloads.mockResolvedValue();
		tauri.cacheSeriesEpisodes.mockResolvedValue();
		tauri.setDownloadKeep.mockResolvedValue();
		downloads.bySeries = new Map();
		downloads.retentionDays = null;
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe("show details", () => {
		it("shows the show's OMDb details and how many seasons and episodes it has", async () => {
			const { container } = renderModal();
			await loaded();
			expect(tauri.fetchOmdbData).toHaveBeenCalledExactlyOnceWith("s1e2", "Show", "series");
			expect(tauri.fetchWhatsonData).toHaveBeenCalledExactlyOnceWith("tt1727587", "show");
			expect(screen.getByText("(2010)")).toBeInTheDocument();
			expect(screen.getByText("PG-13")).toBeInTheDocument();
			expect(screen.getByText("7.4")).toBeInTheDocument();
			expect(screen.getByText("Drama · 49 min/ep")).toBeInTheDocument();
			expect(screen.getByText("Created by: Jane Doe")).toBeInTheDocument();
			expect(screen.getByText("Cast: Halina Reijn, Thom Hoffman")).toBeInTheDocument();
			expect(screen.getByText("A family runs a hotel by the sea.")).toBeInTheDocument();
			expect(container.querySelector("img")).toHaveAttribute(
				"src",
				"https://img.example.test/show.jpg"
			);
			// The pilot from two providers counts once.
			expect(screen.getByText("Seasons").previousElementSibling).toHaveTextContent("3");
			expect(screen.getByText("Episodes").previousElementSibling).toHaveTextContent("4");
		});

		it("counts a single season and episode in the singular", async () => {
			renderModal({ episodes: [pilot] });
			await loaded();
			expect(screen.getByText("Season").previousElementSibling).toHaveTextContent("1");
			expect(screen.getByText("Episode").previousElementSibling).toHaveTextContent("1");
		});

		it("shows a loading line and no plot until OMDb answers", async () => {
			tauri.fetchOmdbData.mockReturnValue(new Promise(() => {}));
			renderModal();
			await act(async () => {});
			expect(screen.getByText("Loading info…")).toBeInTheDocument();
			expect(screen.queryByText("A family runs a hotel by the sea.")).toBeNull();
		});

		it("prefers Whatson's poster, rating and tagline", async () => {
			tauri.fetchOmdbData.mockResolvedValue({ ...showOmdb, plot: "N/A" });
			tauri.fetchWhatsonData.mockResolvedValue({
				image: "https://img.example.test/show-wide.jpg",
				certification: "TV-14",
				tagline: "Check in. Never leave.",
			});
			const { container } = renderModal();
			expect(await screen.findByText("TV-14")).toBeInTheDocument();
			expect(screen.queryByText("PG-13")).toBeNull();
			expect(screen.getByText("Check in. Never leave.")).toBeInTheDocument();
			expect(container.querySelector("img")).toHaveAttribute(
				"src",
				"https://img.example.test/show-wide.jpg"
			);
		});

		it("leaves out N/A fields, shortens a long cast and falls back to the episode logo", async () => {
			const actors =
				"Halina Reijn, Thom Hoffman, Jan Kuijpers, Ton Kortooms, Cord Bothmann, Pierre Chevalier";
			tauri.fetchOmdbData.mockResolvedValue(
				makeOmdb({
					year: "N/A",
					rated: "N/A",
					genre: "N/A",
					director: "N/A",
					plot: "N/A",
					posterUrl: "N/A",
					runtime: "49 min",
					actors,
				})
			);
			const { container } = renderModal({
				episodes: [{ ...pilot, logoUrl: "https://img.example.test/show-logo.png" }],
			});
			await loaded();
			expect(container.textContent).not.toContain("N/A");
			expect(screen.getByText("49 min/ep")).toBeInTheDocument();
			expect(screen.queryByText(/Created by:/)).toBeNull();
			expect(screen.getByText(`Cast: ${actors.slice(0, 57)}...`)).toBeInTheDocument();
			expect(container.querySelector("img")).toHaveAttribute(
				"src",
				"https://img.example.test/show-logo.png"
			);
		});

		it("still shows the OMDb details when Whatson fails", async () => {
			tauri.fetchWhatsonData.mockRejectedValue(new Error("offline"));
			renderModal();
			await loaded();
			expect(tauri.fetchWhatsonData).toHaveBeenCalled();
			expect(screen.getByText("Drama · 49 min/ep")).toBeInTheDocument();
		});

		it("shows the empty placeholder when OMDb fails", async () => {
			tauri.fetchOmdbData.mockRejectedValue(new Error("offline"));
			const { container } = renderModal();
			expect(await screen.findByText("Series · —")).toBeInTheDocument();
			expect(container.querySelector("img")).toBeNull();
		});

		it("uses the player's details without fetching and takes later Whatson details", async () => {
			const { rerenderWith } = renderModal({ prefetchedOmdbData: showOmdb });
			await act(async () => {});
			expect(tauri.fetchOmdbData).not.toHaveBeenCalled();
			expect(screen.getByText("PG-13")).toBeInTheDocument();

			rerenderWith({
				prefetchedOmdbData: showOmdb,
				prefetchedWhatsonData: { certification: "TV-MA" },
			});
			expect(screen.getByText("TV-MA")).toBeInTheDocument();
			expect(tauri.fetchWhatsonData).not.toHaveBeenCalled();
		});

		it("says there are no episodes and looks nothing up for an empty list", async () => {
			renderModal({ episodes: [] });
			expect(await screen.findByText("Series · —")).toBeInTheDocument();
			expect(screen.getByText("No episodes found")).toBeInTheDocument();
			expect(tauri.fetchOmdbData).not.toHaveBeenCalled();
		});
	});

	describe("browsing", () => {
		it("lists the seasons in order with the unknown season first", async () => {
			renderModal();
			await loaded();
			expect(
				screen.getAllByText(/^(Unknown Season|Season \d+)$/).map((e) => e.textContent)
			).toEqual(["Unknown Season", "Season 1", "Season 2"]);
			expect(within(rowOf("Unknown Season")).getByText("?")).toBeInTheDocument();
			expect(within(rowOf("Season 1")).getByText("2 episodes")).toBeInTheDocument();
			expect(within(rowOf("Season 2")).getByText("1 episode")).toBeInTheDocument();
		});

		it("lists a season's episodes in order and plays the one clicked", async () => {
			const { onPlay } = renderModal();
			await loaded();
			open("Season 1");

			expect(screen.getByRole("button", { name: "Show" })).toBeInTheDocument();
			expect(screen.queryByText("Seasons")).toBeNull();
			expect(
				rowOf("Pilot").compareDocumentPosition(rowOf("Second")) &
					Node.DOCUMENT_POSITION_FOLLOWING
			).toBeTruthy();
			expect(within(rowOf("Pilot")).getByText("01")).toBeInTheDocument();
			expect(within(rowOf("Second")).getByText("02")).toBeInTheDocument();
			expect(
				within(rowOf("Pilot")).getByRole("button", { name: "Choose from 2 sources" })
			).toHaveTextContent("2 sources");
			expect(within(rowOf("Second")).queryByRole("button", { name: /sources/ })).toBeNull();

			open("Second");
			expect(onPlay).toHaveBeenCalledExactlyOnceWith(second);
		});

		it("shows the whole name when an episode has no title and ? without a number", async () => {
			renderModal({ episodes: [makeEpisode(1, 3, ""), bonus] });
			await loaded();
			open("Season 1");
			expect(screen.getByText("Show S01E03")).toBeInTheDocument();

			back("Show");
			open("Unknown Season");
			expect(within(rowOf("Show Bonus Clip")).getByText("?")).toBeInTheDocument();
		});

		it("lists an episode's sources and plays the one picked", async () => {
			const { onPlay } = renderModal({ currentUrl: MIRROR });
			await loaded();
			open("Season 1");
			fireEvent.click(screen.getByRole("button", { name: "Choose from 2 sources" }));

			expect(screen.getByRole("button", { name: "Season 1" })).toBeInTheDocument();
			expect(screen.getByText("Pilot")).toBeInTheDocument();
			expect(screen.getByText("Choose a source to play")).toBeInTheDocument();
			const first = screen.getByText("Source 1").closest("button") as HTMLElement;
			const mirror = screen.getByText("Source 2").closest("button") as HTMLElement;
			expect(first).toHaveTextContent("Default · cdn.example.test · MKV");
			expect(mirror).toHaveTextContent("Playing · mirror.example.test · MP4");

			fireEvent.click(mirror);
			expect(onPlay).toHaveBeenCalledExactlyOnceWith({
				...mergedPilot,
				url: MIRROR,
				sourceList: [pilot.url, MIRROR],
			});
		});

		it("plays the episode as it is from its default source", async () => {
			const { onPlay } = renderModal();
			await loaded();
			open("Season 1");
			fireEvent.click(screen.getByRole("button", { name: "Choose from 2 sources" }));
			const first = screen.getByText("Source 1").closest("button") as HTMLElement;
			expect(first).not.toHaveTextContent("Playing");
			fireEvent.click(first);
			expect(onPlay).toHaveBeenCalledExactlyOnceWith(mergedPilot);
		});

		it("steps back from the sources to the episodes and then the seasons", async () => {
			renderModal();
			await loaded();
			open("Season 1");
			fireEvent.click(screen.getByRole("button", { name: "Choose from 2 sources" }));

			back("Season 1");
			expect(screen.getByText("Second")).toBeInTheDocument();
			back("Show");
			expect(screen.getByText("Seasons")).toBeInTheDocument();
			expect(screen.getByText("Season 2")).toBeInTheDocument();
		});

		it("leads back to the unknown season from its episode's sources", async () => {
			renderModal({ episodes: [{ ...bonus, sources: [MIRROR] }] });
			await loaded();
			open("Unknown Season");
			fireEvent.click(screen.getByRole("button", { name: "Choose from 2 sources" }));
			back("Unknown Season");
			expect(screen.getByText("Show Bonus Clip")).toBeInTheDocument();
		});

		it("says there are no episodes when the open season goes away", async () => {
			const { rerenderWith } = renderModal();
			await loaded();
			open("Season 2");
			expect(screen.getByText("Comeback")).toBeInTheDocument();

			rerenderWith({ episodes: [second, pilot] });
			expect(screen.getByText("No episodes")).toBeInTheDocument();
		});
	});

	describe("downloads", () => {
		it("downloads the series' missing episodes from the header after saving the list", async () => {
			withDownloads(epDownload(pilot, "completed"));
			renderModal();
			await loaded();
			fireEvent.click(within(header()).getByRole("button", { name: "Partially downloaded" }));
			expect(tauri.cacheSeriesEpisodes).toHaveBeenCalledExactlyOnceWith(SERIES, episodes);
			expect(tauri.enqueueEpisodesBatch).toHaveBeenCalledExactlyOnceWith(
				[second, comeback, bonus],
				SERIES,
				"Show"
			);
			expect(tauri.cacheSeriesEpisodes.mock.invocationCallOrder[0]).toBeLessThan(
				tauri.enqueueEpisodesBatch.mock.invocationCallOrder[0]
			);
		});

		it("downloads nine episodes without asking", async () => {
			const nine = Array.from({ length: 9 }, (_, i) =>
				makeEpisode(1, i + 1, `Part ${i + 1}`)
			);
			renderModal({ episodes: nine });
			await loaded();

			fireEvent.click(within(header()).getByRole("button", { name: "Download" }));
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(tauri.enqueueEpisodesBatch).toHaveBeenCalledExactlyOnceWith(
				nine,
				SERIES,
				"Show"
			);
		});

		it("asks before downloading ten or more episodes", async () => {
			const many = Array.from({ length: 10 }, (_, i) =>
				makeEpisode(1, i + 1, `Part ${i + 1}`)
			);
			renderModal({ episodes: many });
			await loaded();

			fireEvent.click(within(header()).getByRole("button", { name: "Download" }));
			expect(screen.getByRole("dialog", { name: "Download episodes?" })).toHaveTextContent(
				"Download 10 episodes? This may use significant disk space and bandwidth."
			);
			confirmIn("Cancel");
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(tauri.enqueueEpisodesBatch).not.toHaveBeenCalled();

			fireEvent.click(within(header()).getByRole("button", { name: "Download" }));
			confirmIn("Download");
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(tauri.cacheSeriesEpisodes).toHaveBeenCalledExactlyOnceWith(SERIES, many);
			expect(tauri.enqueueEpisodesBatch).toHaveBeenCalledExactlyOnceWith(
				many,
				SERIES,
				"Show"
			);
		});

		it("downloads one season's episodes from its row and stays on the list", async () => {
			renderModal();
			await loaded();
			fireEvent.click(within(rowOf("Season 2")).getByRole("button", { name: "Download" }));
			expect(tauri.enqueueEpisodesBatch).toHaveBeenCalledExactlyOnceWith(
				[comeback],
				SERIES,
				"Show"
			);
			expect(screen.getByText("Seasons")).toBeInTheDocument();
		});

		it("stops the series' running downloads from the header", async () => {
			withDownloads(epDownload(pilot, "downloading"), epDownload(second, "queued"));
			renderModal();
			await loaded();
			fireEvent.click(within(header()).getByRole("button", { name: "Downloading" }));
			expect(screen.getByRole("dialog")).toHaveTextContent(
				"Stop 2 downloads? Partial files are discarded."
			);
			confirmIn("Stop");
			expect(idsSentTo(tauri.stopDownloads)).toEqual(["dl-s1e1", "dl-s1e2"]);
		});

		it("stops a season's one running download from its row", async () => {
			withDownloads(epDownload(comeback, "downloading"));
			renderModal();
			await loaded();
			fireEvent.click(within(rowOf("Season 2")).getByRole("button", { name: "Downloading" }));
			expect(screen.getByRole("dialog")).toHaveTextContent(
				"Stop this download? The partial file is discarded."
			);
			confirmIn("Stop");
			expect(tauri.stopDownloads).toHaveBeenCalledExactlyOnceWith(["dl-s2e1"]);
		});

		it("removes every finished episode from the header", async () => {
			withDownloads(
				epDownload(pilot, "completed"),
				epDownload(second, "completed"),
				epDownload(comeback, "completed"),
				epDownload(bonus, "completed")
			);
			renderModal();
			await loaded();
			fireEvent.click(within(header()).getByRole("button", { name: "Downloaded" }));
			expect(screen.getByRole("dialog")).toHaveTextContent(
				"Remove 4 episodes? This deletes the downloaded file(s)."
			);
			confirmIn("Remove");
			expect(idsSentTo(tauri.removeDownloads)).toEqual([
				"dl-bonus",
				"dl-s1e1",
				"dl-s1e2",
				"dl-s2e1",
			]);
		});

		it("removes a season's one finished episode from its row", async () => {
			withDownloads(epDownload(comeback, "completed"));
			renderModal();
			await loaded();
			fireEvent.click(within(rowOf("Season 2")).getByRole("button", { name: "Downloaded" }));
			expect(screen.getByRole("dialog")).toHaveTextContent(
				"Remove 1 episode? This deletes the downloaded file(s)."
			);
			confirmIn("Remove");
			expect(tauri.removeDownloads).toHaveBeenCalledExactlyOnceWith(["dl-s2e1"]);
		});

		it("downloads a single episode without playing it", async () => {
			const { onPlay } = renderModal();
			await loaded();
			open("Season 1");
			fireEvent.click(within(rowOf("Second")).getByRole("button", { name: "Download" }));
			expect(tauri.cacheSeriesEpisodes).toHaveBeenCalledExactlyOnceWith(SERIES, episodes);
			expect(tauri.enqueueEpisodeDownload).toHaveBeenCalledExactlyOnceWith(
				second,
				SERIES,
				"Show"
			);
			expect(onPlay).not.toHaveBeenCalled();
		});

		it("stops one episode's download and removes another's", async () => {
			withDownloads(epDownload(pilot, "downloading"), epDownload(second, "completed"));
			renderModal();
			await loaded();
			open("Season 1");

			fireEvent.click(within(rowOf("Pilot")).getByRole("button", { name: "Downloading" }));
			confirmIn("Stop");
			expect(tauri.stopDownload).toHaveBeenCalledExactlyOnceWith("dl-s1e1");

			fireEvent.click(within(rowOf("Second")).getByRole("button", { name: "Downloaded" }));
			expect(screen.getByRole("dialog")).toHaveTextContent(
				"Remove this download? This deletes the downloaded file."
			);
			confirmIn("Remove");
			expect(tauri.removeDownload).toHaveBeenCalledExactlyOnceWith("dl-s1e2");
		});

		it("retries a failed episode download", async () => {
			withDownloads(epDownload(second, "failed"));
			renderModal();
			await loaded();
			open("Season 1");
			fireEvent.click(
				within(rowOf("Second")).getByRole("button", { name: "Download failed — retry" })
			);
			expect(tauri.enqueueEpisodeDownload).toHaveBeenCalledExactlyOnceWith(
				second,
				SERIES,
				"Show"
			);
		});

		it("says when finished episodes get deleted and can keep one", async () => {
			downloads.retentionDays = 30;
			withDownloads(epDownload(second, "completed"));
			renderModal();
			await loaded();
			expect(
				within(header()).getByRole("button", { name: "Deletes in 30 days. Keep" })
			).toBeInTheDocument();

			open("Season 1");
			fireEvent.click(
				within(rowOf("Second")).getByRole("button", { name: "Deletes in 30 days. Keep" })
			);
			expect(tauri.setDownloadKeep).toHaveBeenCalledExactlyOnceWith("dl-s1e2", true);
			expect(within(rowOf("Pilot")).queryByRole("button", { name: /Deletes/ })).toBeNull();
		});
	});

	describe("closing", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		const advance = (ms: number) =>
			act(() => {
				vi.advanceTimersByTime(ms);
			});

		it("closes after sliding away when the close button is clicked", () => {
			const { onClose } = renderModal({ prefetchedOmdbData: showOmdb });
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			advance(299);
			expect(onClose).not.toHaveBeenCalled();
			advance(1);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("closes when the backdrop is clicked", () => {
			const { container, onClose } = renderModal({ prefetchedOmdbData: showOmdb });
			fireEvent.click(container.firstElementChild!.firstElementChild!);
			advance(300);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("closes once an episode starts playing", () => {
			const { onClose } = renderModal({ prefetchedOmdbData: showOmdb });
			open("Season 2");
			open("Comeback");
			advance(300);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("closes once a source starts playing", () => {
			const { onClose, onPlay } = renderModal({ prefetchedOmdbData: showOmdb });
			open("Season 1");
			fireEvent.click(screen.getByRole("button", { name: "Choose from 2 sources" }));
			open("Source 2");
			expect(onPlay).toHaveBeenCalledTimes(1);
			advance(300);
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});
