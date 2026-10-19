// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { wrapperFor } from "@/test/query";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadRecord, OmdbData, WhatsonData } from "@/lib/types";
import { makeMovieDownload, makeMovie, makeOmdb } from "@/test/detail-fixtures";

const tauri = vi.hoisted(() => ({
	getOmdbApiKey: vi.fn<() => Promise<string | null>>(),
	fetchOmdbData: vi.fn<(id: string, name: string, kind: string) => Promise<OmdbData | null>>(),
	fetchWhatsonData: vi.fn<(imdbId: string, kind: string) => Promise<WhatsonData | null>>(),
	enqueueMovieDownload: vi.fn<(id: string) => Promise<void>>(),
	stopDownload: vi.fn<(id: string) => Promise<void>>(),
	removeDownload: vi.fn<(id: string) => Promise<void>>(),
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

import { MovieInfoDrawer } from "./MovieInfoDrawer";
import { rememberHasOmdbKey } from "@/hooks/useHasOmdbKey";

const MIRROR = "https://mirror.example.test/sintel.mp4";

type Props = ComponentProps<typeof MovieInfoDrawer>;

const renderDrawer = (props: Partial<Props> = {}) => {
	const all: Props = { movie: makeMovie(), onClose: vi.fn(), onPlay: vi.fn(), ...props };
	const result = render(
		<MemoryRouter>
			<MovieInfoDrawer {...all} />
		</MemoryRouter>,
		{ wrapper: wrapperFor() }
	);
	return { ...result, ...all };
};

/** Waits until the drawer has finished loading the OMDb details. */
const loaded = async () => {
	await screen.findByText("Sintel");
	await act(async () => {});
};

const sourceSelect = () => screen.getByRole("button", { name: "Select source" });

describe("MovieInfoDrawer", () => {
	beforeEach(() => {
		rememberHasOmdbKey(null);
		tauri.getOmdbApiKey.mockResolvedValue("saved-key");
		tauri.fetchOmdbData.mockResolvedValue(makeOmdb());
		tauri.fetchWhatsonData.mockResolvedValue(null);
		tauri.enqueueMovieDownload.mockResolvedValue();
		tauri.stopDownload.mockResolvedValue();
		tauri.removeDownload.mockResolvedValue();
		tauri.setDownloadKeep.mockResolvedValue();
		downloads.byChannel = new Map();
		downloads.retentionDays = null;
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe("details", () => {
		it("shows the movie's OMDb details", async () => {
			const { container } = renderDrawer();
			await loaded();
			expect(tauri.fetchOmdbData).toHaveBeenCalledExactlyOnceWith("mv1", "Sintel", "movie");
			expect(screen.getByText("(2010)")).toBeInTheDocument();
			expect(screen.getByText("PG-13")).toBeInTheDocument();
			expect(screen.getByText("7.4")).toBeInTheDocument();
			expect(screen.getByText("Animation · 15 min")).toBeInTheDocument();
			expect(screen.getByText("Dir: Colin Levy")).toBeInTheDocument();
			expect(screen.getByText("Cast: Halina Reijn, Thom Hoffman")).toBeInTheDocument();
			expect(
				screen.getByText("A lonely young woman searches for her baby dragon.")
			).toBeInTheDocument();
			expect(container.querySelector("img")).toHaveAttribute(
				"src",
				"https://img.example.test/sintel.jpg"
			);
		});

		it("shows a loading line and no plot until OMDb answers", async () => {
			tauri.fetchOmdbData.mockReturnValue(new Promise(() => {}));
			renderDrawer();
			await act(async () => {});
			expect(screen.getByText("Loading info…")).toBeInTheDocument();
			expect(screen.queryByText("Sintel")).toBeNull();
			expect(screen.queryByText(/baby dragon/)).toBeNull();
		});

		it("looks up Whatson by the IMDb id and prefers its poster, rating and tagline", async () => {
			tauri.fetchOmdbData.mockResolvedValue(makeOmdb({ plot: "N/A" }));
			tauri.fetchWhatsonData.mockResolvedValue({
				image: "https://img.example.test/sintel-wide.jpg",
				certification: "12A",
				tagline: "Some dragons are worth finding.",
				imdbRating: 8.1,
			});
			const { container } = renderDrawer();
			expect(await screen.findByText("12A")).toBeInTheDocument();
			expect(tauri.fetchWhatsonData).toHaveBeenCalledExactlyOnceWith("tt1727587", "movie");
			expect(screen.queryByText("PG-13")).toBeNull();
			expect(screen.getByText("8.1")).toBeInTheDocument();
			expect(screen.getByText("Some dragons are worth finding.")).toBeInTheDocument();
			expect(container.querySelector("img")).toHaveAttribute(
				"src",
				"https://img.example.test/sintel-wide.jpg"
			);
		});

		it("doesn't ask Whatson when OMDb has no IMDb id", async () => {
			tauri.fetchOmdbData.mockResolvedValue(makeOmdb({ imdbId: undefined }));
			renderDrawer();
			await loaded();
			expect(tauri.fetchWhatsonData).not.toHaveBeenCalled();
		});

		it("leaves out fields OMDb marks N/A and falls back to the channel logo", async () => {
			tauri.fetchOmdbData.mockResolvedValue(
				makeOmdb({
					year: "N/A",
					rated: "N/A",
					genre: "N/A",
					runtime: "N/A",
					director: "N/A",
					actors: "N/A",
					plot: "N/A",
					posterUrl: "N/A",
				})
			);
			const { container } = renderDrawer({
				movie: makeMovie({ logoUrl: "https://img.example.test/logo.png" }),
			});
			await loaded();
			expect(container.textContent).not.toContain("N/A");
			expect(screen.queryByText(/Dir:/)).toBeNull();
			expect(screen.queryByText(/Cast:/)).toBeNull();
			expect(container.querySelector("img")).toHaveAttribute(
				"src",
				"https://img.example.test/logo.png"
			);
		});

		it("shows a placeholder icon instead of a poster when there's no artwork", async () => {
			tauri.fetchOmdbData.mockResolvedValue(makeOmdb({ posterUrl: undefined }));
			const { container } = renderDrawer();
			await loaded();
			expect(container.querySelector("img")).toBeNull();
		});

		it("shortens a long cast list", async () => {
			const actors =
				"Halina Reijn, Thom Hoffman, Jan Kuijpers, Ton Kortooms, Cord Bothmann, Pierre Chevalier";
			tauri.fetchOmdbData.mockResolvedValue(makeOmdb({ actors }));
			renderDrawer();
			await loaded();
			expect(screen.getByText(`Cast: ${actors.slice(0, 57)}...`)).toBeInTheDocument();
		});

		it("still shows the OMDb details when Whatson fails", async () => {
			tauri.fetchWhatsonData.mockRejectedValue(new Error("offline"));
			renderDrawer();
			await loaded();
			expect(tauri.fetchWhatsonData).toHaveBeenCalled();
			expect(screen.getByText("PG-13")).toBeInTheDocument();
		});

		it("shows the empty placeholder when OMDb fails", async () => {
			tauri.fetchOmdbData.mockRejectedValue(new Error("offline"));
			renderDrawer();
			expect(await screen.findByText("— · —")).toBeInTheDocument();
			expect(screen.getByText("Sintel")).toBeInTheDocument();
		});

		it("uses the player's details without fetching and takes later Whatson details", async () => {
			const { rerender, movie, onClose, onPlay } = renderDrawer({
				prefetchedOmdbData: makeOmdb(),
			});
			await act(async () => {});
			expect(tauri.fetchOmdbData).not.toHaveBeenCalled();
			expect(tauri.fetchWhatsonData).not.toHaveBeenCalled();
			expect(screen.getByText("PG-13")).toBeInTheDocument();

			rerender(
				<MemoryRouter>
					<MovieInfoDrawer
						movie={movie}
						onClose={onClose}
						onPlay={onPlay}
						prefetchedOmdbData={makeOmdb()}
						prefetchedWhatsonData={{ certification: "12A" }}
					/>
				</MemoryRouter>
			);
			expect(screen.getByText("12A")).toBeInTheDocument();
			expect(screen.queryByText("PG-13")).toBeNull();
		});
	});

	describe("playing", () => {
		it("plays the movie as it is when it has one source", async () => {
			const { movie, onPlay } = renderDrawer();
			await loaded();
			expect(screen.queryByRole("button", { name: "Select source" })).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
			expect(onPlay).toHaveBeenCalledExactlyOnceWith(movie);
		});

		it("plays the source picked from the list", async () => {
			const movie = makeMovie({ sources: [MIRROR] });
			const { onPlay } = renderDrawer({ movie });
			await loaded();

			expect(sourceSelect()).toHaveTextContent("Source 1 (default) · cdn.example.test · MKV");
			fireEvent.click(sourceSelect());
			const options = screen.getAllByRole("option");
			expect(options.map((o) => o.textContent)).toEqual([
				"Source 1 (default) · cdn.example.test · MKV",
				"Source 2 · mirror.example.test · MP4",
			]);
			fireEvent.click(options[1]);
			expect(sourceSelect()).toHaveTextContent("Source 2 · mirror.example.test · MP4");

			fireEvent.click(screen.getByRole("button", { name: "Play" }));
			expect(onPlay).toHaveBeenCalledExactlyOnceWith({
				...movie,
				url: MIRROR,
				sourceList: [movie.url, MIRROR],
			});
		});

		it("starts on the source that's playing", async () => {
			const movie = makeMovie({
				url: MIRROR,
				sourceList: ["https://cdn.example.test/movies/sintel.mkv", MIRROR],
			});
			const { onPlay } = renderDrawer({ movie });
			await loaded();
			expect(sourceSelect()).toHaveTextContent("Source 2 · mirror.example.test · MP4");
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
			expect(onPlay).toHaveBeenCalledExactlyOnceWith(movie);
		});
	});

	describe("downloads", () => {
		const withDownload = (overrides: Partial<DownloadRecord>) => {
			downloads.byChannel = new Map([["mv1", makeMovieDownload(overrides)]]);
		};

		it("starts a download", async () => {
			renderDrawer();
			await loaded();
			fireEvent.click(screen.getByRole("button", { name: "Download" }));
			expect(tauri.enqueueMovieDownload).toHaveBeenCalledExactlyOnceWith("mv1");
		});

		it("stops a running download after asking", async () => {
			withDownload({ status: "downloading" });
			renderDrawer();
			await loaded();
			fireEvent.click(screen.getByRole("button", { name: "Downloading" }));
			const dialog = screen.getByRole("dialog");
			expect(dialog).toHaveTextContent("Stop this download? The partial file is discarded.");
			fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
			expect(tauri.stopDownload).toHaveBeenCalledExactlyOnceWith("dl1");
		});

		it("counts a queued download as downloading", async () => {
			withDownload({ status: "queued" });
			renderDrawer();
			await loaded();
			expect(screen.getByRole("button", { name: "Downloading" })).toBeInTheDocument();
		});

		it("removes a finished download after asking", async () => {
			withDownload({ status: "completed" });
			renderDrawer();
			await loaded();
			fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
			const dialog = screen.getByRole("dialog");
			expect(dialog).toHaveTextContent("Remove this download?");
			fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
			expect(tauri.removeDownload).toHaveBeenCalledExactlyOnceWith("dl1");
		});

		it("retries a failed download", async () => {
			withDownload({ status: "failed" });
			renderDrawer();
			await loaded();
			fireEvent.click(screen.getByRole("button", { name: "Download failed — retry" }));
			expect(tauri.enqueueMovieDownload).toHaveBeenCalledExactlyOnceWith("mv1");
		});

		it("says when a finished download gets deleted and can keep it", async () => {
			downloads.retentionDays = 30;
			withDownload({ status: "completed" });
			renderDrawer();
			await loaded();
			expect(screen.getByText("Deletes in 30 days")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Keep" }));
			expect(tauri.setDownloadKeep).toHaveBeenCalledExactlyOnceWith("dl1", true);
		});

		it("has no download button for a series episode, which Whatson looks up as a show", async () => {
			renderDrawer({ movie: makeMovie({ contentType: "series" }) });
			await loaded();
			expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
			expect(tauri.fetchWhatsonData).toHaveBeenCalledExactlyOnceWith("tt1727587", "show");
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
			const { onClose } = renderDrawer({ prefetchedOmdbData: makeOmdb() });
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			advance(299);
			expect(onClose).not.toHaveBeenCalled();
			advance(1);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("closes when the backdrop is clicked", () => {
			const { container, onClose } = renderDrawer({ prefetchedOmdbData: makeOmdb() });
			fireEvent.click(container.firstElementChild!.firstElementChild!);
			advance(300);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("closes once playback starts", () => {
			const { onClose, onPlay } = renderDrawer({ prefetchedOmdbData: makeOmdb() });
			fireEvent.click(screen.getByRole("button", { name: "Play" }));
			expect(onPlay).toHaveBeenCalledTimes(1);
			advance(300);
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});
