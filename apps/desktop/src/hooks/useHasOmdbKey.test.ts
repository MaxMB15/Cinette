// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { OmdbData } from "@/lib/types";

vi.mock("@/lib/tauri", () => ({
	getOmdbApiKey: vi.fn(),
}));

import { getOmdbApiKey } from "@/lib/tauri";
import { rememberHasOmdbKey, useOmdbInfoState } from "./useHasOmdbKey";

const mockGetKey = vi.mocked(getOmdbApiKey);
const details = { title: "Harbour Lights" } as OmdbData;

describe("useOmdbInfoState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		rememberHasOmdbKey(null);
	});

	it("is loading and skips the key check while OMDb loads", () => {
		const { result } = renderHook(() => useOmdbInfoState(null, true));
		expect(result.current.infoLoading).toBe(true);
		expect(mockGetKey).not.toHaveBeenCalled();
	});

	it("skips the key check once OMDb has details", () => {
		const { result } = renderHook(() => useOmdbInfoState(details, false));
		expect(result.current.infoLoading).toBe(false);
		expect(mockGetKey).not.toHaveBeenCalled();
	});

	it("keeps loading without details until the key check answers", async () => {
		let answer: (key: string | null) => void = () => {};
		mockGetKey.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const { result } = renderHook(() => useOmdbInfoState(null, false));
		expect(result.current.infoLoading).toBe(true);
		expect(result.current.hasOmdbKey).toBeNull();

		answer(null);
		await waitFor(() => expect(result.current.infoLoading).toBe(false));
		expect(result.current.hasOmdbKey).toBe(false);
	});

	it("starts from the last answer so a sheet that opens again doesn't wait", () => {
		mockGetKey.mockReturnValue(new Promise(() => {}));
		rememberHasOmdbKey(true);
		const { result } = renderHook(() => useOmdbInfoState(null, false));
		expect(result.current.infoLoading).toBe(false);
		expect(result.current.hasOmdbKey).toBe(true);
	});
});
