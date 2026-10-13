// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router";
import type { Channel, OmdbData } from "@/lib/types";

const tauri = vi.hoisted(() => ({
	getOmdbApiKey: vi.fn<() => Promise<string | null>>(),
	fetchOmdbData: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/lib/tauri", () => ({
	getOmdbApiKey: tauri.getOmdbApiKey,
	fetchOmdbData: tauri.fetchOmdbData,
	fetchWhatsonData: vi.fn().mockResolvedValue(null),
	enqueueMovieDownload: vi.fn(),
	enqueueEpisodeDownload: vi.fn(),
	enqueueEpisodesBatch: vi.fn(),
	stopDownload: vi.fn(),
	stopDownloads: vi.fn(),
	removeDownload: vi.fn(),
	removeDownloads: vi.fn(),
	cacheSeriesEpisodes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useDownloads", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useDownloads")>()),
	useDownloads: () => ({ byChannel: new Map(), bySeries: new Map() }),
}));

import { MovieInfoDrawer } from "./MovieInfoDrawer";
import { SeriesDetailModal } from "./SeriesDetailModal";
import { rememberHasOmdbKey } from "@/hooks/useHasOmdbKey";

const HINT = /Add an OMDb API key in Settings/;

const movie: Channel = {
	id: "m1",
	name: "Sintel",
	url: "https://example.com/sintel.m3u8",
	groupTitle: "Movies",
	isFavorite: false,
	contentType: "movie",
	sources: [],
};

const episode: Channel = {
	...movie,
	id: "e1",
	name: "Show S01E01",
	contentType: "series",
	seriesTitle: "Show",
	season: 1,
	episode: 1,
};

const SettingsPage = () => {
	const location = useLocation();
	const state = location.state as { focus?: string } | null;
	return <p>settings focus={state?.focus ?? "none"}</p>;
};

const inRouter = (sheet: ReactNode) =>
	render(
		<MemoryRouter initialEntries={["/"]}>
			<Routes>
				<Route path="/" element={sheet} />
				<Route path="/settings" element={<SettingsPage />} />
			</Routes>
		</MemoryRouter>
	);

const renderMovie = (onClose = vi.fn(), prefetchedOmdbData?: OmdbData | null) =>
	inRouter(
		<MovieInfoDrawer
			movie={movie}
			onClose={onClose}
			onPlay={vi.fn()}
			prefetchedOmdbData={prefetchedOmdbData}
		/>
	);

const renderSeries = (onClose = vi.fn()) =>
	inRouter(
		<SeriesDetailModal
			showTitle="Show"
			episodes={[episode]}
			seriesChannelId="s1"
			onClose={onClose}
			onPlay={vi.fn()}
		/>
	);

describe("OMDb key hint", () => {
	beforeEach(() => rememberHasOmdbKey(null));
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("points to Settings in the movie sheet when no key is saved", async () => {
		tauri.getOmdbApiKey.mockResolvedValue(null);
		tauri.fetchOmdbData.mockResolvedValue(null);
		const onClose = vi.fn();
		renderMovie(onClose);

		fireEvent.click(await screen.findByRole("link", { name: HINT }));
		expect(onClose).toHaveBeenCalled();
		expect(await screen.findByText("settings focus=omdb")).toBeTruthy();
	});

	it("keeps the placeholder when a key is saved but OMDb has nothing", async () => {
		tauri.getOmdbApiKey.mockResolvedValue("saved-key");
		tauri.fetchOmdbData.mockResolvedValue(null);
		renderMovie();

		expect(await screen.findByText("— · —")).toBeTruthy();
		expect(screen.queryByRole("link", { name: HINT })).toBeNull();
	});

	it("shows the OMDb details instead of the hint when they're cached", async () => {
		tauri.getOmdbApiKey.mockResolvedValue(null);
		tauri.fetchOmdbData.mockResolvedValue({ genre: "Animation" } as OmdbData);
		renderMovie();

		expect(await screen.findByText("Animation")).toBeTruthy();
		expect(screen.queryByRole("link", { name: HINT })).toBeNull();
		expect(tauri.getOmdbApiKey).not.toHaveBeenCalled();
	});

	it("doesn't check the key when the player passes OMDb details", async () => {
		renderMovie(vi.fn(), { genre: "Animation" } as OmdbData);

		expect(screen.getByText("Animation")).toBeTruthy();
		await act(async () => {});
		expect(tauri.getOmdbApiKey).not.toHaveBeenCalled();
		expect(tauri.fetchOmdbData).not.toHaveBeenCalled();
	});

	it("keeps loading until the key check answers", async () => {
		tauri.getOmdbApiKey.mockReturnValue(new Promise(() => {}));
		tauri.fetchOmdbData.mockResolvedValue(null);
		renderMovie();

		// Let the OMDb fetch finish while the key check is still out.
		await act(async () => {});
		expect(tauri.fetchOmdbData).toHaveBeenCalled();
		expect(screen.getByText("Loading info…")).toBeTruthy();
		expect(screen.queryByRole("link", { name: HINT })).toBeNull();
		expect(screen.queryByText("— · —")).toBeNull();
	});

	it("checks the key again each time the sheet opens", async () => {
		tauri.getOmdbApiKey.mockResolvedValue(null);
		tauri.fetchOmdbData.mockResolvedValue(null);
		renderMovie();
		await screen.findByRole("link", { name: HINT });
		cleanup();

		tauri.getOmdbApiKey.mockResolvedValue("saved-key");
		renderMovie();
		expect(await screen.findByText("— · —")).toBeTruthy();
		expect(screen.queryByRole("link", { name: HINT })).toBeNull();
	});

	it("points to Settings in the series sheet when no key is saved", async () => {
		tauri.getOmdbApiKey.mockResolvedValue(null);
		tauri.fetchOmdbData.mockResolvedValue(null);
		const onClose = vi.fn();
		renderSeries(onClose);

		fireEvent.click(await screen.findByRole("link", { name: HINT }));
		expect(onClose).toHaveBeenCalled();
		expect(await screen.findByText("settings focus=omdb")).toBeTruthy();
	});

	it("keeps the series placeholder when a key is saved", async () => {
		tauri.getOmdbApiKey.mockResolvedValue("saved-key");
		tauri.fetchOmdbData.mockResolvedValue(null);
		renderSeries();

		expect(await screen.findByText("Series · —")).toBeTruthy();
		expect(screen.queryByRole("link", { name: HINT })).toBeNull();
	});

	it("shows the last answer at once when the player passes no OMDb data", async () => {
		tauri.getOmdbApiKey.mockResolvedValue("saved-key");
		tauri.fetchOmdbData.mockResolvedValue(null);
		renderMovie();
		await screen.findByText("— · —");
		cleanup();

		// The player found nothing on OMDb, and this time the key check is slow.
		tauri.getOmdbApiKey.mockReturnValue(new Promise(() => {}));
		renderMovie(vi.fn(), null);
		expect(screen.getByText("— · —")).toBeTruthy();
		expect(screen.queryByText("Loading info…")).toBeNull();
		expect(tauri.fetchOmdbData).toHaveBeenCalledTimes(1);
	});

	it("takes a key saved in Settings as the last answer", () => {
		rememberHasOmdbKey(true);
		tauri.getOmdbApiKey.mockReturnValue(new Promise(() => {}));
		renderMovie(vi.fn(), null);
		expect(screen.getByText("— · —")).toBeTruthy();
		expect(screen.queryByRole("link", { name: HINT })).toBeNull();
	});
});
