// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { Channel, GroupHierarchyEntry } from "@/lib/types";

vi.mock("@/lib/tauri", () => ({
	getGroupHierarchy: vi.fn(),
	deleteGroupHierarchy: vi.fn(),
	categorizeProvider: vi.fn(),
	fixUncategorizedGroups: vi.fn(),
	getGeminiApiKey: vi.fn(),
	updateGroupHierarchyEntry: vi.fn(),
	reorderGroupHierarchyEntry: vi.fn(),
	renameSuperCategory: vi.fn(),
	deleteSuperCategory: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { CategoryManager } from "./CategoryManager";
import { categorizeProvider, getGeminiApiKey, getGroupHierarchy } from "@/lib/tauri";

const channel = (name: string, groupTitle: string, contentType: Channel["contentType"]) =>
	({
		id: name,
		name,
		url: `http://example.com/${name}`,
		groupTitle,
		isFavorite: false,
		contentType,
		sources: [],
	}) satisfies Channel;

const entry = (groupName: string, superCategory: string | null): GroupHierarchyEntry => ({
	providerId: "p1",
	contentType: "movie",
	groupName,
	superCategory,
	sortOrder: 0,
	isUserOverride: false,
});

const renderManager = (channels: Channel[] = []) =>
	render(
		<CategoryManager
			providerId="p1"
			contentType="movie"
			channels={channels}
			onClose={vi.fn()}
			onHierarchyChanged={vi.fn()}
		/>
	);

describe("CategoryManager", () => {
	beforeEach(() => {
		vi.mocked(getGroupHierarchy).mockResolvedValue([]);
		vi.mocked(getGeminiApiKey).mockResolvedValue("key");
		vi.mocked(categorizeProvider).mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("samples only channels of the shown content type when categorizing", async () => {
		renderManager([
			channel("Heat", "Action", "movie"),
			channel("Action News", "Action", "live"),
			channel("Die Hard", "Action", "movie"),
		]);
		fireEvent.click(await screen.findByRole("button", { name: /Re-categorize All/ }));

		await waitFor(() => expect(categorizeProvider).toHaveBeenCalled());
		expect(categorizeProvider).toHaveBeenCalledWith("p1", "movie", "key", [
			["Action", ["Heat", "Die Hard"]],
		]);
	});

	it("names its icon-only buttons", async () => {
		vi.mocked(getGroupHierarchy).mockResolvedValue([
			entry("Action", "Genres"),
			entry("Comedy", "Genres"),
			entry("Misc", null),
		]);
		renderManager();

		expect(await screen.findByRole("button", { name: "Move category up" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Move category down" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		expect(screen.getByRole("button", { name: "Save name" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Cancel rename" }));

		fireEvent.click(screen.getByRole("button", { name: "Misc" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel move" }));
		expect(screen.queryByText(/to:/)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "AI: add groups to this category" }));
		fireEvent.click(screen.getByRole("button", { name: "Close AI prompt" }));
		expect(screen.queryByText(/AI will look at all other groups/)).toBeNull();
	});
});
