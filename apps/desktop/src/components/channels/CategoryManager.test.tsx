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
import {
	categorizeProvider,
	getGeminiApiKey,
	getGroupHierarchy,
	renameSuperCategory,
	updateGroupHierarchyEntry,
} from "@/lib/tauri";

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

const entry = (
	groupName: string,
	superCategory: string | null,
	sortOrder = 0
): GroupHierarchyEntry => ({
	providerId: "p1",
	contentType: "movie",
	groupName,
	superCategory,
	sortOrder,
	isUserOverride: false,
});

const renderManager = (channels: Channel[] = [], onHierarchyChanged = vi.fn()) =>
	render(
		<CategoryManager
			providerId="p1"
			contentType="movie"
			channels={channels}
			onClose={vi.fn()}
			onHierarchyChanged={onHierarchyChanged}
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

	it("asks for a Gemini key before calling the AI", async () => {
		vi.mocked(getGeminiApiKey).mockResolvedValue(null);
		renderManager([channel("Heat", "Action", "movie")]);
		fireEvent.click(await screen.findByRole("button", { name: /Re-categorize All/ }));

		expect(await screen.findByText(/No Gemini API key configured/)).toBeTruthy();
		expect(categorizeProvider).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /Re-categorize All/ })).toBeTruthy();
	});

	it("moves a group to the end of another category and reloads", async () => {
		vi.mocked(getGroupHierarchy).mockResolvedValue([
			entry("Action", "Genres", 0),
			entry("Comedy", "Genres", 1),
			entry("UK", "Countries", 0),
			entry("US", "Countries", 4),
		]);
		const onHierarchyChanged = vi.fn();
		renderManager([], onHierarchyChanged);

		const chip = await screen.findByRole("button", { name: "Action" });
		fireEvent.click(chip);
		expect(chip.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Countries" }));

		await waitFor(() => expect(screen.queryByText(/to:/)).toBeNull());
		expect(updateGroupHierarchyEntry).toHaveBeenCalledWith(
			"p1",
			"movie",
			"Action",
			"Countries",
			5
		);
		expect(getGroupHierarchy).toHaveBeenCalledTimes(2);
		expect(onHierarchyChanged).toHaveBeenCalledTimes(1);
	});

	it("keeps the rename open and shows the error when it fails", async () => {
		vi.mocked(getGroupHierarchy).mockResolvedValue([entry("Action", "Genres")]);
		vi.mocked(renameSuperCategory).mockRejectedValue("Name taken");
		const onHierarchyChanged = vi.fn();
		renderManager([], onHierarchyChanged);

		fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
		fireEvent.change(screen.getByDisplayValue("Genres"), { target: { value: "Kinds" } });
		fireEvent.click(screen.getByRole("button", { name: "Save name" }));

		expect(await screen.findByText("Name taken")).toBeTruthy();
		expect(renameSuperCategory).toHaveBeenCalledWith("p1", "movie", "Genres", "Kinds");
		expect(screen.getByRole("button", { name: "Save name" })).toBeTruthy();
		expect(onHierarchyChanged).not.toHaveBeenCalled();
	});

	it("writes its placeholder and progress text with an ellipsis character", async () => {
		vi.mocked(categorizeProvider).mockReturnValue(new Promise(() => {}));
		renderManager([channel("Heat", "Action", "movie")]);

		expect(screen.getByPlaceholderText("New category name…")).toBeTruthy();
		fireEvent.click(await screen.findByRole("button", { name: /Re-categorize All/ }));
		expect(await screen.findByRole("button", { name: /Categorizing…/ })).toBeTruthy();
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
