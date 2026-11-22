// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { parseSrt } from "@/lib/subtitle-parser";
import {
	downloadSubtitle,
	mpvSubAdd,
	mpvSubRemove,
	readSubtitleFile,
	searchSubtitles,
} from "@/lib/tauri";
import type { SubtitleCue, SubtitleEntry, SubtitleSearchResult } from "@/lib/types";

/** A subtitle choice, which the next one, made by the viewer, replaces. */
export interface SubtitlePick {
	/** False once the viewer has picked again. */
	latest: () => boolean;
	/**
	 * The stream to add the subtitles to. Null once the viewer has picked
	 * again, the page has closed or the player has moved on to another item,
	 * and while the player starts the item.
	 */
	stream: () => string | null;
	/**
	 * Called when mpv has added a track it draws for the stream `url`, and the
	 * player has no stream for the pick any more, as when the page closed.
	 * Keeps the pick for when the page opens again, and returns false when the
	 * player can't keep it, as when it has moved on.
	 */
	keep: (url: string, entry: SubtitleEntry, rankInLanguage: number) => boolean;
}

export interface SubtitleSearchOptions {
	imdbId: string;
	season?: number;
	episode?: number;
	onClose: () => void;
	/**
	 * Called as the viewer picks a subtitle or None. A subtitle that finishes
	 * downloading once its pick has no stream is dropped.
	 */
	startPick: () => SubtitlePick;
	onSubtitleSelected?: (
		fileId: number | null,
		cues?: SubtitleCue[],
		entry?: SubtitleEntry | null,
		rankInLanguage?: number
	) => void;
	/** The subtitle in use, so the choice shows when the list opens again. */
	currentSelectedId?: number | null;
}

/** Finds the subtitles for what's playing, and adds the one the viewer picks. */
export const useSubtitleSearch = ({
	imdbId,
	season,
	episode,
	onClose,
	startPick,
	onSubtitleSelected,
	currentSelectedId = null,
}: SubtitleSearchOptions) => {
	const [loading, setLoading] = useState(true);
	const [result, setResult] = useState<SubtitleSearchResult | null>(null);
	const [selectedFileId, setSelectedFileId] = useState<number | null>(currentSelectedId);
	const [downloadingId, setDownloadingId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let current = true;
		searchSubtitles(imdbId, season, episode)
			.then((found) => {
				if (current) setResult(found);
			})
			.catch((e) => {
				if (current) setError(String(e));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [imdbId, season, episode]);

	const grouped = result
		? result.languages.map((lang) => ({
				lang,
				entries: result.entries.filter((e) => e.languageCode === lang),
			}))
		: [];

	const handleSelect = async (entry: SubtitleEntry) => {
		if (downloadingId !== null) return;
		const pick = startPick();
		setDownloadingId(entry.fileId);
		setError(null);
		try {
			const localPath = await downloadSubtitle(entry.fileId);
			// mpv also reads a file that isn't UTF-8, and draws any file the
			// overlay can't read. A file that neither can read is an error.
			const cues = await readSubtitleFile(localPath).then(parseSrt, () => []);
			// The new track takes the place of the one in use, and a failed add
			// leaves the old one. Nothing is added once the viewer has picked
			// again, the page has closed or the player has moved on. While the
			// player starts the item, there's no stream to add it to yet.
			const url = pick.stream();
			if (url === null) {
				if (pick.latest())
					setError("The video was still starting. Pick the subtitle again.");
				return;
			}
			// Compute rank within this language group for auto-selection on next episode.
			const langGroup = grouped.find((g) => g.lang === entry.languageCode);
			const rankInLanguage =
				langGroup?.entries.findIndex((e) => e.fileId === entry.fileId) ?? 0;
			const added = mpvSubAdd(localPath, cues.length > 0, url);
			if (cues.length > 0) added.catch(() => {});
			else {
				await added;
				// mpv draws this track itself. A newer pick replaces it on its
				// own. mpv took the old track out for it, so when the page
				// closed during the add, the player keeps this pick for when
				// the page opens again. When it can't, or the item changed, the
				// track comes out again, so it doesn't show over the subtitles
				// the player keeps.
				if (!pick.latest()) return;
				if (pick.stream() === null) {
					if (pick.keep(url, entry, rankInLanguage)) return;
					await mpvSubRemove(-1, url).catch(() => {});
					return;
				}
			}
			setSelectedFileId(entry.fileId);
			onSubtitleSelected?.(entry.fileId, cues, entry, rankInLanguage);
			onClose();
		} catch (e) {
			console.error("[SubtitlePicker] subtitle load error:", e);
			if (pick.latest()) setError("Failed to load subtitle. Try another.");
		} finally {
			if (pick.latest()) setDownloadingId(null);
		}
	};

	// None also drops a subtitle still downloading, and frees the list to
	// pick another. An add already on its way to mpv runs first, so the
	// remove takes its track out too. None only shows once the search found
	// subtitles, so a message then is about an earlier pick, and goes.
	const handleNone = () => {
		startPick();
		setDownloadingId(null);
		setSelectedFileId(null);
		setError(null);
		mpvSubRemove(-1).catch(() => {});
		onSubtitleSelected?.(null, [], null, undefined);
	};

	return {
		loading,
		result,
		grouped,
		selectedFileId,
		downloadingId,
		error,
		handleSelect,
		handleNone,
	};
};
