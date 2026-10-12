// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category, PinnedGroup } from "@/lib/types";
import { PinnedGroupsRow } from "./PinnedGroupsRow";

const pin = (groupName: string, sortOrder = 0): PinnedGroup => ({
	providerId: "p1",
	contentType: "live",
	groupName,
	sortOrder,
});

const categories: Category[] = [{ id: "Football", name: "Football", channelCount: 7 }];

const renderRow = (pinnedGroups: PinnedGroup[], selectedGroup: string | null = null) => {
	const onSelectGroup = vi.fn();
	const onUnpin = vi.fn();
	const view = render(
		<PinnedGroupsRow
			pinnedGroups={pinnedGroups}
			categories={categories}
			selectedGroup={selectedGroup}
			onSelectGroup={onSelectGroup}
			onUnpin={onUnpin}
		/>
	);
	return { ...view, onSelectGroup, onUnpin };
};

describe("PinnedGroupsRow", () => {
	afterEach(cleanup);

	it("renders nothing when no group is pinned", () => {
		const { container } = renderRow([]);
		expect(container).toBeEmptyDOMElement();
	});

	it("lists the pinned groups in order with their channel counts", () => {
		renderRow([pin("Football"), pin("Tennis", 100)]);
		expect(screen.getByText("Pinned Groups")).toBeInTheDocument();
		const groups = screen
			.getAllByRole("button")
			.filter((b) => !b.getAttribute("aria-label"))
			.map((b) => b.textContent);
		// Tennis has no category entry, so it counts 0 channels.
		expect(groups).toEqual(["Football7", "Tennis0"]);
	});

	it("opens a group when its chip is clicked", () => {
		const { onSelectGroup, onUnpin } = renderRow([pin("Football")]);
		fireEvent.click(screen.getByText("Football"));
		expect(onSelectGroup).toHaveBeenCalledWith("Football");
		expect(onUnpin).not.toHaveBeenCalled();
	});

	it("unpins a group from its own button without opening it", () => {
		const { onSelectGroup, onUnpin } = renderRow([pin("Football"), pin("Tennis", 100)]);
		fireEvent.click(screen.getByRole("button", { name: "Unpin Tennis" }));
		expect(onUnpin).toHaveBeenCalledExactlyOnceWith("Tennis");
		expect(onSelectGroup).not.toHaveBeenCalled();
	});

	it("highlights the selected group", () => {
		renderRow([pin("Football"), pin("Tennis", 100)], "Tennis");
		expect(screen.getByText("Tennis").closest("button")).toHaveClass("bg-primary");
		expect(screen.getByText("Football").closest("button")).not.toHaveClass("bg-primary");
	});
});
