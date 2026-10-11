// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useCallback, useRef } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { refreshProvider, refreshEpg } from "@/lib/tauri";
import {
	loadProviderSettings,
	getEpgLastRefresh,
	setEpgLastRefresh,
	useChannels,
} from "@/hooks/useChannels";
import { parseDateMs } from "@/lib/date";
import type { UpdateState } from "@/hooks/useUpdateChecker";

export type StepStatus = "pending" | "active" | "done" | "error";

export interface SplashStep {
	id: string;
	label: string;
	status: StepStatus;
}

export interface SplashScreenState {
	steps: SplashStep[];
	allDone: boolean;
	progress: number;
	update: Update | null;
	dismissed: boolean;
	hasProviders: boolean;
	dismiss: () => void;
}

const SESSION_KEY = "splash-shown";

interface UseSplashScreenOptions {
	updateState: UpdateState;
	onComplete?: (didRefreshProviders: boolean) => void;
}

export const useSplashScreen = (options: UseSplashScreenOptions): SplashScreenState => {
	const { updateState, onComplete } = options;
	const onCompleteRef = useRef(onComplete);
	useEffect(() => {
		onCompleteRef.current = onComplete;
	}, [onComplete]);

	const alreadyShownRef = useRef(sessionStorage.getItem(SESSION_KEY) === "true");

	// Consume providers from ChannelsContext (already loaded on mount — no extra Tauri calls)
	const { providers, initialized } = useChannels();

	// Initialize all steps immediately so they're visible from the first render.
	// The app store updates the mobile apps, so they skip the update check.
	const [steps, setSteps] = useState<SplashStep[]>(() => {
		if (alreadyShownRef.current) return [];
		return [
			{ id: "providers", label: "Loading providers & channels", status: "active" },
			{ id: "playlists", label: "Checking playlists…", status: "pending" },
			{ id: "epg", label: "Checking EPG…", status: "pending" },
			...(updateState.supported
				? [{ id: "updates", label: "Checking for updates", status: "pending" as const }]
				: []),
		];
	});
	const [allDone, setAllDone] = useState(alreadyShownRef.current);
	const [dismissed, setDismissed] = useState(alreadyShownRef.current);
	const [hasProviders, setHasProviders] = useState(false);

	const dismiss = useCallback(() => {
		sessionStorage.setItem(SESSION_KEY, "true");
		setDismissed(true);
	}, []);

	// Run once ChannelsContext has finished its initial provider fetch
	useEffect(() => {
		if (alreadyShownRef.current || !initialized) return;

		let cancelled = false;

		const setStepStatus = (id: string, status: StepStatus, label?: string) => {
			setSteps((prev) =>
				prev.map((s) => (s.id === id ? { ...s, status, ...(label ? { label } : {}) } : s))
			);
		};

		const run = async () => {
			const hasAnyProviders = providers.length > 0;
			setHasProviders(hasAnyProviders);

			// Step 1 complete — providers came from ChannelsContext, no extra fetch needed
			setStepStatus("providers", "done", "Providers & channels loaded");

			// Determine which providers need refresh
			const now = Date.now();
			const providerRefreshIds: string[] = [];
			const epgRefreshIds: string[] = [];

			for (const p of providers) {
				const {
					autoRefresh,
					refreshIntervalHours,
					epgAutoRefresh,
					epgRefreshIntervalHours,
				} = loadProviderSettings(p.id);

				if (autoRefresh) {
					const lastMs = parseDateMs(p.lastUpdated);
					if (now - lastMs >= refreshIntervalHours * 60 * 60 * 1000) {
						providerRefreshIds.push(p.id);
					}
				}

				if (epgAutoRefresh && p.epgUrl) {
					const lastMs = getEpgLastRefresh(p.id);
					if (now - lastMs >= epgRefreshIntervalHours * 60 * 60 * 1000) {
						epgRefreshIds.push(p.id);
					}
				}
			}

			const didRefreshProviders = providerRefreshIds.length > 0;

			// Step 2: Refresh playlists (always shown; mark done immediately if nothing to do)
			setStepStatus("playlists", "active", "Refreshing playlists…");
			if (didRefreshProviders) {
				const results = await Promise.allSettled(
					providerRefreshIds.map((id) => refreshProvider(id))
				);
				if (cancelled) return;
				const failed = results.filter((r) => r.status === "rejected").length;
				if (failed === results.length) {
					setStepStatus("playlists", "error", "Failed to refresh playlists");
				} else if (failed > 0) {
					setStepStatus(
						"playlists",
						"error",
						`Failed to refresh ${failed} of ${results.length} playlists`
					);
				} else {
					setStepStatus("playlists", "done", "Playlists refreshed");
				}
			} else {
				setStepStatus(
					"playlists",
					"done",
					hasAnyProviders ? "Playlists up to date" : "No playlists configured"
				);
			}

			// Step 3: Refresh EPG (always shown; mark done immediately if nothing to do)
			setStepStatus("epg", "active", "Checking EPG…");
			if (epgRefreshIds.length > 0) {
				const results = await Promise.allSettled(
					epgRefreshIds.map((id) => refreshEpg(id).then(() => setEpgLastRefresh(id)))
				);
				if (cancelled) return;
				const failed = results.filter((r) => r.status === "rejected").length;
				if (failed === results.length) {
					setStepStatus("epg", "error", "Failed to refresh EPG");
				} else if (failed > 0) {
					setStepStatus(
						"epg",
						"error",
						`Failed to refresh ${failed} of ${results.length} EPG sources`
					);
				} else {
					setStepStatus("epg", "done", "EPG refreshed");
				}
			} else {
				setStepStatus(
					"epg",
					"done",
					hasAnyProviders ? "EPG up to date" : "No EPG configured"
				);
			}

			if (!updateState.supported) {
				setAllDone(true);
				onCompleteRef.current?.(didRefreshProviders);
				return;
			}

			// Step 4: Check for updates via the shared hook.
			// checkForUpdates() joins the in-flight promise if the mount check is
			// still running, so only one actual check() call happens.
			// Timeout after 10s so the splash never gets stuck.
			setStepStatus("updates", "active");
			let foundUpdate: Update | null = null;
			try {
				foundUpdate = await Promise.race([
					updateState.checkForUpdates(),
					new Promise<null>((_, reject) =>
						setTimeout(() => reject(new Error("Update check timed out")), 7_000)
					),
				]);
			} catch {
				if (cancelled) return;
				setStepStatus("updates", "error", "Unable to check for updates");
				setAllDone(true);
				onCompleteRef.current?.(didRefreshProviders);
				return;
			}

			if (cancelled) return;

			if (foundUpdate) {
				setStepStatus("updates", "done", `Update available — v${foundUpdate.version}`);
			} else {
				setStepStatus("updates", "done", "Up to date");
			}

			setAllDone(true);
			onCompleteRef.current?.(didRefreshProviders);
		};

		run();
		return () => {
			cancelled = true;
		};
	}, [initialized]); // eslint-disable-line react-hooks/exhaustive-deps

	const progress =
		steps.length === 0
			? 0
			: steps.filter((s) => s.status === "done" || s.status === "error").length /
				steps.length;

	return {
		steps,
		allDone,
		progress,
		update: updateState.update,
		dismissed,
		hasProviders,
		dismiss,
	};
};
