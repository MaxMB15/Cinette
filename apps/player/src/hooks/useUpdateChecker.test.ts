// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useUpdateChecker } from "./useUpdateChecker";

vi.mock("@tauri-apps/plugin-updater", () => ({
	check: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
	relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@/lib/tauri", () => ({
	getInstallInfo: vi.fn().mockResolvedValue({
		installType: "native",
		releaseUrl: "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest",
	}),
	packageUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { getInstallInfo, packageUpdate } from "@/lib/tauri";
import { fakeUpdate } from "@/test/app-fixtures";

const mockCheck = vi.mocked(check);
const mockRelaunch = vi.mocked(relaunch);
const mockGetInstallInfo = vi.mocked(getInstallInfo);
const mockPackageUpdate = vi.mocked(packageUpdate);

describe("useUpdateChecker", () => {
	beforeEach(() => {
		mockCheck.mockResolvedValue(null);
		mockRelaunch.mockResolvedValue(undefined);
		mockGetInstallInfo.mockResolvedValue({
			installType: "native",
			releaseUrl: "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest",
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// ── check on mount ─────────────────────────────────────────────────

	it("calls check() with timeout on mount", async () => {
		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.checking).toBe(false));

		expect(mockCheck).toHaveBeenCalledWith({ timeout: 5_000 });
	});

	it("sets update when check() finds one", async () => {
		const update = fakeUpdate();
		mockCheck.mockResolvedValue(update as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.checking).toBe(false));

		expect(result.current.update).toBe(update);
	});

	it("sets update to null when check() finds nothing", async () => {
		mockCheck.mockResolvedValue(null);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.checking).toBe(false));

		expect(result.current.update).toBeNull();
	});

	it("reports check() errors as checkError, not as an install error", async () => {
		mockCheck.mockRejectedValue(new Error("network error"));

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.checking).toBe(false));

		expect(result.current.update).toBeNull();
		expect(result.current.error).toBeNull();
		expect(result.current.checkError).toBe("network error");
	});

	it("clears checkError when a later check succeeds", async () => {
		mockCheck.mockRejectedValue(new Error("network error"));
		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.checkError).toBe("network error"));

		mockCheck.mockResolvedValue(null);
		await act(async () => {
			await result.current.checkForUpdates();
		});
		expect(result.current.checkError).toBeNull();
	});

	// ── shared inflight promise ────────────────────────────────────────

	it("concurrent checkForUpdates() calls share the same check() call", async () => {
		mockCheck.mockResolvedValue(null);
		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.checking).toBe(false));

		// Set up for manual calls
		mockCheck.mockClear();
		const update = fakeUpdate();
		mockCheck.mockResolvedValue(update as never);

		let p1: unknown, p2: unknown;
		await act(async () => {
			p1 = result.current.checkForUpdates();
			p2 = result.current.checkForUpdates();
			await Promise.all([p1, p2]);
		});

		expect(mockCheck).toHaveBeenCalledTimes(1);
		expect(await p1).toBe(await p2);
	});

	it("allows a new check after previous one completes", async () => {
		mockCheck.mockResolvedValue(null);
		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.checking).toBe(false));

		mockCheck.mockClear();
		mockCheck.mockResolvedValue(fakeUpdate() as never);
		await act(async () => {
			await result.current.checkForUpdates();
		});
		expect(result.current.update).toBeTruthy();

		mockCheck.mockClear();
		mockCheck.mockResolvedValue(null);
		await act(async () => {
			await result.current.checkForUpdates();
		});
		expect(mockCheck).toHaveBeenCalledTimes(1);
		expect(result.current.update).toBeNull();
	});

	// ── dismiss ────────────────────────────────────────────────────────

	it("dismiss() clears the update", async () => {
		mockCheck.mockResolvedValue(fakeUpdate() as never);
		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBeTruthy());

		act(() => result.current.dismiss());
		expect(result.current.update).toBeNull();
	});

	// ── install: success ───────────────────────────────────────────────

	it("calls downloadAndInstall then relaunch on success", async () => {
		const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
		mockCheck.mockResolvedValue(fakeUpdate({ downloadAndInstall }) as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBeTruthy());

		await act(async () => {
			await result.current.install();
		});

		expect(downloadAndInstall).toHaveBeenCalledTimes(1);
		expect(mockRelaunch).toHaveBeenCalledTimes(1);
	});

	it("tracks download progress", async () => {
		const downloadAndInstall = vi.fn().mockImplementation(async (cb: (e: unknown) => void) => {
			cb({ event: "Started", data: { contentLength: 1000 } });
			cb({ event: "Progress", data: { chunkLength: 500 } });
			cb({ event: "Progress", data: { chunkLength: 500 } });
		});
		mockCheck.mockResolvedValue(fakeUpdate({ downloadAndInstall }) as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBeTruthy());

		await act(async () => {
			await result.current.install();
		});

		expect(result.current.progress).toBe(100);
	});

	// ── install: failure (the 404 bug) ─────────────────────────────────

	it("sets error when downloadAndInstall fails with 404", async () => {
		const downloadAndInstall = vi
			.fn()
			.mockRejectedValue(new Error("Download request failed with status: 404 Not Found"));
		mockCheck.mockResolvedValue(fakeUpdate({ downloadAndInstall }) as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBeTruthy());

		await act(async () => {
			await result.current.install();
		});

		expect(result.current.error).toBe(
			"Update failed: Download request failed with status: 404 Not Found"
		);
		expect(result.current.installing).toBe(false);
		expect(result.current.progress).toBeNull();
	});

	it("keeps update visible after install failure so user can retry", async () => {
		const downloadAndInstall = vi.fn().mockRejectedValue(new Error("network error"));
		const update = fakeUpdate({ downloadAndInstall });
		mockCheck.mockResolvedValue(update as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBe(update));

		await act(async () => {
			await result.current.install();
		});

		// update must NOT be cleared — user needs the banner to retry
		expect(result.current.update).toBe(update);
		expect(result.current.error).toBeTruthy();
	});

	it("clears previous error when retrying install", async () => {
		const downloadAndInstall = vi
			.fn()
			.mockRejectedValueOnce(new Error("first fail"))
			.mockResolvedValueOnce(undefined);
		mockCheck.mockResolvedValue(fakeUpdate({ downloadAndInstall }) as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBeTruthy());

		// First attempt — fails
		await act(async () => {
			await result.current.install();
		});
		expect(result.current.error).toContain("first fail");

		// Retry — error should clear, then relaunch
		await act(async () => {
			await result.current.install();
		});
		expect(mockRelaunch).toHaveBeenCalled();
	});

	it("does nothing when install is called without an update", async () => {
		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.checking).toBe(false));

		await act(async () => {
			await result.current.install();
		});

		expect(result.current.installing).toBe(false);
		expect(result.current.error).toBeNull();
	});

	// ── package install (deb/rpm) ──────────────────────────────────────

	it("sets packageInstall for deb installs", async () => {
		mockGetInstallInfo.mockResolvedValue({
			installType: "deb",
			releaseUrl: "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest",
		});
		mockCheck.mockResolvedValue(fakeUpdate() as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBeTruthy());

		expect(result.current.packageInstall).toBe(true);
	});

	it("sets packageInstall for rpm installs", async () => {
		mockGetInstallInfo.mockResolvedValue({
			installType: "rpm",
			releaseUrl: "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest",
		});
		mockCheck.mockResolvedValue(fakeUpdate() as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBeTruthy());

		expect(result.current.packageInstall).toBe(true);
	});

	it("calls packageUpdate instead of downloadAndInstall for deb installs", async () => {
		mockGetInstallInfo.mockResolvedValue({
			installType: "deb",
			releaseUrl: "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest",
		});
		const downloadAndInstall = vi.fn();
		mockCheck.mockResolvedValue(fakeUpdate({ downloadAndInstall }) as never);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.update).toBeTruthy());

		await act(async () => {
			await result.current.install();
		});

		expect(mockPackageUpdate).toHaveBeenCalledTimes(1);
		expect(downloadAndInstall).not.toHaveBeenCalled();
		expect(mockRelaunch).toHaveBeenCalledTimes(1);
	});
});

describe("useUpdateChecker over time", () => {
	const TWO_HOURS = 2 * 60 * 60 * 1000;

	beforeEach(() => {
		mockCheck.mockResolvedValue(null);
		mockRelaunch.mockResolvedValue(undefined);
		mockGetInstallInfo.mockResolvedValue({
			installType: "native",
			releaseUrl: "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest",
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("checks again every two hours while the app stays open", async () => {
		vi.useFakeTimers();
		const { unmount } = renderHook(() => useUpdateChecker());
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(mockCheck).toHaveBeenCalledTimes(1);

		await act(() => vi.advanceTimersByTimeAsync(TWO_HOURS - 1));
		expect(mockCheck).toHaveBeenCalledTimes(1);

		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(mockCheck).toHaveBeenCalledTimes(2);

		unmount();
		await act(() => vi.advanceTimersByTimeAsync(TWO_HOURS));
		expect(mockCheck).toHaveBeenCalledTimes(2);
	});

	it("shows package manager progress while a deb update installs", async () => {
		mockGetInstallInfo.mockResolvedValue({
			installType: "deb",
			releaseUrl: "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest",
		});
		mockCheck.mockResolvedValue(fakeUpdate() as never);
		let listenedTo: string | undefined;
		let onProgress: EventCallback<{ percent: number }> | undefined;
		const unlisten = vi.fn();
		vi.mocked(listen).mockImplementationOnce(async (event, handler) => {
			listenedTo = event;
			onProgress = handler as EventCallback<{ percent: number }>;
			return unlisten;
		});
		let finishPackageUpdate = () => {};
		mockPackageUpdate.mockImplementationOnce(
			() => new Promise<void>((resolve) => (finishPackageUpdate = resolve))
		);

		const { result } = renderHook(() => useUpdateChecker());
		await waitFor(() => expect(result.current.packageInstall).toBe(true));

		let installing: Promise<void> = Promise.resolve();
		act(() => {
			installing = result.current.install();
		});
		await waitFor(() => expect(onProgress).toBeDefined());
		expect(listenedTo).toBe("package-update://progress");
		expect(result.current.installing).toBe(true);

		act(() =>
			onProgress!({ event: "package-update://progress", id: 1, payload: { percent: 42 } })
		);
		expect(result.current.progress).toBe(42);
		expect(unlisten).not.toHaveBeenCalled();

		await act(async () => {
			finishPackageUpdate();
			await installing;
		});
		expect(unlisten).toHaveBeenCalledOnce();
		expect(mockRelaunch).toHaveBeenCalledOnce();
	});
});
