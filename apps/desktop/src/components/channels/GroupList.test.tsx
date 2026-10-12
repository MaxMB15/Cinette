// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupList } from "./GroupList";

const renderList = (pinned: string[]) => {
	const onSelectGroup = vi.fn();
	const onTogglePin = vi.fn();
	render(
		<GroupList
			groups={["News", "Sports"]}
			categories={[
				{ id: "News", name: "News", channelCount: 4 },
				{ id: "Sports", name: "Sports", channelCount: 2 },
			]}
			onSelectGroup={onSelectGroup}
			isPinned={(name) => pinned.includes(name)}
			onTogglePin={onTogglePin}
		/>
	);
	return { onSelectGroup, onTogglePin };
};

describe("GroupList pin buttons", () => {
	afterEach(cleanup);

	it("names each pin button and reports whether it is pinned", () => {
		renderList(["Sports"]);
		const pin = screen.getByRole("button", { name: "Pin News" });
		const pinned = screen.getByRole("button", { name: "Pin Sports" });
		expect(pin).toHaveAttribute("aria-pressed", "false");
		expect(pinned).toHaveAttribute("aria-pressed", "true");
	});

	it("toggles the pin without opening the group", () => {
		const { onSelectGroup, onTogglePin } = renderList([]);
		const pin = screen.getByRole("button", { name: "Pin News" });

		fireEvent.click(pin);
		expect(onTogglePin).toHaveBeenCalledExactlyOnceWith("News");
		expect(onSelectGroup).not.toHaveBeenCalled();
	});

	it("lets a pin click reach listeners further up", () => {
		renderList([]);
		const onDocumentClick = vi.fn();
		document.addEventListener("click", onDocumentClick);
		try {
			fireEvent.click(screen.getByRole("button", { name: "Pin News" }));
		} finally {
			document.removeEventListener("click", onDocumentClick);
		}
		expect(onDocumentClick).toHaveBeenCalledOnce();
	});

	it("opens the group once from its button or from the rest of the row", () => {
		const { onSelectGroup } = renderList([]);
		fireEvent.click(screen.getByRole("button", { name: /^News/ }));
		expect(onSelectGroup).toHaveBeenCalledExactlyOnceWith("News");

		fireEvent.click(screen.getByRole("button", { name: /^News/ }).parentElement!);
		expect(onSelectGroup).toHaveBeenCalledTimes(2);
	});

	it("keeps the pin out of the group's button", () => {
		renderList([]);
		const open = screen.getByRole("button", { name: /^News/ });
		expect(open.tagName).toBe("BUTTON");
		expect(open.contains(screen.getByRole("button", { name: "Pin News" }))).toBe(false);
	});
});
