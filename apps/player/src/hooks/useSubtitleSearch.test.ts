// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/deferred";
import { unhandledRejectionsDuring } from "@/test/unhandled-rejections";
import type { SubtitleEntry, SubtitleSearchResult } from "@/lib/types";

const tauri = vi.hoisted(() => ({
	searchSubtitles:
		vi.fn<
			(
				imdbId: string,
				season?: number,
				episode?: number
			) => Promise<SubtitleSearchResult | null>
		>(),
	downloadSubtitle: vi.fn<(fileId: number) => Promise<string>>(),
	readSubtitleFile: vi.fn<(path: string) => Promise<string>>(),
	mpvSubRemove: vi.fn<(id: number, url?: string) => Promise<void>>(),
}));

// A plain function, because a vi.fn handles every rejection of a promise it
// returns, and would hide one the hook leaves unhandled.
const add = vi.hoisted(() => ({ result: (): Promise<void> => Promise.resolve() }));

vi.mock("@/lib/tauri", () => ({ ...tauri, mpvSubAdd: () => add.result() }));

import {
	useSubtitleSearch,
	type SubtitleSearchOptions,
	type SubtitlePick,
} from "./useSubtitleSearch";

const STREAM = "http://example.test/sintel.mkv";
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";

const english: SubtitleEntry = { fileId: 11, languageCode: "en", format: "srt" };
const english2: SubtitleEntry = { fileId: 12, languageCode: "en", format: "srt" };
const french: SubtitleEntry = { fileId: 21, languageCode: "fr", format: "srt" };
const found: SubtitleSearchResult = {
	entries: [english, french, english2],
	languages: ["en", "fr"],
};

const startPick = vi.fn<() => SubtitlePick>();

const search = (overrides: Partial<SubtitleSearchOptions> = {}) => {
	const onClose = vi.fn();
	const view = renderHook(
		(options: Partial<SubtitleSearchOptions>) =>
			useSubtitleSearch({ imdbId: "tt1", onClose, startPick, ...options }),
		{ initialProps: overrides }
	);
	return { ...view, onClose };
};

/** The hook once its search has answered. */
const searched = async (overrides: Partial<SubtitleSearchOptions> = {}) => {
	const view = search(overrides);
	await waitFor(() => expect(view.result.current.loading).toBe(false));
	return view;
};

beforeEach(() => {
	vi.clearAllMocks();
	tauri.searchSubtitles.mockReset().mockResolvedValue(found);
	tauri.downloadSubtitle.mockReset().mockResolvedValue("/tmp/sub.srt");
	tauri.readSubtitleFile.mockReset().mockResolvedValue(SRT);
	add.result = () => Promise.resolve();
	tauri.mpvSubRemove.mockReset().mockResolvedValue();
	startPick.mockReset().mockImplementation(() => ({
		latest: () => true,
		stream: () => STREAM,
		keep: () => false,
	}));
});

describe("useSubtitleSearch searching", () => {
	describe("when a newer search has begun", () => {
		const older = () => {
			const answers: {
				resolve: (found: SubtitleSearchResult) => void;
				reject: (e: unknown) => void;
			}[] = [];
			tauri.searchSubtitles.mockImplementation(
				() =>
					new Promise((resolve, reject) => {
						answers.push({ resolve, reject });
					})
			);
			const view = search({ imdbId: "tt1" });
			view.rerender({ imdbId: "tt2" });
			return { ...view, answers };
		};

		it("ignores the older search's results", async () => {
			const { result, answers } = older();
			await act(async () => answers[1].resolve(found));
			await act(async () => answers[0].resolve({ entries: [french], languages: ["fr"] }));
			expect(result.current.grouped.map((g) => g.lang)).toEqual(["en", "fr"]);
		});

		it("ignores the older search's failure", async () => {
			const { result, answers } = older();
			await act(async () => answers[0].reject("Too many requests"));
			expect(result.current.error).toBeNull();
		});

		it("keeps loading until the newer search answers", async () => {
			const { result, answers } = older();
			await act(async () => answers[0].resolve(found));
			expect(result.current.loading).toBe(true);
			expect(result.current.grouped).toEqual([]);
			await act(async () => answers[1].resolve(found));
			expect(result.current.loading).toBe(false);
		});
	});

	it("searches once for what it's given", async () => {
		await searched({ imdbId: "tt1", season: 1, episode: 2 });
		expect(tauri.searchSubtitles).toHaveBeenCalledExactlyOnceWith("tt1", 1, 2);
	});

	it("searches again as the title, season or episode changes", async () => {
		const { rerender } = await searched({ imdbId: "tt1", season: 1, episode: 2 });

		for (const next of [
			{ imdbId: "tt2", season: 1, episode: 2 },
			{ imdbId: "tt2", season: 2, episode: 2 },
			{ imdbId: "tt2", season: 2, episode: 3 },
		]) {
			await act(async () => rerender(next));
			expect(tauri.searchSubtitles).toHaveBeenLastCalledWith(
				next.imdbId,
				next.season,
				next.episode
			);
		}
		expect(tauri.searchSubtitles).toHaveBeenCalledTimes(4);
	});

	it("has no languages until the search answers", async () => {
		const pending = deferred<SubtitleSearchResult | null>();
		tauri.searchSubtitles.mockReturnValue(pending.promise);
		const { result } = search();
		expect(result.current.grouped).toEqual([]);
		await act(async () => pending.resolve(null));
		expect(result.current.grouped).toEqual([]);
	});

	it("groups the subtitles under their languages", async () => {
		const { result } = await searched();
		expect(result.current.grouped).toEqual([
			{ lang: "en", entries: [english, english2] },
			{ lang: "fr", entries: [french] },
		]);
	});
});

describe("useSubtitleSearch picking", () => {
	it("takes no other pick while one downloads", async () => {
		const download = deferred<string>();
		tauri.downloadSubtitle.mockReturnValue(download.promise);
		const { result } = await searched();

		act(() => void result.current.handleSelect(english));
		expect(result.current.downloadingId).toBe(english.fileId);
		await act(async () => result.current.handleSelect(french));

		expect(startPick).toHaveBeenCalledOnce();
		expect(tauri.downloadSubtitle).toHaveBeenCalledExactlyOnceWith(english.fileId);
		await act(async () => download.resolve("/tmp/sub.srt"));
	});

	it("clears the last message as a new pick starts", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		tauri.downloadSubtitle.mockRejectedValueOnce(new Error("gone"));
		const { result } = await searched();

		await act(async () => result.current.handleSelect(english));
		expect(result.current.error).toBe("Failed to load subtitle. Try another.");

		const download = deferred<string>();
		tauri.downloadSubtitle.mockReturnValue(download.promise);
		act(() => void result.current.handleSelect(english));
		expect(result.current.error).toBeNull();

		await act(async () => download.resolve("/tmp/sub.srt"));
		spy.mockRestore();
	});

	it("marks the subtitle as chosen and hands it over with its place in its language", async () => {
		const onSubtitleSelected = vi.fn();
		const { result, onClose } = await searched({ onSubtitleSelected });

		await act(async () => result.current.handleSelect(english2));

		expect(result.current.selectedFileId).toBe(english2.fileId);
		expect(onSubtitleSelected).toHaveBeenCalledExactlyOnceWith(
			english2.fileId,
			[expect.objectContaining({ text: "Hello" })],
			english2,
			1
		);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("counts a subtitle in a language the search didn't list as the first of it", async () => {
		const onSubtitleSelected = vi.fn();
		const unlisted = { ...english, fileId: 31, languageCode: "de" };
		const { result } = await searched({ onSubtitleSelected });

		await act(async () => result.current.handleSelect(unlisted));

		expect(result.current.error).toBeNull();
		expect(onSubtitleSelected.mock.lastCall?.[3]).toBe(0);
	});

	it("carries on past a failed add when the overlay can draw the subtitles", async () => {
		add.result = () => Promise.reject(new Error("mpv is busy"));
		const { result, onClose } = await searched();

		const failed = await unhandledRejectionsDuring(() =>
			act(async () => result.current.handleSelect(english))
		);

		expect(failed).toEqual([]);
		expect(onClose).toHaveBeenCalledOnce();
		expect(result.current.error).toBeNull();
	});

	it("closes after a pick with nothing listening for it", async () => {
		const { result, onClose } = await searched();
		await act(async () => result.current.handleSelect(english));
		expect(onClose).toHaveBeenCalledOnce();
		expect(result.current.selectedFileId).toBe(english.fileId);
	});

	it("takes the subtitle out from None with nothing listening for it", async () => {
		const { result } = await searched({ currentSelectedId: english.fileId });
		expect(result.current.selectedFileId).toBe(english.fileId);

		act(() => result.current.handleNone());

		expect(result.current.selectedFileId).toBeNull();
		expect(tauri.mpvSubRemove).toHaveBeenCalledExactlyOnceWith(-1);
	});
});
