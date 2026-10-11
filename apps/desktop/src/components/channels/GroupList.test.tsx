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
		const unpin = screen.getByRole("button", { name: "Unpin Sports" });
		expect(pin).toHaveAttribute("aria-pressed", "false");
		expect(unpin).toHaveAttribute("aria-pressed", "true");
	});

	it("toggles the pin without opening the group", () => {
		const { onSelectGroup, onTogglePin } = renderList([]);
		const pin = screen.getByRole("button", { name: "Pin News" });

		fireEvent.click(pin);
		fireEvent.keyDown(pin, { key: "Enter" });
		expect(onTogglePin).toHaveBeenCalledWith("News");
		expect(onSelectGroup).not.toHaveBeenCalled();
	});
});
