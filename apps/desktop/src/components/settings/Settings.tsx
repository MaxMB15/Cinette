// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useRef } from "react";
import { openUrl } from "@/lib/openUrl";
import bmcQr from "@/assets/bmc-qr.png";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { usePlatform } from "@/hooks/usePlatform";
import { isMobilePlatform, platformName } from "@/lib/platform";
import type { UpdateState } from "@/hooks/useUpdateChecker";
import { getVersion } from "@tauri-apps/api/app";
import {
	Settings as SettingsIcon,
	Monitor,
	Smartphone,
	Tablet,
	Tv,
	Eye,
	EyeOff,
	CheckCircle,
	XCircle,
	Download,
	RefreshCw,
	FolderOpen,
} from "lucide-react";
import {
	getOmdbApiKey,
	setOmdbApiKey,
	fetchOmdbData,
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
} from "@/lib/tauri";
import {
	MAX_VOLUME,
	readDefaultVolume,
	readHwdecEnabled,
	writeDefaultVolume,
	writeHwdecEnabled,
} from "@/lib/player-prefs";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { LegalNotices } from "./LegalNotices";
import { DownloadHistoryDialog } from "./DownloadHistory";

type OmdbStatus = "idle" | "valid" | "invalid";
type SaveStatus = "idle" | "saved" | "error";
type HistoryStatus = "idle" | "cleared";

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
		localStorage.removeItem("donation-last-shown");
		setReset(true);
		timerRef.current = setTimeout(() => setReset(false), 2000);
	};
	return (
		<Button size="sm" variant="secondary" onClick={handleReset} disabled={reset}>
			{reset ? (
				<span className="flex items-center gap-1 text-green-500">
					<CheckCircle className="h-4 w-4" /> Reset
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
	const { platform, layoutMode } = usePlatform();
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

	// OMDB state
	const [omdbKey, setOmdbKey] = useState("");
	const [omdbKeyVisible, setOmdbKeyVisible] = useState(false);
	const [omdbStatus, setOmdbStatus] = useState<OmdbStatus>("idle");
	const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
	const [saveError, setSaveError] = useState<string | null>(null);
	const [omdbTesting, setOmdbTesting] = useState(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// OpenSubtitles state
	const [openSubtitlesKey, setOpenSubtitlesKey] = useState("");
	const [openSubtitlesKeyVisible, setOpenSubtitlesKeyVisible] = useState(false);
	const [openSubtitlesSaveStatus, setOpenSubtitlesSaveStatus] = useState<SaveStatus>("idle");
	const [openSubtitlesTestStatus, setOpenSubtitlesTestStatus] = useState<OmdbStatus>("idle");
	const [openSubtitlesTesting, setOpenSubtitlesTesting] = useState(false);
	const [openSubtitlesSaveError, setOpenSubtitlesSaveError] = useState<string | null>(null);
	const openSubtitlesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Gemini state
	const [geminiKey, setGeminiKey] = useState("");
	const [geminiKeyVisible, setGeminiKeyVisible] = useState(false);
	const [geminiSaveStatus, setGeminiSaveStatus] = useState<SaveStatus>("idle");
	const [geminiTestStatus, setGeminiTestStatus] = useState<OmdbStatus>("idle");
	const [geminiTesting, setGeminiTesting] = useState(false);
	const geminiSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
	const [showDownloadHistory, setShowDownloadHistory] = useState(false);
	const folderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		getVersion()
			.then(setAppVersion)
			.catch(() => {});
	}, []);

	useEffect(() => {
		getOmdbApiKey().then((key) => {
			if (key) setOmdbKey(key);
		});
		getOpenSubtitlesApiKey().then((key) => {
			if (key) setOpenSubtitlesKey(key);
		});
		getGeminiApiKey()
			.then((key) => {
				if (key) setGeminiKey(key);
			})
			.catch(() => {});
		getDownloadFolder()
			.then((p) => {
				setDownloadFolderState(p);
				setFolderInput(p);
			})
			.catch(() => {});
		getDownloadConcurrency()
			.then(setConcurrency)
			.catch(() => {});
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
			if (openSubtitlesSaveTimerRef.current) clearTimeout(openSubtitlesSaveTimerRef.current);
			if (geminiSaveTimerRef.current) clearTimeout(geminiSaveTimerRef.current);
			if (cacheTimerRef.current) clearTimeout(cacheTimerRef.current);
			if (folderTimerRef.current) clearTimeout(folderTimerRef.current);
		};
	}, []);

	const platformIcon = {
		desktop: Monitor,
		tablet: Tablet,
		mobile: Smartphone,
		tv: Tv,
	}[layoutMode];
	const PlatformIcon = platformIcon;
	// The mobile apps have no downloads, and App Store rules don't allow a
	// donation link.
	const mobile = isMobilePlatform(platform);

	const handleSaveOmdbKey = async () => {
		try {
			await setOmdbApiKey(omdbKey);
			setSaveStatus("saved");
			setSaveError(null);
			setOmdbStatus("idle");
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
		} catch {
			setSaveError("Failed to save. Please try again.");
		}
	};

	const handleTestOmdbKey = async () => {
		setOmdbTesting(true);
		setOmdbStatus("idle");
		try {
			const result = await fetchOmdbData("test", "The Matrix", "movie");
			setOmdbStatus(result ? "valid" : "invalid");
		} catch {
			setOmdbStatus("invalid");
		} finally {
			setOmdbTesting(false);
		}
	};

	const handleSaveOpenSubtitlesKey = async () => {
		try {
			await setOpenSubtitlesApiKey(openSubtitlesKey);
			setOpenSubtitlesSaveStatus("saved");
			setOpenSubtitlesSaveError(null);
			setOpenSubtitlesTestStatus("idle");
			if (openSubtitlesSaveTimerRef.current) clearTimeout(openSubtitlesSaveTimerRef.current);
			openSubtitlesSaveTimerRef.current = setTimeout(
				() => setOpenSubtitlesSaveStatus("idle"),
				2000
			);
		} catch {
			setOpenSubtitlesSaveError("Failed to save. Please try again.");
		}
	};

	const handleTestOpenSubtitlesKey = async () => {
		setOpenSubtitlesTesting(true);
		setOpenSubtitlesTestStatus("idle");
		try {
			const valid = await testOpenSubtitlesApiKey(openSubtitlesKey);
			setOpenSubtitlesTestStatus(valid ? "valid" : "invalid");
		} catch {
			setOpenSubtitlesTestStatus("invalid");
		} finally {
			setOpenSubtitlesTesting(false);
		}
	};

	const handleGeminiSave = async () => {
		try {
			await setGeminiApiKey(geminiKey);
			setGeminiSaveStatus("saved");
			setGeminiTestStatus("idle");
			if (geminiSaveTimerRef.current) clearTimeout(geminiSaveTimerRef.current);
			geminiSaveTimerRef.current = setTimeout(() => setGeminiSaveStatus("idle"), 2000);
		} catch {
			setGeminiSaveStatus("error");
			if (geminiSaveTimerRef.current) clearTimeout(geminiSaveTimerRef.current);
			geminiSaveTimerRef.current = setTimeout(() => setGeminiSaveStatus("idle"), 3000);
		}
	};

	const handleGeminiTest = async () => {
		setGeminiTesting(true);
		setGeminiTestStatus("idle");
		try {
			const valid = await testGeminiApiKey(geminiKey);
			setGeminiTestStatus(valid ? "valid" : "invalid");
		} catch {
			setGeminiTestStatus("invalid");
		} finally {
			setGeminiTesting(false);
		}
	};

	const handleClearHistory = async () => {
		const confirmed = await ask(
			"Are you sure you want to clear all watch history? This cannot be undone.",
			{ title: "Clear History", kind: "warning" }
		);
		if (!confirmed) return;
		try {
			await clearWatchHistory();
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
			"Clear all cached data (OMDB, MDBList, OpenSubtitles, EPG)? This cannot be undone.",
			{ title: "Clear Caches", kind: "warning" }
		);
		if (!confirmed) return;
		try {
			await clearAllCaches();
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
		try {
			const selected = await open({
				directory: true,
				defaultPath: downloadFolder || undefined,
			});
			if (typeof selected === "string") {
				await applyFolder(selected);
			}
		} catch {
			// Dialog unavailable — the text input below remains the fallback.
		}
	};

	const handleConcurrencyChange = (n: number) => {
		const clamped = Math.max(1, Math.min(10, Math.round(n)));
		setConcurrency(clamped);
		setDownloadConcurrency(clamped).catch(() => {});
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
						<CardTitle className="text-base">Platform</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex items-center gap-3">
							<PlatformIcon className="h-5 w-5 text-muted-foreground" />
							<div>
								<p className="text-sm font-medium">{platformName(platform)}</p>
								<p className="text-xs text-muted-foreground">
									Layout: {layoutMode}
								</p>
							</div>
						</div>
					</CardContent>
				</Card>

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
							/>
							<p className="text-xs text-muted-foreground mt-2">
								Playback starts at this volume. Changes you make in the player last
								until you quit the app.
							</p>
						</div>
					</CardContent>
				</Card>

				{/* AI section */}
				<Card>
					<CardHeader>
						<CardTitle className="text-base">AI</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div>
							<p className="text-sm font-medium mb-1">Gemini API Key</p>
							<p className="text-xs text-muted-foreground mb-2">
								Used for automatic channel categorization
							</p>
							<div className="flex items-center gap-2">
								<div className="relative flex-1">
									<Input
										type={geminiKeyVisible ? "text" : "password"}
										placeholder="Enter Gemini API key…"
										value={geminiKey}
										onChange={(e) => {
											setGeminiKey(e.target.value);
											setGeminiTestStatus("idle");
											setGeminiSaveStatus("idle");
										}}
										className="pr-10"
									/>
									<button
										type="button"
										className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
										onClick={() => setGeminiKeyVisible((v) => !v)}
										aria-label={geminiKeyVisible ? "Hide key" : "Show key"}
									>
										{geminiKeyVisible ? (
											<EyeOff className="h-4 w-4" />
										) : (
											<Eye className="h-4 w-4" />
										)}
									</button>
								</div>
								<Button
									size="sm"
									variant="secondary"
									onClick={handleGeminiSave}
									disabled={!geminiKey.trim()}
								>
									{geminiSaveStatus === "saved" ? (
										<span className="flex items-center gap-1 text-green-500">
											<CheckCircle className="h-4 w-4" /> Saved
										</span>
									) : geminiSaveStatus === "error" ? (
										<span className="text-destructive">Failed</span>
									) : (
										"Save"
									)}
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={handleGeminiTest}
									disabled={!geminiKey.trim() || geminiTesting}
								>
									{geminiTesting ? "Testing…" : "Test"}
								</Button>
							</div>
							<div className="mt-2 text-xs">
								{geminiTestStatus === "valid" && (
									<span className="flex items-center gap-1 text-green-500">
										<CheckCircle className="h-3 w-3" /> Valid key
									</span>
								)}
								{geminiTestStatus === "invalid" && (
									<span className="flex items-center gap-1 text-destructive">
										<XCircle className="h-3 w-3" /> Invalid key
									</span>
								)}
								{geminiTestStatus === "idle" && !geminiKey && (
									<span className="text-muted-foreground">
										Get a key at{" "}
										<a
											href="https://aistudio.google.com/apikey"
											target="_blank"
											rel="noreferrer"
											className="underline hover:text-foreground"
										>
											aistudio.google.com
										</a>
									</span>
								)}
							</div>
						</div>
					</CardContent>
				</Card>

				{/* Integrations section */}
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Integrations</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div>
							<p className="text-sm font-medium mb-1">OMDB API</p>
							<div className="flex items-center gap-2">
								<div className="relative flex-1">
									<Input
										type={omdbKeyVisible ? "text" : "password"}
										placeholder="Enter API key…"
										value={omdbKey}
										onChange={(e) => {
											setOmdbKey(e.target.value);
											setOmdbStatus("idle");
											setSaveStatus("idle");
										}}
										className="pr-10"
									/>
									<button
										type="button"
										className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
										onClick={() => setOmdbKeyVisible((v) => !v)}
										aria-label={omdbKeyVisible ? "Hide key" : "Show key"}
									>
										{omdbKeyVisible ? (
											<EyeOff className="h-4 w-4" />
										) : (
											<Eye className="h-4 w-4" />
										)}
									</button>
								</div>
								<Button
									size="sm"
									variant="secondary"
									onClick={handleSaveOmdbKey}
									disabled={!omdbKey.trim()}
								>
									{saveStatus === "saved" ? (
										<span className="flex items-center gap-1 text-green-500">
											<CheckCircle className="h-4 w-4" /> Saved
										</span>
									) : (
										"Save"
									)}
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={handleTestOmdbKey}
									disabled={!omdbKey.trim() || omdbTesting}
								>
									{omdbTesting ? "Testing…" : "Test"}
								</Button>
							</div>

							{/* Save error */}
							{saveError && (
								<p className="mt-1 text-xs text-destructive">{saveError}</p>
							)}

							{/* Status line */}
							<div className="mt-2 text-xs">
								{omdbStatus === "valid" && (
									<span className="flex items-center gap-1 text-green-500">
										<CheckCircle className="h-3 w-3" /> Valid key · 1000
										calls/day limit
									</span>
								)}
								{omdbStatus === "invalid" && (
									<span className="flex items-center gap-1 text-destructive">
										<XCircle className="h-3 w-3" /> Invalid key
									</span>
								)}
								{omdbStatus === "idle" && !omdbKey && (
									<span className="text-muted-foreground">
										No API key configured.{" "}
										<a
											href="https://www.omdbapi.com/apikey.aspx"
											target="_blank"
											rel="noreferrer"
											className="underline hover:text-foreground"
										>
											Get a free key at omdbapi.com
										</a>
									</span>
								)}
							</div>
						</div>

						{/* Optional enrichment services — only shown when OMDB key is set */}
						{omdbKey.trim() && (
							<div className="border-t border-border pt-4 space-y-4">
								<p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
									Optional enrichment (require OMDB key)
								</p>

								{/* OpenSubtitles section */}
								<div>
									<p className="text-sm font-medium mb-1">OpenSubtitles API</p>
									<div className="flex items-center gap-2">
										<div className="relative flex-1">
											<Input
												type={openSubtitlesKeyVisible ? "text" : "password"}
												placeholder="Enter API key…"
												value={openSubtitlesKey}
												onChange={(e) => {
													setOpenSubtitlesKey(e.target.value);
													setOpenSubtitlesTestStatus("idle");
													setOpenSubtitlesSaveStatus("idle");
												}}
												className="pr-10"
											/>
											<button
												type="button"
												className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
												onClick={() =>
													setOpenSubtitlesKeyVisible((v) => !v)
												}
												aria-label={
													openSubtitlesKeyVisible
														? "Hide key"
														: "Show key"
												}
											>
												{openSubtitlesKeyVisible ? (
													<EyeOff className="h-4 w-4" />
												) : (
													<Eye className="h-4 w-4" />
												)}
											</button>
										</div>
										<Button
											size="sm"
											variant="secondary"
											onClick={handleSaveOpenSubtitlesKey}
											disabled={!openSubtitlesKey.trim()}
										>
											{openSubtitlesSaveStatus === "saved" ? (
												<span className="flex items-center gap-1 text-green-500">
													<CheckCircle className="h-4 w-4" /> Saved
												</span>
											) : (
												"Save"
											)}
										</Button>
										<Button
											size="sm"
											variant="outline"
											onClick={handleTestOpenSubtitlesKey}
											disabled={
												!openSubtitlesKey.trim() || openSubtitlesTesting
											}
										>
											{openSubtitlesTesting ? "Testing…" : "Test"}
										</Button>
									</div>

									{openSubtitlesSaveError && (
										<p className="mt-1 text-xs text-destructive">
											{openSubtitlesSaveError}
										</p>
									)}

									<div className="mt-2 text-xs">
										{openSubtitlesTestStatus === "valid" && (
											<span className="flex items-center gap-1 text-green-500">
												<CheckCircle className="h-3 w-3" /> Valid key
											</span>
										)}
										{openSubtitlesTestStatus === "invalid" && (
											<span className="flex items-center gap-1 text-destructive">
												<XCircle className="h-3 w-3" /> Invalid key
											</span>
										)}
									</div>

									<div className="mt-1 text-xs text-muted-foreground">
										Get an API key at{" "}
										<a
											href="https://www.opensubtitles.com/consumers"
											target="_blank"
											rel="noreferrer"
											className="underline hover:text-foreground"
										>
											opensubtitles.com
										</a>
									</div>
								</div>
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
												<CheckCircle className="h-4 w-4" /> Saved
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
								<div className="flex items-center justify-between mb-1">
									<p className="text-sm font-medium">Simultaneous downloads</p>
									<span className="text-sm text-muted-foreground tabular-nums">
										{concurrency}
									</span>
								</div>
								<p className="text-xs text-muted-foreground mb-2">
									How many downloads run at once (1–10).
								</p>
								<Input
									type="number"
									min={1}
									max={10}
									value={concurrency}
									onChange={(e) =>
										handleConcurrencyChange(Number(e.target.value))
									}
									className="w-24"
								/>
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
										<CheckCircle className="h-3 w-3" /> History cleared
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
								Clears all cached metadata (OMDB, MDBList, OpenSubtitles, WhatsonTV,
								EPG). Channel data and settings are not affected.
							</p>
							<div className="flex items-center gap-4">
								<Button variant="destructive" size="sm" onClick={handleClearCaches}>
									Clear All Caches…
								</Button>
								{cacheStatus === "cleared" && (
									<span className="flex items-center gap-1 text-xs text-green-500">
										<CheckCircle className="h-3 w-3" /> Caches cleared
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
								Max Video Player is free and open source. If you find it useful,
								consider supporting development.
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
							Max Video Player {appVersion ? `v${appVersion}` : ""}
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
									{!updateState.checking && !updateState.update && (
										<span className="text-xs text-muted-foreground">
											You're up to date.
										</span>
									)}
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

			<DownloadHistoryDialog
				open={showDownloadHistory}
				onClose={() => setShowDownloadHistory(false)}
			/>
		</div>
	);
};
