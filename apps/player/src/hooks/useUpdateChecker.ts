// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState, useCallback, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { checkAndroidUpdate, getInstallInfo, packageUpdate, type AndroidUpdate } from "@/lib/tauri";
import { updatesItself } from "@/lib/platform";

/** Tauri's update on a computer, or the newest release for the Android build from GitHub. */
export type AvailableUpdate = Update | AndroidUpdate;

export interface UpdateState {
	update: AvailableUpdate | null;
	checking: boolean;
	installing: boolean;
	progress: number | null;
	error: string | null;
	/** Why the last update check failed, or null when it succeeded */
	checkError: string | null;
	/** true when using package manager update (deb/rpm) instead of Tauri updater */
	packageInstall: boolean;
	/** false where an app store updates the app: iOS, and Android but for the build from GitHub */
	supported: boolean;
	dismiss: () => void;
	install: () => Promise<void>;
	checkForUpdates: () => Promise<AvailableUpdate | null>;
}

export const useUpdateChecker = (): UpdateState => {
	const [update, setUpdate] = useState<AvailableUpdate | null>(null);
	const [checking, setChecking] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [progress, setProgress] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [checkError, setCheckError] = useState<string | null>(null);
	const [packageInstall, setPackageInstall] = useState(false);
	const [supported] = useState(() => updatesItself());

	// Cache install info so we only call it once
	const installInfoRef = useRef<{ installType: string; releaseUrl: string } | null>(null);

	// Share a single in-flight promise so concurrent callers (mount + splash)
	// all wait for the same check() call instead of one getting null.
	const inflightRef = useRef<Promise<AvailableUpdate | null> | null>(null);

	const checkForUpdates = useCallback((): Promise<AvailableUpdate | null> => {
		if (!supported) return Promise.resolve(null);
		if (inflightRef.current) return inflightRef.current;

		setChecking(true);
		setError(null);
		setCheckError(null);
		const run = async () => {
			// Fetch install info once
			if (!installInfoRef.current) {
				installInfoRef.current = await getInstallInfo();
			}

			const type = installInfoRef.current.installType;
			const result =
				type === "apk"
					? await checkAndroidUpdate()
					: ((await check({ timeout: 5_000 })) ?? null);
			setUpdate(result);
			setPackageInstall(type === "deb" || type === "rpm");

			return result;
		};
		// Promise callbacks in place of try and finally, which the React
		// Compiler can't compile yet.
		const promise = run()
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn("[updater] check error:", msg);
				setCheckError(msg);
				return null;
			})
			.finally(() => {
				setChecking(false);
				inflightRef.current = null;
			});

		inflightRef.current = promise;
		return promise;
	}, [supported]);

	// Check on mount
	useEffect(() => {
		checkForUpdates();
	}, [checkForUpdates]);

	// Re-check every 2 hours
	useEffect(() => {
		if (!supported) return;
		const id = setInterval(
			() => {
				checkForUpdates();
			},
			2 * 60 * 60 * 1000
		);
		return () => clearInterval(id);
	}, [checkForUpdates, supported]);

	const dismiss = useCallback(() => {
		setUpdate(null);
		setPackageInstall(false);
	}, []);

	const install = useCallback(async () => {
		if (!update) return;
		// Outside the try, where the React Compiler can't take a condition yet.
		const tauriUpdate = "downloadAndInstall" in update && !packageInstall ? update : null;

		setInstalling(true);
		setProgress(0);
		setError(null);

		try {
			if (tauriUpdate) {
				// AppImage/macOS/Windows: use Tauri's built-in updater
				let downloaded = 0;
				let total: number | undefined;
				await tauriUpdate.downloadAndInstall((event) => {
					if (event.event === "Started") {
						total = event.data.contentLength ?? undefined;
					} else if (event.event === "Progress") {
						downloaded += event.data.chunkLength;
						if (total) {
							setProgress(Math.min(100, Math.round((downloaded / total) * 100)));
						}
					}
				});
			} else {
				// deb/rpm and the Android build from GitHub: our own package update command
				const unlisten = await listen<{ percent: number }>(
					"package-update://progress",
					(event) => setProgress(event.payload.percent)
				);
				await packageUpdate().finally(() => unlisten());
			}
			if ("downloadAndInstall" in update) {
				await relaunch();
			} else {
				// Android's installer is open. It replaces the app, and the
				// banner stays so a cancelled install can start again.
				setInstalling(false);
				setProgress(null);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[updater] install failed:", msg);
			setError(`Update failed: ${msg}`);
			setInstalling(false);
			setProgress(null);
		}
	}, [update, packageInstall]);

	return {
		update,
		checking,
		installing,
		progress,
		error,
		checkError,
		packageInstall,
		supported,
		dismiss,
		install,
		checkForUpdates,
	};
};
