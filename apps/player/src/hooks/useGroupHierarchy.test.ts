// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/tauri", () => ({
	getGroupHierarchy: vi.fn(),
	getPinnedGroups: vi.fn(),
	pinGroup: vi.fn(),
	unpinGroup: vi.fn(),
}));

import { useGroupHierarchy } from "./useGroupHierarchy";
import { getGroupHierarchy, getPinnedGroups, pinGroup, unpinGroup } from "@/lib/tauri";
import type { PinnedGroup } from "@/lib/types";

const mockGetHierarchy = vi.mocked(getGroupHierarchy);
const mockGetPinned = vi.mocked(getPinnedGroups);

describe("useGroupHierarchy", () => {
	afterEach(cleanup);

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetHierarchy.mockResolvedValue([
			{
				providerId: "p1",
				contentType: "live",
				groupName: "US: Sports",
				superCategory: "United States",
				sortOrder: 0,
				isUserOverride: false,
			},
			{
				providerId: "p1",
				contentType: "live",
				groupName: "US: News",
				superCategory: "United States",
				sortOrder: 100,
				isUserOverride: false,
			},
			{
				providerId: "p1",
				contentType: "live",
				groupName: "Misc",
				superCategory: null,
				sortOrder: 200,
				isUserOverride: false,
			},
		]);
		mockGetPinned.mockResolvedValue([]);
	});

	it("loads hierarchy and derives super-categories", async () => {
		const { result } = renderHook(() => useGroupHierarchy("p1", "live"));
		await waitFor(() => expect(result.current.loaded).toBe(true));

		expect(result.current.superCategories).toEqual(["United States"]);
		expect(result.current.topLevelGroups).toEqual(["Misc"]);
		expect(result.current.getGroupsForCategory("United States")).toEqual([
			"US: Sports",
			"US: News",
		]);
	});

	const pinned = (groupName: string, sortOrder: number): PinnedGroup => ({
		providerId: "p1",
		contentType: "live",
		groupName,
		sortOrder,
	});

	it("puts the first pinned group at the top of the order", async () => {
		const { result } = renderHook(() => useGroupHierarchy("p1", "live"));
		await waitFor(() => expect(result.current.loaded).toBe(true));
		mockGetPinned.mockResolvedValueOnce([pinned("Misc", 0)]);

		await act(() => result.current.pinGroup("Misc"));

		expect(pinGroup).toHaveBeenCalledWith("p1", "live", "Misc", 0);
		expect(result.current.isPinned("Misc")).toBe(true);
		expect(result.current.isPinned("US: News")).toBe(false);
	});

	it("pins a group after the last pinned one", async () => {
		mockGetPinned.mockResolvedValue([pinned("Misc", 0), pinned("US: News", 250)]);
		const { result } = renderHook(() => useGroupHierarchy("p1", "live"));
		await waitFor(() => expect(result.current.pinnedGroups).toHaveLength(2));

		await act(() => result.current.pinGroup("US: Sports"));

		expect(pinGroup).toHaveBeenCalledWith("p1", "live", "US: Sports", 350);
		expect(mockGetHierarchy).toHaveBeenCalledTimes(2);
	});

	it("unpins a group and reloads the pinned list", async () => {
		mockGetPinned.mockResolvedValueOnce([pinned("Misc", 0)]);
		const { result } = renderHook(() => useGroupHierarchy("p1", "live"));
		await waitFor(() => expect(result.current.isPinned("Misc")).toBe(true));

		await act(() => result.current.unpinGroup("Misc"));

		expect(unpinGroup).toHaveBeenCalledWith("p1", "live", "Misc");
		expect(result.current.isPinned("Misc")).toBe(false);
		expect(result.current.pinnedGroups).toEqual([]);
	});

	it("does nothing until a provider is chosen", async () => {
		const { result } = renderHook(() => useGroupHierarchy(null, "live"));

		await act(() => result.current.pinGroup("Misc"));
		await act(() => result.current.unpinGroup("Misc"));
		await act(() => result.current.reload());

		expect(mockGetHierarchy).not.toHaveBeenCalled();
		expect(pinGroup).not.toHaveBeenCalled();
		expect(unpinGroup).not.toHaveBeenCalled();
		expect(result.current.loaded).toBe(false);
		expect(result.current.hasHierarchy).toBe(false);
	});

	it("logs a failed load and still counts as loaded with no groups", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("database locked");
		mockGetHierarchy.mockRejectedValueOnce(failure);
		try {
			const { result } = renderHook(() => useGroupHierarchy("p1", "live"));
			await waitFor(() => expect(result.current.loaded).toBe(true));

			expect(consoleError).toHaveBeenCalledWith("Failed to load group hierarchy:", failure);
			expect(result.current.entries).toEqual([]);
			expect(result.current.hasHierarchy).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});
});
