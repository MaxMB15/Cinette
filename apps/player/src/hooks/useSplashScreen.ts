// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useCallback } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { refreshProvider, refreshEpg } from "@/lib/tauri";
import {
	loadProviderSettings,
	getEpgLastRefresh,
	setEpgLastRefresh,
	useChannels,
} from "@/hooks/useChannels";
import { findDueRefreshes, refreshKeys } from "@/lib/refresh-schedule";
import type { UpdateState } from "@/hooks/useUpdateChecker";
import { readStorage, SPLASH_SHOWN_KEY, writeStorage } from "@/lib/storage";
import { useLatestRef } from "@/hooks/useLatestRef";

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

/** One of the splash steps that refreshes a list of providers. */
interface RefreshStep {
	id: string;
	ids: string[];
	refresh: (id: string) => Promise<unknown>;
	labels: {
		active: string;
		failed: string;
		/** Plural noun for the partial failure message. */
		sources: string;
		done: string;
		upToDate: string;
		none: string;
	};
}

interface UseSplashScreenOptions {
	updateState: UpdateState;
	onComplete?: (didRefreshProviders: boolean) => void;
}

export const useSplashScreen = (options: UseSplashScreenOptions): SplashScreenState => {
	const { updateState, onComplete } = options;
	const onCompleteRef = useLatestRef(onComplete);

	const [alreadyShown] = useState(() => readStorage(SPLASH_SHOWN_KEY, "session") === "true");

	// Consume providers from ChannelsContext (already loaded on mount — no extra Tauri calls)
	const { providers, initialized, autoRefresh } = useChannels();

	// Initialize all steps immediately so they're visible from the first render.
	// The app store updates the mobile apps, so they skip the update check.
	const [steps, setSteps] = useState<SplashStep[]>(() => {
		if (alreadyShown) return [];
		return [
			{ id: "providers", label: "Loading providers & channels", status: "active" },
			{ id: "playlists", label: "Checking playlists…", status: "pending" },
			{ id: "epg", label: "Checking EPG…", status: "pending" },
			...(updateState.supported
				? [{ id: "updates", label: "Checking for updates", status: "pending" as const }]
				: []),
		];
	});
	const [allDone, setAllDone] = useState(alreadyShown);
	const [dismissed, setDismissed] = useState(alreadyShown);
	const [hasProviders, setHasProviders] = useState(false);

	const dismiss = useCallback(() => {
		writeStorage(SPLASH_SHOWN_KEY, "true", "session");
		setDismissed(true);
	}, []);

	// The effect below reads these through a ref, so a refresh that updates
	// the provider list doesn't start the steps again.
	const startup = useLatestRef({ providers, updateState });

	// Run once ChannelsContext has finished its initial provider fetch
	useEffect(() => {
		if (alreadyShown || !initialized) return;
		// The providers and the update check as they were when loading finished.
		const { providers: loaded, updateState: updates } = startup.current;

		let cancelled = false;

		const setStepStatus = (id: string, status: StepStatus, label?: string) => {
			setSteps((prev) =>
				prev.map((s) => (s.id === id ? { ...s, status, ...(label ? { label } : {}) } : s))
			);
		};

		const run = async () => {
			const hasAnyProviders = loaded.length > 0;
			setHasProviders(hasAnyProviders);

			// Step 1 complete — providers came from ChannelsContext, no extra fetch needed
			setStepStatus("providers", "done", "Providers & channels loaded");

			const { playlistIds: providerRefreshIds, epgIds: epgRefreshIds } = findDueRefreshes(
				loaded,
				{ settingsFor: loadProviderSettings, epgLastRefreshFor: getEpgLastRefresh }
			);

			const didRefreshProviders = providerRefreshIds.length > 0;

			// Runs the refresh through the poll's tracker. A refresh the poll already
			// started is joined, not run twice, and the poll won't start this one
			// again while it runs. One still waiting to retry after a failure
			// counts as failed.
			const tracked = (key: string, refresh: () => Promise<unknown>) =>
				autoRefresh.run(key, refresh) ??
				Promise.reject(new Error(`${key} failed recently, waiting to retry`));

			// Runs one refresh step and returns false if the effect was cleaned up
			// while it waited, so the caller stops too.
			const runRefreshStep = async (step: RefreshStep): Promise<boolean> => {
				setStepStatus(step.id, "active", step.labels.active);
				if (step.ids.length === 0) {
					setStepStatus(
						step.id,
						"done",
						hasAnyProviders ? step.labels.upToDate : step.labels.none
					);
					return true;
				}
				const results = await Promise.allSettled(step.ids.map((id) => step.refresh(id)));
				if (cancelled) return false;
				const failed = results.filter((r) => r.status === "rejected").length;
				if (failed === results.length) {
					setStepStatus(step.id, "error", step.labels.failed);
				} else if (failed > 0) {
					setStepStatus(
						step.id,
						"error",
						`Failed to refresh ${failed} of ${results.length} ${step.labels.sources}`
					);
				} else {
					setStepStatus(step.id, "done", step.labels.done);
				}
				return true;
			};

			// Step 2: Refresh playlists (always shown; mark done immediately if nothing to do)
			const playlistsFinished = await runRefreshStep({
				id: "playlists",
				ids: providerRefreshIds,
				refresh: (id) => tracked(refreshKeys.playlist(id), () => refreshProvider(id)),
				labels: {
					active: "Refreshing playlists…",
					failed: "Failed to refresh playlists",
					sources: "playlists",
					done: "Playlists refreshed",
					upToDate: "Playlists up to date",
					none: "No playlists configured",
				},
			});
			if (!playlistsFinished) return;

			// Step 3: Refresh EPG (always shown; mark done immediately if nothing to do)
			const epgFinished = await runRefreshStep({
				id: "epg",
				ids: epgRefreshIds,
				refresh: (id) =>
					tracked(refreshKeys.epg(id), () =>
						refreshEpg(id).then(() => setEpgLastRefresh(id))
					),
				labels: {
					active: "Checking EPG…",
					failed: "Failed to refresh EPG",
					sources: "EPG sources",
					done: "EPG refreshed",
					upToDate: "EPG up to date",
					none: "No EPG configured",
				},
			});
			if (!epgFinished) return;

			if (!updates.supported) {
				setAllDone(true);
				onCompleteRef.current?.(didRefreshProviders);
				return;
			}

			// Step 4: Check for updates via the shared hook.
			// checkForUpdates() joins the in-flight promise if the mount check is
			// still running, so only one actual check() call happens.
			// Give up after 7s so the splash never gets stuck.
			setStepStatus("updates", "active");
			let foundUpdate: Update | null;
			try {
				foundUpdate = await Promise.race([
					updates.checkForUpdates(),
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

		run().catch((err) => {
			// A step that throws must still leave the splash with a way out.
			console.error("[splash] startup steps failed:", err);
			if (cancelled) return;
			setSteps((prev) =>
				prev.map((s) =>
					s.status === "pending" || s.status === "active" ? { ...s, status: "error" } : s
				)
			);
			setAllDone(true);
			onCompleteRef.current?.(true);
		});
		return () => {
			cancelled = true;
		};
		// The steps run once, with the providers loaded at startup: the other
		// dependencies are a state that never changes, the context's tracker
		// and two refs, which all stay the same object while the app runs.
	}, [alreadyShown, initialized, startup, autoRefresh, onCompleteRef]);

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
