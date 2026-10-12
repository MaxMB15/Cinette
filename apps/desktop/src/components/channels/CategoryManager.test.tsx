// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "@tauri-apps/plugin-dialog";
import type { GroupHierarchyEntry } from "@/lib/types";
import {
	categorizeProvider,
	deleteGroupHierarchy,
	deleteSuperCategory,
	fixUncategorizedGroups,
	getGeminiApiKey,
	getGroupHierarchy,
	renameSuperCategory,
	reorderGroupHierarchyEntry,
	updateGroupHierarchyEntry,
} from "@/lib/tauri";
import { makeChannel } from "@/test/channel-fixtures";
import { CategoryManager } from "./CategoryManager";

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

vi.mock("@tauri-apps/plugin-dialog", () => ({
	ask: vi.fn(),
}));

const movie = (id: string, name: string, groupTitle: string) =>
	makeChannel({ id, name, groupTitle, contentType: "movie" });

const channels = [
	movie("m1", "Heat", "Action"),
	movie("m2", "Ronin", "Action"),
	movie("m3", "Moonlight", "Drama"),
	movie("m4", "Coco", "Kids"),
	movie("m5", "Free Solo", "Documentary"),
	makeChannel({ id: "l1", name: "News 24", groupTitle: "News" }),
];

const entry = (
	groupName: string,
	superCategory: string | null,
	sortOrder: number
): GroupHierarchyEntry => ({
	providerId: "p1",
	contentType: "movie",
	groupName,
	superCategory,
	sortOrder,
	isUserOverride: false,
});

/** Films holds Action and Drama, Family holds Kids, and Documentary has no category. */
const hierarchy = [
	entry("Action", "Films", 0),
	entry("Drama", "Films", 1),
	entry("Kids", "Family", 1000),
	entry("Documentary", null, 2000),
];

const onClose = vi.fn();
const onHierarchyChanged = vi.fn();

/** Lets the hierarchy load, and any handler waiting on the mocks, finish. */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const renderManager = async (saved: GroupHierarchyEntry[] = hierarchy) => {
	vi.mocked(getGroupHierarchy).mockResolvedValue(saved);
	render(
		<CategoryManager
			providerId="p1"
			contentType="movie"
			channels={channels}
			onClose={onClose}
			onHierarchyChanged={onHierarchyChanged}
		/>
	);
	await flush();
};

const button = (name: string) => screen.getByRole("button", { name });

const click = async (name: string) => {
	fireEvent.click(button(name));
	await flush();
};

/** The card for one category, found by its heading. */
const card = (name: string) =>
	screen.getByText(name, { selector: "span" }).closest(".rounded-xl") as HTMLElement;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getGeminiApiKey).mockResolvedValue("test-key");
	vi.mocked(ask).mockResolvedValue(true);
	for (const fn of [
		updateGroupHierarchyEntry,
		reorderGroupHierarchyEntry,
		renameSuperCategory,
		deleteSuperCategory,
		deleteGroupHierarchy,
	]) {
		vi.mocked(fn).mockResolvedValue(undefined);
	}
});

describe("CategoryManager counts", () => {
	it("counts the groups and categories it loaded", async () => {
		await renderManager();
		expect(screen.getByText("movie · 4 groups · 2 categories")).toBeInTheDocument();
		expect(within(card("Films")).getByText("2 groups")).toBeInTheDocument();
	});

	it("doesn't make a count of one plural", async () => {
		await renderManager([entry("Action", "Films", 0)]);
		expect(screen.getByText("movie · 1 group · 1 category")).toBeInTheDocument();
		expect(within(card("Films")).getByText("1 group")).toBeInTheDocument();
	});

	it("lists the provider's groups as uncategorized before anything is sorted", async () => {
		await renderManager([]);
		// News is a live group, so the movie list leaves it out.
		expect(screen.getByText("movie · 4 groups · 0 categories")).toBeInTheDocument();
		expect(within(card("Uncategorized")).getByText("4 groups")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "News" })).toBeNull();
		// With no categories there's nothing to assign to.
		expect(screen.queryByRole("button", { name: /Assign All/ })).toBeNull();
	});

	it("shows an empty list when the hierarchy can't be read", async () => {
		vi.mocked(getGroupHierarchy).mockRejectedValue(new Error("db locked"));
		render(
			<CategoryManager
				providerId="p1"
				contentType="movie"
				channels={channels}
				onClose={onClose}
				onHierarchyChanged={onHierarchyChanged}
			/>
		);
		await flush();
		expect(screen.getByText("movie · 0 groups · 0 categories")).toBeInTheDocument();
	});
});

describe("CategoryManager categories", () => {
	it("creates an empty category once, from the button or Enter", async () => {
		await renderManager();
		const name = screen.getByPlaceholderText("New category name...");

		fireEvent.change(name, { target: { value: "  Classics " } });
		await click("Create");
		expect(card("Classics")).toBeInTheDocument();
		expect(name).toHaveValue("");

		fireEvent.change(name, { target: { value: "Classics" } });
		expect(button("Create")).toBeDisabled();
		fireEvent.keyDown(name, { key: "Enter" });
		expect(screen.getAllByText("Classics", { selector: "span" })).toHaveLength(1);

		fireEvent.change(name, { target: { value: "Shorts" } });
		fireEvent.keyDown(name, { key: "Enter" });
		expect(card("Shorts")).toBeInTheDocument();
		expect(screen.getByText("movie · 4 groups · 4 categories")).toBeInTheDocument();
	});

	it("renames a category with the trimmed name", async () => {
		await renderManager();
		fireEvent.click(within(card("Family")).getByRole("button", { name: "Rename" }));
		fireEvent.change(screen.getByDisplayValue("Family"), {
			target: { value: " Kids & Family " },
		});
		await click("Save name");

		expect(renameSuperCategory).toHaveBeenCalledExactlyOnceWith(
			"p1",
			"movie",
			"Family",
			"Kids & Family"
		);
		expect(getGroupHierarchy).toHaveBeenCalledTimes(2);
		expect(onHierarchyChanged).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Save name" })).toBeNull();
	});

	it("leaves the name alone when it's unchanged, blank or cancelled", async () => {
		await renderManager();
		const rename = () =>
			fireEvent.click(within(card("Family")).getByRole("button", { name: "Rename" }));

		rename();
		await click("Save name");
		rename();
		const input = screen.getByDisplayValue("Family");
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		await flush();
		rename();
		await click("Cancel rename");
		rename();
		fireEvent.keyDown(screen.getByDisplayValue("Family"), { key: "Escape" });

		expect(renameSuperCategory).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Save name" })).toBeNull();
	});

	it("shows why a rename failed, until it's dismissed", async () => {
		vi.mocked(renameSuperCategory).mockRejectedValue("name taken");
		await renderManager();
		fireEvent.click(within(card("Family")).getByRole("button", { name: "Rename" }));
		fireEvent.change(screen.getByDisplayValue("Family"), { target: { value: "Films" } });
		await click("Save name");

		expect(screen.getByText("name taken")).toBeInTheDocument();
		await click("dismiss");
		expect(screen.queryByText("name taken")).toBeNull();
	});

	it("deletes a category only after the user agrees", async () => {
		vi.mocked(ask).mockResolvedValueOnce(false);
		await renderManager();
		const remove = () =>
			fireEvent.click(
				within(card("Family")).getByRole("button", { name: "Delete category" })
			);

		remove();
		await flush();
		expect(ask).toHaveBeenCalledWith('Delete "Family"? Groups will become uncategorized.', {
			title: "Delete Category",
			kind: "warning",
		});
		expect(deleteSuperCategory).not.toHaveBeenCalled();

		remove();
		await flush();
		expect(deleteSuperCategory).toHaveBeenCalledExactlyOnceWith("p1", "movie", "Family");
		expect(onHierarchyChanged).toHaveBeenCalledOnce();
	});

	it("moves a category down by renumbering every group", async () => {
		await renderManager();
		const [filmsUp] = screen.getAllByRole("button", { name: "Move up" });
		const downs = screen.getAllByRole("button", { name: "Move down" });
		expect(filmsUp).toBeDisabled();
		expect(downs[1]).toBeDisabled();

		fireEvent.click(downs[0]);
		await flush();

		// Family now comes first, Films second, and the uncategorized group goes last.
		expect(vi.mocked(reorderGroupHierarchyEntry).mock.calls).toEqual([
			["p1", "movie", "Kids", 0],
			["p1", "movie", "Action", 1000],
			["p1", "movie", "Drama", 1001],
			["p1", "movie", "Documentary", 2000],
		]);
		expect(onHierarchyChanged).toHaveBeenCalledOnce();
	});

	it("moves a category up", async () => {
		await renderManager();
		fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1]);
		await flush();
		expect(vi.mocked(reorderGroupHierarchyEntry).mock.calls[0]).toEqual([
			"p1",
			"movie",
			"Kids",
			0,
		]);
	});

	it("resets every category only after the user agrees", async () => {
		await renderManager();
		await click("Reset");
		expect(deleteGroupHierarchy).toHaveBeenCalledExactlyOnceWith("p1", "movie");
		expect(onHierarchyChanged).toHaveBeenCalledOnce();

		vi.mocked(ask).mockResolvedValueOnce(false);
		await click("Reset");
		expect(deleteGroupHierarchy).toHaveBeenCalledOnce();
	});

	it("closes", async () => {
		await renderManager();
		fireEvent.click(button("Close"));
		expect(onClose).toHaveBeenCalledOnce();
	});
});

describe("CategoryManager moving a group", () => {
	it("puts a group at the end of the category it moves to", async () => {
		await renderManager();
		await click("Documentary");
		expect(screen.getByText(/to:$/)).toHaveTextContent('Move "Documentary" to:');
		// It isn't in a category yet, so there's no button to leave one.
		expect(screen.queryByRole("button", { name: "Uncategorized" })).toBeNull();

		await click("Family");
		expect(updateGroupHierarchyEntry).toHaveBeenCalledExactlyOnceWith(
			"p1",
			"movie",
			"Documentary",
			"Family",
			1001
		);
		expect(onHierarchyChanged).toHaveBeenCalledOnce();
		expect(screen.queryByText(/to:$/)).toBeNull();
	});

	it("offers every other category, or no category at all", async () => {
		await renderManager();
		await click("Kids");
		expect(button("Films")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Family" })).toBeNull();

		await click("Uncategorized");
		expect(updateGroupHierarchyEntry).toHaveBeenCalledExactlyOnceWith(
			"p1",
			"movie",
			"Kids",
			null,
			2001
		);
	});

	it("starts an empty category at zero", async () => {
		await renderManager();
		fireEvent.change(screen.getByPlaceholderText("New category name..."), {
			target: { value: "Classics" },
		});
		await click("Create");
		await click("Drama");
		await click("Classics");
		expect(updateGroupHierarchyEntry).toHaveBeenCalledWith(
			"p1",
			"movie",
			"Drama",
			"Classics",
			0
		);
	});

	it("puts the selection down when the group or the cancel button is clicked again", async () => {
		await renderManager();
		await click("Drama");
		await click("Drama");
		expect(screen.queryByText(/to:$/)).toBeNull();

		await click("Drama");
		await click("Cancel move");
		expect(screen.queryByText(/to:$/)).toBeNull();
	});

	it("shows why a move failed", async () => {
		vi.mocked(updateGroupHierarchyEntry).mockRejectedValue("database is locked");
		await renderManager();
		await click("Drama");
		await click("Family");
		expect(screen.getByText("database is locked")).toBeInTheDocument();
	});
});

describe("CategoryManager with Gemini", () => {
	it("asks for a key before sorting anything", async () => {
		vi.mocked(getGeminiApiKey).mockResolvedValue(null);
		await renderManager();
		await click("Re-categorize All");
		expect(
			screen.getByText("No Gemini API key configured. Add one in Settings → AI.")
		).toBeInTheDocument();

		await click("Assign All with AI");
		fireEvent.click(within(card("Family")).getByRole("button", { name: /^AI:/ }));
		await click("Find & Add Groups");
		expect(categorizeProvider).not.toHaveBeenCalled();
		expect(fixUncategorizedGroups).not.toHaveBeenCalled();
	});

	it("sorts every group with a few of its titles", async () => {
		const sorted = [entry("Action", "Thrillers", 0)];
		vi.mocked(categorizeProvider).mockResolvedValue(sorted);
		await renderManager();
		await click("Re-categorize All");

		expect(categorizeProvider).toHaveBeenCalledExactlyOnceWith("p1", "movie", "test-key", [
			["Action", ["Heat", "Ronin"]],
			["Drama", ["Moonlight"]],
			["Kids", ["Coco"]],
			["Documentary", ["Free Solo"]],
		]);
		expect(card("Thrillers")).toBeInTheDocument();
		expect(screen.queryByText("Films")).toBeNull();
		expect(onHierarchyChanged).toHaveBeenCalledOnce();
		expect(button("Re-categorize All")).toBeEnabled();
	});

	it("shows why sorting failed", async () => {
		vi.mocked(categorizeProvider).mockRejectedValue("quota exceeded");
		await renderManager();
		await click("Re-categorize All");
		expect(screen.getByText("quota exceeded")).toBeInTheDocument();
		expect(onHierarchyChanged).not.toHaveBeenCalled();
	});

	it("assigns the uncategorized groups to the existing categories", async () => {
		vi.mocked(fixUncategorizedGroups).mockResolvedValue([
			...hierarchy.slice(0, 3),
			entry("Documentary", "Films", 2),
		]);
		await renderManager();
		await click("Assign All with AI");

		expect(fixUncategorizedGroups).toHaveBeenCalledExactlyOnceWith(
			"p1",
			"movie",
			"test-key",
			[["Documentary", ["Free Solo"]]],
			["Films", "Family"]
		);
		expect(screen.queryByText("Uncategorized")).toBeNull();
		expect(onHierarchyChanged).toHaveBeenCalledOnce();
	});

	it("shows why assigning failed", async () => {
		vi.mocked(fixUncategorizedGroups).mockRejectedValue("bad reply");
		await renderManager();
		await click("Assign All with AI");
		expect(screen.getByText("bad reply")).toBeInTheDocument();
	});

	it("fills one category from all the groups outside it", async () => {
		vi.mocked(fixUncategorizedGroups).mockResolvedValue(hierarchy);
		await renderManager();
		fireEvent.click(within(card("Family")).getByRole("button", { name: /^AI:/ }));
		expect(screen.getByText(/^AI: Add groups to/)).toHaveTextContent(
			'AI: Add groups to "Family"'
		);

		await click("Find & Add Groups");
		expect(fixUncategorizedGroups).toHaveBeenCalledExactlyOnceWith(
			"p1",
			"movie",
			"test-key",
			[
				["Action", ["Heat", "Ronin"]],
				["Drama", ["Moonlight"]],
				["Documentary", ["Free Solo"]],
			],
			["Family"]
		);
		expect(onHierarchyChanged).toHaveBeenCalledOnce();
		expect(screen.queryByText(/^AI: Add groups to/)).toBeNull();
	});

	it("says so when no group is left to add", async () => {
		await renderManager([entry("Action", "Films", 0)]);
		fireEvent.click(within(card("Films")).getByRole("button", { name: /^AI:/ }));
		await click("Find & Add Groups");
		expect(screen.getByText("No other groups available to assign.")).toBeInTheDocument();
		expect(fixUncategorizedGroups).not.toHaveBeenCalled();
		expect(screen.queryByText(/^AI: Add groups to/)).toBeNull();
	});

	it("keeps the panel open when filling a category fails", async () => {
		vi.mocked(fixUncategorizedGroups).mockRejectedValue("bad reply");
		await renderManager();
		fireEvent.click(within(card("Family")).getByRole("button", { name: /^AI:/ }));
		await click("Find & Add Groups");
		expect(screen.getByText("bad reply")).toBeInTheDocument();
		expect(button("Find & Add Groups")).toBeEnabled();
	});

	it("closes the panel from either button", async () => {
		await renderManager();
		const open = () =>
			fireEvent.click(within(card("Family")).getByRole("button", { name: /^AI:/ }));

		open();
		await click("Close AI panel");
		expect(screen.queryByText(/^AI: Add groups to/)).toBeNull();

		open();
		await click("Cancel");
		expect(screen.queryByText(/^AI: Add groups to/)).toBeNull();
	});
});
