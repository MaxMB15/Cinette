// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useId, useRef } from "react";
import { openUrl } from "@/lib/openUrl";
import bmcQr from "@/assets/bmc-qr.png";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select } from "@/components/ui/select";
import { usePlatform } from "@/hooks/usePlatform";
import { isMobilePlatform } from "@/lib/platform";
import type { UpdateState } from "@/hooks/useUpdateChecker";
import { getVersion } from "@tauri-apps/api/app";
import { useQueryClient } from "@tanstack/react-query";
import {
	Settings as SettingsIcon,
	CircleCheckBig,
	Download,
	RefreshCw,
	FolderOpen,
} from "lucide-react";
import {
	getOmdbApiKey,
	setOmdbApiKey,
	testOmdbApiKey,
	clearWatchHistory,
	getOpenSubtitlesApiKey,
	setOpenSubtitlesApiKey,
	testOpenSubtitlesApiKey,
	getGeminiApiKey,
	setGeminiApiKey,
	testGeminiApiKey,
	clearAllCaches,
	getDownloadFolder,
	setDownloadFolder,
	getDownloadConcurrency,
	setDownloadConcurrency,
	countDownloadsDue,
} from "@/lib/tauri";
import { historyKey, reloadClearedCaches } from "@/lib/queries";
import { ConfirmDialog } from "@/components/downloads/ConfirmDialog";
import { RemoteControlSettings } from "@/components/settings/RemoteControlSettings";
import { useDownloads } from "@/hooks/useDownloads";
import { RETENTION_OPTIONS } from "@/lib/retention";
import { MARGIN_OPTIONS, readMargins, writeMargins } from "@/lib/recordings";
import {
	MAX_VOLUME,
	SKIP_OPTIONS,
	readDefaultVolume,
	readHwdecEnabled,
	readSkipIntervals,
	readSkipSegmentModes,
	SKIP_INTERVALS_EVENT,
	SKIP_SEGMENT_MODES_EVENT,
	writeDefaultVolume,
	writeHwdecEnabled,
	writeSkipInterval,
	writeSkipSegmentMode,
	type SkipSegmentMode,
} from "@/lib/player-prefs";
import { usePlayerPref } from "@/hooks/usePlayerPref";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { useScrollToOmdbKey } from "@/hooks/useScrollToOmdbKey";
import { rememberHasOmdbKey } from "@/hooks/useHasOmdbKey";
import { useApiKey, type ApiKeyService } from "@/hooks/useApiKey";
import { DONATION_LAST_SHOWN_KEY, removeStorage } from "@/lib/storage";
import { ApiKeyField } from "./ApiKeyField";
import { LegalNotices } from "./LegalNotices";
import { DownloadHistoryDialog } from "./DownloadHistory";

type SaveStatus = "idle" | "saved" | "error";
type HistoryStatus = "idle" | "cleared";

const SKIP_CHOICES = SKIP_OPTIONS.map((n) => ({ value: n, label: `${n} seconds` }));

const SKIP_SEGMENT_CHOICES: { value: SkipSegmentMode; label: string }[] = [
	{ value: "button", label: "Skip button" },
	{ value: "auto", label: "Automatic" },
	{ value: "off", label: "Off" },
];

const SKIPDB_URL = "https://skipdb.tv";
const INTRODB_URL = "https://introdb.app";

const GEMINI_KEY: ApiKeyService = {
	load: getGeminiApiKey,
	save: setGeminiApiKey,
	test: testGeminiApiKey,
};

const OMDB_KEY: ApiKeyService = {
	load: getOmdbApiKey,
	save: setOmdbApiKey,
	test: testOmdbApiKey,
	// Info sheets check this before they offer to open Settings for a key.
	onSaved: (key) => rememberHasOmdbKey(Boolean(key)),
};

const OPENSUBTITLES_KEY: ApiKeyService = {
	load: getOpenSubtitlesApiKey,
	save: setOpenSubtitlesApiKey,
	test: testOpenSubtitlesApiKey,
};

/** How many downloads can run at once. */
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;

/** The number typed, rounded and kept from 1 to 10, or null when the field holds no number. */
const parseConcurrency = (text: string): number | null => {
	const n = Number.parseFloat(text);
	if (Number.isNaN(n)) return null;
	return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.round(n)));
};

const DonationReset = () => {
	const [reset, setReset] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		},
		[]
	);
	const handleReset = () => {
		removeStorage(DONATION_LAST_SHOWN_KEY);
		setReset(true);
		timerRef.current = setTimeout(() => setReset(false), 2000);
	};
	return (
		<Button size="sm" variant="secondary" onClick={handleReset} disabled={reset}>
			{reset ? (
				<span className="flex items-center gap-1 text-green-500">
					<CircleCheckBig className="h-4 w-4" /> Reset
				</span>
			) : (
				"Reset donation reminder"
			)}
		</Button>
	);
};

interface SettingsProps {
	updateState: UpdateState;
}

export const Settings = ({ updateState }: SettingsProps) => {
	const { platform } = usePlatform();
	const queryClient = useQueryClient();
	const [appVersion, setAppVersion] = useState("");
	const [hwAccel, setHwAccel] = useState(readHwdecEnabled);
	const [defaultVolume, setDefaultVolume] = useState(readDefaultVolume);

	const handleHwAccelToggle = () => {
		const next = !hwAccel;
		setHwAccel(next);
		writeHwdecEnabled(next);
	};

	const handleDefaultVolumeChange = (volume: number) => {
		setDefaultVolume(volume);
		writeDefaultVolume(volume);
	};

	const skipIntervals = usePlayerPref(readSkipIntervals, SKIP_INTERVALS_EVENT);
	const segmentModes = usePlayerPref(readSkipSegmentModes, SKIP_SEGMENT_MODES_EVENT);

	const geminiKey = useApiKey(GEMINI_KEY);
	const omdbKey = useApiKey(OMDB_KEY);
	const openSubtitlesKey = useApiKey(OPENSUBTITLES_KEY);
	// The services under OMDb look titles up by the IMDb ID it finds, so they
	// show once either key is saved. They then stay until Settings closes, so
	// removing a key doesn't take its field away from under the pointer.
	const [showOmdbServices, setShowOmdbServices] = useState(false);
	if (!showOmdbServices && (omdbKey.saved || openSubtitlesKey.saved)) setShowOmdbServices(true);
	const omdbKeyInputRef = useRef<HTMLInputElement>(null);
	// The OMDb hint in an info sheet opens Settings at the key field.
	useScrollToOmdbKey(omdbKeyInputRef);

	// History state
	const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("idle");
	const [historyError, setHistoryError] = useState<string | null>(null);
	const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cache state
	const [cacheStatus, setCacheStatus] = useState<HistoryStatus>("idle");
	const [cacheError, setCacheError] = useState<string | null>(null);
	const cacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Downloads state
	const [downloadFolder, setDownloadFolderState] = useState("");
	const [folderInput, setFolderInput] = useState("");
	const [folderStatus, setFolderStatus] = useState<SaveStatus>("idle");
	const [concurrency, setConcurrency] = useState(3);
	// What's in the field, which can be blank or out of range while it's edited.
	const [concurrencyText, setConcurrencyText] = useState("3");
	const concurrencyId = useId();
	const concurrencyHintId = useId();
	// Saves go one at a time. Typing 10 saves 1 on the way, and two saves at
	// once could land in either order and leave 1 behind.
	const concurrencySaves = useRef<Promise<void>>(Promise.resolve());
	const [showDownloadHistory, setShowDownloadHistory] = useState(false);
	const folderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const { retentionDays, setRetentionDays } = useDownloads();
	const [margins, setMargins] = useState(readMargins);
	/**
	 * A shorter retention that would delete downloads at once, waiting on a
	 * yes. `count` is null when counting failed.
	 */
	const [pendingRetention, setPendingRetention] = useState<{
		days: number | null;
		count: number | null;
	} | null>(null);

	useEffect(() => {
		getVersion()
			.then(setAppVersion)
			.catch(() => {});
	}, []);

	useEffect(() => {
		getDownloadFolder()
			.then((p) => {
				setDownloadFolderState(p);
				setFolderInput(p);
			})
			.catch(() => {});
		getDownloadConcurrency()
			.then((n) => {
				setConcurrency(n);
				setConcurrencyText(String(n));
			})
			.catch(() => {});
		return () => {
			if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
			if (cacheTimerRef.current) clearTimeout(cacheTimerRef.current);
			if (folderTimerRef.current) clearTimeout(folderTimerRef.current);
		};
	}, []);

	// The mobile apps have no downloads, and App Store rules don't allow a
	// donation link.
	const mobile = isMobilePlatform(platform);

	const handleClearHistory = async () => {
		const confirmed = await ask(
			"Are you sure you want to clear all watch history? This cannot be undone.",
			{ title: "Clear History", kind: "warning" }
		);
		if (!confirmed) return;
		try {
			await clearWatchHistory();
			// The history lists start over, rather than show the cleared
			// entries until they load again.
			queryClient.removeQueries({ queryKey: historyKey() });
			setHistoryStatus("cleared");
			setHistoryError(null);
			if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
			historyTimerRef.current = setTimeout(() => setHistoryStatus("idle"), 2000);
		} catch {
			setHistoryError("Failed to clear history. Please try again.");
		}
	};

	const handleClearCaches = async () => {
		const confirmed = await ask(
			"Clear cached movie and series details, guide data, episode lists and downloaded subtitles? This cannot be undone.",
			{ title: "Clear Caches", kind: "warning" }
		);
		if (!confirmed) return;
		try {
			await clearAllCaches();
			reloadClearedCaches(queryClient).catch(() => {});
			setCacheStatus("cleared");
			setCacheError(null);
			if (cacheTimerRef.current) clearTimeout(cacheTimerRef.current);
			cacheTimerRef.current = setTimeout(() => setCacheStatus("idle"), 2000);
		} catch {
			setCacheError("Failed to clear caches. Please try again.");
		}
	};

	const applyFolder = async (path: string) => {
		const trimmed = path.trim();
		if (!trimmed) return;
		try {
			await setDownloadFolder(trimmed);
			setDownloadFolderState(trimmed);
			setFolderInput(trimmed);
			setFolderStatus("saved");
			if (folderTimerRef.current) clearTimeout(folderTimerRef.current);
			folderTimerRef.current = setTimeout(() => setFolderStatus("idle"), 2000);
		} catch {
			setFolderStatus("error");
			if (folderTimerRef.current) clearTimeout(folderTimerRef.current);
			folderTimerRef.current = setTimeout(() => setFolderStatus("idle"), 3000);
		}
	};

	const handleBrowseFolder = async () => {
		// Outside the try, which the React Compiler can't compile with a || in it.
		const defaultPath = downloadFolder || undefined;
		try {
			const selected = await open({ directory: true, defaultPath });
			if (typeof selected === "string") {
				await applyFolder(selected);
			}
		} catch {
			// Dialog unavailable — the text input below remains the fallback.
		}
	};

	const applyConcurrency = (n: number) => {
		setConcurrencyText(String(n));
		if (n === concurrency) return;
		setConcurrency(n);
		concurrencySaves.current = concurrencySaves.current
			.then(() => setDownloadConcurrency(n))
			.catch(() => {});
	};

	const handleMarginChange = (side: "before" | "after", minutes: number) => {
		const next = { ...margins, [side]: minutes };
		setMargins(next);
		writeMargins(next);
	};

	/**
	 * A number in range applies as it's typed. Anything else waits for the
	 * field to lose focus or for Enter, so clearing the field to type a new
	 * number doesn't snap it to 1 first.
	 */
	const handleConcurrencyInput = (text: string) => {
		setConcurrencyText(text);
		// A blank field reads as 0, which is out of range.
		const n = Number(text);
		if (Number.isInteger(n) && n >= MIN_CONCURRENCY && n <= MAX_CONCURRENCY) {
			applyConcurrency(n);
		}
	};

	/** Clamps what was typed, or puts the last setting back when it isn't a number. */
	const commitConcurrency = () =>
		applyConcurrency(parseConcurrency(concurrencyText) ?? concurrency);

	/** `value` is a choice from RETENTION_OPTIONS, where 0 means never delete. */
	const handleRetentionChange = async (value: number) => {
		const days = value > 0 ? value : null;
		if (days === retentionDays) return;
		// When counting fails, ask anyway rather than delete without asking.
		const count = days === null ? 0 : await countDownloadsDue(days).catch(() => null);
		if (count === 0) setRetentionDays(days).catch(() => {});
		else setPendingRetention({ days, count });
	};

	return (
		<div className="h-full overflow-y-auto">
			<div className="flex flex-col gap-6 p-4 max-w-2xl mx-auto">
				<div className="flex items-center gap-3">
					<SettingsIcon className="h-6 w-6 text-primary" />
					<h1 className="text-2xl font-bold">Settings</h1>
				</div>

				<Card>
					<CardHeader>
						<CardTitle className="text-base">Playback</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm font-medium">Hardware decoding</p>
								<p className="text-xs text-muted-foreground">
									Decode video on the GPU when possible. Turn off if video shows
									artifacts or green frames. Applies to the next video you play.
								</p>
							</div>
							<Button
								variant={hwAccel ? "default" : "secondary"}
								size="sm"
								aria-label="Hardware decoding"
								aria-pressed={hwAccel}
								onClick={handleHwAccelToggle}
							>
								{hwAccel ? "On" : "Off"}
							</Button>
						</div>

						<div>
							<div className="flex items-center justify-between mb-2">
								<p className="text-sm font-medium">Default volume</p>
								<span className="text-sm text-muted-foreground">
									{defaultVolume}%
								</span>
							</div>
							<Slider
								value={defaultVolume}
								min={0}
								max={MAX_VOLUME}
								step={5}
								onValueChange={handleDefaultVolumeChange}
								aria-label="Default volume"
								aria-valuetext={`${defaultVolume}%`}
							/>
							<p className="text-xs text-muted-foreground mt-2">
								Playback starts at this volume. Changes you make in the player last
								until you quit the app.
							</p>
						</div>

						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="text-sm font-medium">Skip back</p>
								<p className="text-xs text-muted-foreground">
									How far the skip back button, a double-tap on the left of the
									video and the left arrow key go back.
								</p>
							</div>
							<Select
								value={skipIntervals.back}
								onChange={(n) => writeSkipInterval("back", n)}
								options={SKIP_CHOICES}
								className="w-32 shrink-0"
								aria-label="Skip back"
							/>
						</div>

						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="text-sm font-medium">Skip forward</p>
								<p className="text-xs text-muted-foreground">
									How far the skip forward button, a double-tap on the right of
									the video and the right arrow key go forward.
								</p>
							</div>
							<Select
								value={skipIntervals.forward}
								onChange={(n) => writeSkipInterval("forward", n)}
								options={SKIP_CHOICES}
								className="w-32 shrink-0"
								aria-label="Skip forward"
							/>
						</div>

						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="text-sm font-medium">Intros and recaps</p>
								<p className="text-xs text-muted-foreground">
									Show a Skip button while one plays, or skip it automatically
									with a way to undo.
								</p>
							</div>
							<Select
								value={segmentModes.opening}
								onChange={(mode) => writeSkipSegmentMode("opening", mode)}
								options={SKIP_SEGMENT_CHOICES}
								className="w-36 shrink-0"
								aria-label="Intros and recaps"
							/>
						</div>

						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="text-sm font-medium">Credits and previews</p>
								<p className="text-xs text-muted-foreground">
									At end credits, Automatic counts down to the next episode while
									Autoplay is on in the player's controls.
								</p>
							</div>
							<Select
								value={segmentModes.ending}
								onChange={(mode) => writeSkipSegmentMode("ending", mode)}
								options={SKIP_SEGMENT_CHOICES}
								className="w-36 shrink-0"
								aria-label="Credits and previews"
							/>
						</div>

						<p className="text-xs text-muted-foreground">
							Skip times need an OMDb key under Integrations, and only some movies and
							series have them. They come from{" "}
							<button
								type="button"
								onClick={() => openUrl(SKIPDB_URL)}
								className="text-primary hover:underline"
							>
								SkipDB
							</button>
							, under the ODbL 1.0, and from{" "}
							<button
								type="button"
								onClick={() => openUrl(INTRODB_URL)}
								className="text-primary hover:underline"
							>
								IntroDB
							</button>
							. People add the times by hand, so a few may be off. When the player
							can't be sure they fit the video, Automatic shows the button instead.
						</p>
					</CardContent>
				</Card>

				{/* AI section */}
				<Card>
					<CardHeader>
						<CardTitle className="text-base">AI</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<ApiKeyField
							name="Gemini"
							description="Sorts channels into categories for you. When you use an AI action in Manage Categories, the app sends your group and category names, and a few channel, movie or series names from each group, to Google Gemini."
							field={geminiKey}
							placeholder="Enter Gemini API key…"
							getKey={{
								url: "https://aistudio.google.com/apikey",
								text: "Get a key at aistudio.google.com",
							}}
						/>
					</CardContent>
				</Card>

				{/* Integrations section */}
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Integrations</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<ApiKeyField
							name="OMDb"
							description="Adds details and ratings to movies and series. With a key set, the app sends titles to OMDb, and IMDb IDs to whatson-api for more ratings and to SkipDB and IntroDB for skip times."
							field={omdbKey}
							placeholder="Enter OMDb API key…"
							getKey={{
								url: "https://www.omdbapi.com/apikey.aspx",
								text: "Get a free key at omdbapi.com",
							}}
							validNote="Free keys allow 1,000 calls a day."
							inputRef={omdbKeyInputRef}
						/>

						{showOmdbServices && (
							<div className="border-t border-border pt-4 space-y-4">
								<p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
									Uses your OMDb key
								</p>
								<ApiKeyField
									name="OpenSubtitles"
									description="Finds subtitles for movies and episodes in the player. The app sends their IMDb IDs to OpenSubtitles."
									field={openSubtitlesKey}
									placeholder="Enter OpenSubtitles API key…"
									getKey={{
										url: "https://www.opensubtitles.com/consumers",
										text: "Get a key at opensubtitles.com",
									}}
								/>
							</div>
						)}
					</CardContent>
				</Card>

				{/* Downloads section */}
				{!mobile && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">Downloads</CardTitle>
						</CardHeader>
						<CardContent className="space-y-5">
							{/* Folder */}
							<div>
								<p className="text-sm font-medium mb-1">Download folder</p>
								<p className="text-xs text-muted-foreground mb-2">
									Where movies and series episodes are saved.
								</p>
								<div className="flex items-center gap-2">
									<Input
										value={folderInput}
										placeholder="/path/to/downloads"
										onChange={(e) => {
											setFolderInput(e.target.value);
											setFolderStatus("idle");
										}}
									/>
									<Button
										size="sm"
										variant="outline"
										onClick={handleBrowseFolder}
										aria-label="Browse for folder"
									>
										<FolderOpen className="h-4 w-4" />
									</Button>
									<Button
										size="sm"
										variant="secondary"
										onClick={() => applyFolder(folderInput)}
										disabled={
											!folderInput.trim() ||
											folderInput.trim() === downloadFolder
										}
									>
										{folderStatus === "saved" ? (
											<span className="flex items-center gap-1 text-green-500">
												<CircleCheckBig className="h-4 w-4" /> Saved
											</span>
										) : folderStatus === "error" ? (
											<span className="text-destructive">Failed</span>
										) : (
											"Save"
										)}
									</Button>
								</div>
							</div>

							{/* Concurrency */}
							<div>
								<label
									htmlFor={concurrencyId}
									className="mb-1 block text-sm font-medium"
								>
									Simultaneous downloads
								</label>
								<p
									id={concurrencyHintId}
									className="text-xs text-muted-foreground mb-2"
								>
									How many downloads run at once, from 1 to 10.
								</p>
								<Input
									id={concurrencyId}
									type="number"
									inputMode="numeric"
									min={MIN_CONCURRENCY}
									max={MAX_CONCURRENCY}
									step={1}
									value={concurrencyText}
									onChange={(e) => handleConcurrencyInput(e.target.value)}
									onBlur={commitConcurrency}
									onKeyDown={(e) => {
										if (e.key === "Enter") commitConcurrency();
									}}
									aria-describedby={concurrencyHintId}
									className="w-24"
								/>
							</div>

							{/* Retention */}
							<div>
								<p className="text-sm font-medium mb-1">Delete downloads after</p>
								<p className="text-xs text-muted-foreground mb-2">
									The app deletes a finished download this long after it was
									downloaded or last played. Choose Keep on a download to hold on
									to it.
								</p>
								<Select
									value={retentionDays ?? 0}
									onChange={(v) => void handleRetentionChange(v)}
									options={RETENTION_OPTIONS}
									aria-label="Delete downloads after"
									className="w-40"
								/>
							</div>

							{/* Recording margins */}
							<div>
								<p className="text-sm font-medium mb-1">Recording margins</p>
								<p className="text-xs text-muted-foreground mb-2">
									A program you record from the guide starts early and runs over
									by these amounts, in case the guide's times are off.
								</p>
								<div className="flex flex-wrap gap-4">
									<div className="text-xs text-muted-foreground">
										<p className="mb-1">Start early by</p>
										<Select
											value={margins.before}
											onChange={(v) => handleMarginChange("before", v)}
											options={MARGIN_OPTIONS}
											aria-label="Start recordings early by"
											className="w-36"
										/>
									</div>
									<div className="text-xs text-muted-foreground">
										<p className="mb-1">Run over by</p>
										<Select
											value={margins.after}
											onChange={(v) => handleMarginChange("after", v)}
											options={MARGIN_OPTIONS}
											aria-label="Run recordings over by"
											className="w-36"
										/>
									</div>
								</div>
							</div>

							{/* History — opened in a wide popup (Settings is too narrow). */}
							<div>
								<p className="text-sm font-medium mb-2">Download history</p>
								<Button
									size="sm"
									variant="secondary"
									onClick={() => setShowDownloadHistory(true)}
								>
									<Download className="h-4 w-4 mr-1.5" />
									View download history
								</Button>
							</div>
						</CardContent>
					</Card>
				)}

				<RemoteControlSettings />

				{/* History section */}
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Watch History</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							<div className="flex items-center gap-4">
								<Button
									variant="destructive"
									size="sm"
									onClick={handleClearHistory}
								>
									Clear All History…
								</Button>
								{historyStatus === "cleared" && (
									<span className="flex items-center gap-1 text-xs text-green-500">
										<CircleCheckBig className="h-3 w-3" /> History cleared
									</span>
								)}
							</div>
							{historyError && (
								<p className="text-xs text-destructive">{historyError}</p>
							)}
						</div>
					</CardContent>
				</Card>

				{/* Cache section */}
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Cache</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							<p className="text-xs text-muted-foreground">
								Clears cached movie and series details, guide data, episode lists
								and downloaded subtitles. Playlists, favorites, history and settings
								are not affected.
							</p>
							<div className="flex items-center gap-4">
								<Button variant="destructive" size="sm" onClick={handleClearCaches}>
									Clear All Caches…
								</Button>
								{cacheStatus === "cleared" && (
									<span className="flex items-center gap-1 text-xs text-green-500">
										<CircleCheckBig className="h-3 w-3" /> Caches cleared
									</span>
								)}
							</div>
							{cacheError && <p className="text-xs text-destructive">{cacheError}</p>}
						</div>
					</CardContent>
				</Card>

				{!mobile && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">Support</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3">
							<p className="text-sm text-muted-foreground">
								Cinette is free and open source. If you find it useful, consider
								supporting development.
							</p>
							<div className="flex items-center gap-4">
								<button
									type="button"
									onClick={() => openUrl("https://buymeacoffee.com/MaxMB15")}
									className="w-32 shrink-0 rounded-lg overflow-hidden border border-border hover:border-primary transition-colors"
									aria-label="Donate via Buy Me a Coffee"
								>
									<img
										src={bmcQr}
										alt="Buy me a coffee QR code"
										className="w-full h-auto"
									/>
								</button>
								<button
									type="button"
									onClick={() => openUrl("https://buymeacoffee.com/MaxMB15")}
									className="text-sm font-semibold bg-[#5F7FFF] text-white px-5 py-2 rounded-lg hover:opacity-90 transition-opacity"
								>
									Buy me a coffee
								</button>
							</div>
							<div className="pt-1 border-t border-border">
								<p className="text-xs text-muted-foreground mb-2">
									Reset the donation reminder to show it again.
								</p>
								<DonationReset />
							</div>
						</CardContent>
					</Card>
				)}

				<Card>
					<CardHeader>
						<CardTitle className="text-base">About</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<p className="text-sm text-muted-foreground">
							Cinette {appVersion ? `v${appVersion}` : ""}
						</p>

						<LegalNotices version={appVersion || undefined} />

						{updateState.supported && (
							<div className="space-y-3">
								<div className="flex items-center gap-3">
									<Button
										size="sm"
										variant="secondary"
										onClick={() => updateState.checkForUpdates()}
										disabled={updateState.checking}
									>
										{updateState.checking ? (
											<span className="flex items-center gap-1.5">
												<RefreshCw className="h-3 w-3 animate-spin" />
												Checking…
											</span>
										) : (
											"Check for Updates"
										)}
									</Button>
									{/* Always rendered, so screen readers announce the result when it appears. */}
									<span role="status" className="text-xs">
										{!updateState.checking &&
											!updateState.update &&
											(updateState.checkError ? (
												<span
													className="text-destructive"
													title={updateState.checkError}
												>
													Couldn't check for updates.
												</span>
											) : (
												<span className="text-muted-foreground">
													You're up to date.
												</span>
											))}
									</span>
								</div>

								{updateState.update && (
									<div className="rounded-lg bg-primary/10 border border-primary/25 px-4 py-3 space-y-2">
										<p className="text-sm font-semibold text-primary">
											Update available — v{updateState.update.version}
										</p>
										<p className="text-xs text-muted-foreground leading-relaxed">
											{updateState.update.body ??
												"A new version is ready to install."}
										</p>
										{updateState.installing &&
											updateState.progress !== null && (
												<div className="h-1 w-full rounded-full bg-secondary overflow-hidden">
													<div
														className="h-full bg-primary transition-all duration-200"
														style={{
															width: `${updateState.progress}%`,
														}}
													/>
												</div>
											)}
										{updateState.error && (
											<p className="text-xs text-destructive">
												{updateState.error}
											</p>
										)}
										<Button
											size="sm"
											onClick={updateState.install}
											disabled={updateState.installing}
										>
											{updateState.installing ? (
												<span className="flex items-center gap-1.5">
													<RefreshCw className="h-3 w-3 animate-spin" />
													{updateState.progress !== null
														? `Downloading… ${updateState.progress}%`
														: "Installing…"}
												</span>
											) : (
												<span className="flex items-center gap-1.5">
													<Download className="h-3 w-3" />
													Install Update
												</span>
											)}
										</Button>
									</div>
								)}
							</div>
						)}
					</CardContent>
				</Card>
			</div>

			<ConfirmDialog
				open={pendingRetention !== null}
				title="Delete downloads now?"
				message={
					pendingRetention?.count == null
						? "Downloads already past this setting will be deleted now."
						: pendingRetention.count === 1
							? "1 download is already past this setting. It will be deleted now."
							: `${pendingRetention.count} downloads are already past this setting. They will be deleted now.`
				}
				confirmLabel="Delete"
				onConfirm={() => {
					if (pendingRetention) setRetentionDays(pendingRetention.days).catch(() => {});
					setPendingRetention(null);
				}}
				onCancel={() => setPendingRetention(null)}
			/>
			<DownloadHistoryDialog
				open={showDownloadHistory}
				onClose={() => setShowDownloadHistory(false)}
			/>
		</div>
	);
};
