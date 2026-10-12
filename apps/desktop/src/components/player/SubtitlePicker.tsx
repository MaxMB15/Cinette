// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useRef } from "react";
import { Check, Loader2, X, Settings, ArrowLeft } from "lucide-react";
import {
	searchSubtitles,
	downloadSubtitle,
	readSubtitleFile,
	mpvSubAdd,
	mpvSubRemove,
} from "@/lib/tauri";
import type { SubtitleEntry, SubtitleSearchResult, SubtitleCue } from "@/lib/types";
import { parseSrt } from "@/lib/subtitle-parser";
import { getDelayStep, getDelayInterval } from "@/lib/subtitle-delay";
import { cn } from "@/lib/utils";
import { hasOpenFocusTrap } from "@/hooks/useFocusTrap";

// ─── Font family options ───────────────────────────────────────────────────
const FONT_FAMILIES: { label: string; value: string }[] = [
	{ label: "Default", value: "system-ui, sans-serif" },
	{ label: "Sans-serif", value: "Arial, Helvetica, sans-serif" },
	{ label: "Serif", value: "Georgia, 'Times New Roman', serif" },
	{ label: "Monospace", value: "'Courier New', Courier, monospace" },
];

// ─── Props ─────────────────────────────────────────────────────────────────
interface SubtitlePickerProps {
	imdbId: string;
	season?: number;
	episode?: number;
	onClose: () => void;
	onSubtitleSelected?: (
		fileId: number | null,
		cues?: SubtitleCue[],
		entry?: SubtitleEntry | null,
		rankInLanguage?: number
	) => void;
	// State from VideoPlayer (persists across remounts)
	currentSelectedId?: number | null;
	currentSelectedEntry?: SubtitleEntry | null;
	subtitleFontSize?: number;
	subtitleFontFamily?: string;
	subtitleDelay?: number;
	onFontSizeChange?: (size: number) => void;
	onFontFamilyChange?: (family: string) => void;
	onDelayChange?: (delay: number) => void;
	onSettingsModeChange?: (active: boolean) => void;
}

export const SubtitlePicker = ({
	imdbId,
	season,
	episode,
	onClose,
	onSubtitleSelected,
	currentSelectedId = null,
	currentSelectedEntry = null,
	subtitleFontSize = 18,
	subtitleFontFamily = "system-ui, sans-serif",
	subtitleDelay = 0,
	onFontSizeChange,
	onFontFamilyChange,
	onDelayChange,
	onSettingsModeChange,
}: SubtitlePickerProps) => {
	// ── Local UI state ──────────────────────────────────────────────────────
	const [loading, setLoading] = useState(true);
	const [result, setResult] = useState<SubtitleSearchResult | null>(null);
	// Initialise selectedFileId from the prop so checkmark is correct on reopen
	const [selectedFileId, setSelectedFileId] = useState<number | null>(currentSelectedId);
	const [downloadingId, setDownloadingId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showSettings, setShowSettings] = useState(false);
	const [delayHovered, setDelayHovered] = useState(false);

	// ── Refs ────────────────────────────────────────────────────────────────
	const pickerRef = useRef<HTMLDivElement>(null);
	const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const holdStartRef = useRef<number>(0);
	const holdDirectionRef = useRef<1 | -1>(1);
	// The hold timer outlives the render that started it, so it reads the delay
	// from here. Each step writes an absolute value, so a stale one would repeat.
	const delayRef = useRef(subtitleDelay);
	useEffect(() => {
		delayRef.current = subtitleDelay;
	}, [subtitleDelay]);

	// ── Click-outside to close ──────────────────────────────────────────────
	useEffect(() => {
		const handleMouseDown = (e: MouseEvent) => {
			if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [onClose]);

	// ── Notify parent when settings pane opens/closes ──────────────────────
	useEffect(() => {
		onSettingsModeChange?.(showSettings);
	}, [showSettings, onSettingsModeChange]);

	// ── Arrow keys ←/→ for delay when delay row is hovered ─────────────────
	useEffect(() => {
		if (!delayHovered) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
			// A modal open over the picker, such as a confirm, keeps its keys.
			if (hasOpenFocusTrap()) return;
			e.preventDefault();
			e.stopPropagation();
			const delta = e.key === "ArrowRight" ? 0.1 : -0.1;
			onDelayChange?.(Math.round((subtitleDelay + delta) * 10) / 10);
		};
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [delayHovered, subtitleDelay, onDelayChange]);

	// ── Stop a hold the buttons never hear end ──────────────────────────────
	// A release outside the window, or switching apps mid-hold, sends the button
	// no mouseup, so the window's mouseup and blur end the hold too.
	useEffect(() => {
		window.addEventListener("mouseup", clearHoldTimer);
		window.addEventListener("blur", clearHoldTimer);
		return () => {
			window.removeEventListener("mouseup", clearHoldTimer);
			window.removeEventListener("blur", clearHoldTimer);
			clearHoldTimer();
		};
	}, []);

	// ── Search on mount ─────────────────────────────────────────────────────
	useEffect(() => {
		searchSubtitles(imdbId, season, episode)
			.then(setResult)
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [imdbId, season, episode]);

	// ── Group entries by language ────────────────────────────────────────────
	const grouped = (result?.languages ?? []).map((lang) => ({
		lang,
		entries: result?.entries?.filter((e) => e.languageCode === lang) ?? [],
	}));

	// ─── Subtitle selection ─────────────────────────────────────────────────
	const handleSelect = async (entry: SubtitleEntry) => {
		if (downloadingId !== null) return;
		setDownloadingId(entry.fileId);
		setError(null);
		try {
			await mpvSubRemove(-1).catch(() => {});
			const localPath = await downloadSubtitle(entry.fileId);
			mpvSubAdd(localPath).catch(() => {});
			const content = await readSubtitleFile(localPath);
			const cues = parseSrt(content);
			setSelectedFileId(entry.fileId);
			// Compute rank within this language group for auto-selection on next episode.
			const langGroup = grouped.find((g) => g.lang === entry.languageCode);
			const rankInLanguage =
				langGroup?.entries.findIndex((e) => e.fileId === entry.fileId) ?? 0;
			onSubtitleSelected?.(entry.fileId, cues, entry, rankInLanguage);
			onClose();
		} catch (e) {
			console.error("[SubtitlePicker] subtitle load error:", e);
			setError("Failed to load subtitle. Try another.");
		} finally {
			setDownloadingId(null);
		}
	};

	const handleNone = async () => {
		await mpvSubRemove(-1).catch(() => {});
		setSelectedFileId(null);
		onSubtitleSelected?.(null, [], null, undefined);
	};

	// ─── Hold-to-accelerate delay buttons ──────────────────────────────────
	const clearHoldTimer = () => {
		if (holdTimerRef.current !== null) {
			clearTimeout(holdTimerRef.current);
			holdTimerRef.current = null;
		}
	};

	const stepDelay = (delta: number) => {
		const next = Math.round((delayRef.current + delta) * 10) / 10;
		delayRef.current = next;
		onDelayChange?.(next);
	};

	const scheduleNextStep = () => {
		const elapsed = Date.now() - holdStartRef.current;
		const step = getDelayStep(elapsed);
		const interval = getDelayInterval(elapsed);
		holdTimerRef.current = setTimeout(() => {
			stepDelay(holdDirectionRef.current * step);
			scheduleNextStep();
		}, interval);
	};

	const startHold = (direction: 1 | -1) => (e: React.MouseEvent) => {
		// Only the main button holds. A right click opens the menu and never sends mouseup.
		if (e.button !== 0) return;
		clearHoldTimer();
		holdDirectionRef.current = direction;
		holdStartRef.current = Date.now();
		stepDelay(direction * getDelayStep(0));
		scheduleNextStep();
	};

	const stopHold = () => clearHoldTimer();

	// A mouse press already stepped in startHold. A click with no pointer press
	// behind it comes from Enter, Space or a screen reader, so step once here.
	const stepOnKeyboardClick = (direction: 1 | -1) => (e: React.MouseEvent) => {
		if (e.detail === 0) stepDelay(direction * getDelayStep(0));
	};

	// ─── Helpers ────────────────────────────────────────────────────────────
	const formatDelay = (d: number) => {
		if (d === 0) return "0.0s";
		return d > 0 ? `+${d.toFixed(1)}s` : `${d.toFixed(1)}s`;
	};

	const panelClass =
		"rounded-xl bg-black/90 backdrop-blur-sm border border-white/10 shadow-2xl text-white text-sm";

	// ─── Render ─────────────────────────────────────────────────────────────
	return (
		// Outer wrapper anchors both panels; pickerRef covers the whole area for click-outside.
		<div ref={pickerRef} className="absolute bottom-20 right-4 z-50 flex items-end gap-2">
			{/* ── Settings panel (floats to the left of the list) ── */}
			{showSettings && (
				<div className={cn(panelClass, "w-64 max-h-[60vh] overflow-y-auto")}>
					<div className="flex items-center justify-between px-3 py-2.5 border-b border-white/10 sticky top-0 bg-black/90 backdrop-blur-sm">
						<span className="font-semibold text-xs tracking-wide uppercase text-white/70">
							Subtitle Settings
						</span>
						<button
							onClick={() => setShowSettings(false)}
							className="p-1 rounded text-white/50 hover:text-white hover:bg-white/10"
							aria-label="Close settings"
						>
							<ArrowLeft className="h-4 w-4" />
						</button>
					</div>

					<div className="px-3 py-3 space-y-4">
						{/* Font */}
						<div className="space-y-2">
							<div className="text-[10px] uppercase tracking-wide text-white/40 font-medium">
								Font
							</div>
							<select
								value={subtitleFontFamily}
								onChange={(e) => onFontFamilyChange?.(e.target.value)}
								className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-white/30"
							>
								{FONT_FAMILIES.map((f) => (
									<option key={f.value} value={f.value} className="bg-black">
										{f.label}
									</option>
								))}
							</select>
							<div className="flex items-center justify-between">
								<span className="text-[10px] text-white/40">Size</span>
								<div className="flex items-center gap-2">
									<button
										onClick={() =>
											onFontSizeChange?.(Math.max(12, subtitleFontSize - 2))
										}
										className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white text-xs font-bold"
										aria-label="Smaller subtitles"
									>
										A−
									</button>
									<span className="text-white/60 text-xs w-10 text-center">
										{subtitleFontSize}px
									</span>
									<button
										onClick={() =>
											onFontSizeChange?.(Math.min(40, subtitleFontSize + 2))
										}
										className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white text-sm font-bold"
										aria-label="Larger subtitles"
									>
										A+
									</button>
								</div>
							</div>
						</div>

						{/* Delay */}
						<div
							className="space-y-1.5"
							onMouseEnter={() => setDelayHovered(true)}
							onMouseLeave={() => setDelayHovered(false)}
						>
							<div className="text-[10px] uppercase tracking-wide text-white/40 font-medium">
								Delay
							</div>
							<div className="flex items-center gap-2">
								<button
									className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-xs select-none"
									onMouseDown={startHold(-1)}
									onMouseUp={stopHold}
									onMouseLeave={stopHold}
									onClick={stepOnKeyboardClick(-1)}
									aria-label="Decrease subtitle delay"
								>
									−
								</button>
								<span className="flex-1 text-center text-white/80 text-xs tabular-nums">
									{formatDelay(subtitleDelay)}
								</span>
								<button
									className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-xs select-none"
									onMouseDown={startHold(1)}
									onMouseUp={stopHold}
									onMouseLeave={stopHold}
									onClick={stepOnKeyboardClick(1)}
									aria-label="Increase subtitle delay"
								>
									+
								</button>
							</div>
							<p className="text-[10px] text-white/30">
								Hold for faster · ←/→ keys for ±0.1s
							</p>
						</div>

						{/* Position */}
						<div className="space-y-1">
							<div className="text-[10px] uppercase tracking-wide text-white/40 font-medium">
								Position
							</div>
							<p className="text-[10px] text-white/40 leading-relaxed">
								Drag the subtitle text on screen, or use ↑ ↓ ← → arrow keys to
								reposition.
							</p>
						</div>
					</div>
				</div>
			)}

			{/* ── Main subtitle list panel ── */}
			<div className={cn(panelClass, "w-80 max-h-[60vh] overflow-y-auto")}>
				{/* Header */}
				<div className="flex items-center justify-between px-3 py-2.5 border-b border-white/10 sticky top-0 bg-black/90 backdrop-blur-sm z-10">
					<span className="font-semibold text-xs tracking-wide uppercase text-white/70">
						Subtitles
					</span>
					<div className="flex items-center gap-1">
						<button
							onClick={() => setShowSettings((v) => !v)}
							className={cn(
								"p-1 rounded text-white/50 hover:text-white hover:bg-white/10",
								showSettings && "text-white bg-white/10"
							)}
							aria-label="Subtitle settings"
						>
							<Settings className="h-4 w-4" />
						</button>
						<button
							onClick={onClose}
							className="p-1 rounded text-white/50 hover:text-white hover:bg-white/10"
							aria-label="Close"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				</div>

				{/* Search loading */}
				{loading && (
					<div className="flex items-center gap-2 p-3 text-white/60">
						<Loader2 className="h-4 w-4 animate-spin" />
						<span>Searching…</span>
					</div>
				)}

				{!loading && !result?.entries.length && (
					<div className="p-3 text-white/50 text-xs">No subtitles found</div>
				)}

				{/* Subtitle list */}
				{!loading && result && result.entries.length > 0 && (
					<div className="p-1">
						{/* Pinned active subtitle (at very top) */}
						{selectedFileId !== null && currentSelectedEntry && (
							<div className="mb-1">
								<div className="px-3 py-1 text-[10px] uppercase tracking-wide text-white/40 font-medium">
									Active
								</div>
								<div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-xs">
									<Check className="h-3 w-3 shrink-0 text-blue-400" />
									<span className="truncate text-white font-medium">
										{currentSelectedEntry.releaseName ??
											`Subtitle ${currentSelectedEntry.fileId}`}
									</span>
									<span className="text-white/30 shrink-0 ml-auto">
										{currentSelectedEntry.languageCode}
									</span>
								</div>
							</div>
						)}

						{/* None option */}
						<button
							onClick={handleNone}
							className={cn(
								"w-full text-left px-3 py-1.5 rounded-lg text-xs hover:bg-white/10 flex items-center gap-1.5",
								selectedFileId === null && "text-white font-medium"
							)}
						>
							{selectedFileId === null ? (
								<Check className="h-3 w-3 shrink-0" />
							) : (
								<span className="w-3 shrink-0" />
							)}
							None
						</button>

						{/* Language-grouped entries */}
						{grouped.map(({ lang, entries }) => (
							<div key={lang}>
								<div className="px-3 py-1 text-[10px] uppercase tracking-wide text-white/40 font-medium mt-1">
									{lang} ({entries.length})
								</div>
								{entries.map((entry) => (
									<button
										key={entry.fileId}
										onClick={() => handleSelect(entry)}
										disabled={downloadingId !== null}
										className="w-full text-left px-3 py-1.5 rounded-lg text-xs hover:bg-white/10 disabled:opacity-50 flex items-center gap-1.5"
									>
										{downloadingId === entry.fileId ? (
											<Loader2 className="h-3 w-3 animate-spin shrink-0" />
										) : selectedFileId === entry.fileId ? (
											<Check className="h-3 w-3 shrink-0 text-blue-400" />
										) : (
											<span className="w-3 shrink-0" />
										)}
										<span className="truncate">
											{entry.releaseName ?? `Subtitle ${entry.fileId}`}
										</span>
										<span className="text-white/30 shrink-0">
											.{entry.format}
										</span>
									</button>
								))}
							</div>
						))}
					</div>
				)}

				{/* Error */}
				{error && (
					<div className="px-3 py-2 text-xs text-red-400 border-t border-white/10">
						{error}
					</div>
				)}
			</div>
		</div>
	);
};
