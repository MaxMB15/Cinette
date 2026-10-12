// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { vi } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdateState } from "@/hooks/useUpdateChecker";
import type { Provider } from "@/lib/types";

/** An update as the updater plugin reports it, with only the fields the app reads. */
export const fakeUpdate = (overrides: Partial<Update> = {}): Update =>
	({
		version: "2.0.0",
		body: "Release notes",
		date: "2026-01-01",
		downloadAndInstall: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}) as unknown as Update;

/** The state useUpdateChecker returns when no update is waiting. */
export const makeUpdateState = (overrides: Partial<UpdateState> = {}): UpdateState => ({
	update: null,
	checking: false,
	installing: false,
	progress: null,
	error: null,
	checkError: null,
	packageInstall: false,
	supported: true,
	dismiss: vi.fn(),
	install: vi.fn().mockResolvedValue(undefined),
	checkForUpdates: vi.fn().mockResolvedValue(null),
	...overrides,
});

/** An M3U playlist the backend has already loaded. */
export const makeProvider = (overrides: Partial<Provider> = {}): Provider => ({
	id: "p1",
	name: "Home",
	type: "m3u",
	url: "http://example.com/list.m3u",
	channelCount: 0,
	...overrides,
});
