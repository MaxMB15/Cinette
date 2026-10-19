// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DevicePicker } from "./DevicePicker";
import type { PickerEntry } from "@/lib/device-picker";

const entries: PickerEntry[] = [
	{ id: "local", kind: "local", name: "This device" },
	{ id: "cinette:den", kind: "cinette", name: "Den", deviceType: "mac" },
	{ id: "cinette:tv", kind: "cinette", name: "Living Room", deviceType: "fire-tv" },
	{ id: "cast:1", kind: "cast", name: "Bedroom TV", status: { via: "direct" } },
	{
		id: "cast:2",
		kind: "cast",
		name: "Kitchen",
		status: { via: "converted", keep: "on" },
	},
	{
		id: "cast:3",
		kind: "cast",
		name: "Garage",
		status: { blocked: "audioCodec", detail: "dts" },
	},
	{ id: "cast:4", kind: "cast", name: "Attic", status: "checking" },
	{ id: "airplay:1", kind: "airplay", name: "Samsung", opens: true },
];

const picker = (props: Partial<Parameters<typeof DevicePicker>[0]> = {}) => {
	const handlers = {
		onClose: vi.fn(),
		onSelect: vi.fn(),
		onOpenEntry: vi.fn(),
		onOpen: vi.fn(),
	};
	const view = render(
		<DevicePicker open entries={entries} activeId="local" {...handlers} {...props} />
	);
	return { ...handlers, view };
};

const row = (name: RegExp) => screen.getByRole("button", { name });

describe("DevicePicker", () => {
	it("shows nothing while closed", () => {
		const { onOpen } = picker({ open: false });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("says when it opens", () => {
		const { onOpen } = picker();
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("says when it opens later, each time", () => {
		const { onOpen, view } = picker({ open: false });
		const props = {
			entries,
			activeId: "local",
			onClose: () => {},
			onSelect: () => {},
			onOpen,
		};
		view.rerender(<DevicePicker open {...props} />);
		expect(onOpen).toHaveBeenCalledTimes(1);
		view.rerender(<DevicePicker open={false} {...props} />);
		view.rerender(<DevicePicker open {...props} />);
		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it("gives each kind of device its icon", () => {
		picker();
		const icon = (name: RegExp) => row(name).querySelector("svg")?.getAttribute("class");
		expect(icon(/This device/)).toContain("lucide-laptop");
		expect(icon(/Living Room/)).toContain("lucide-tv");
		expect(icon(/Den/)).toContain("lucide-monitor-smartphone");
		expect(icon(/Bedroom TV/)).toContain("lucide-cast");
		expect(icon(/Samsung/)).toContain("lucide-airplay");
	});

	it("gives a Cinette device of unknown type the general icon", () => {
		picker({ entries: [{ id: "cinette:x", kind: "cinette", name: "Odd" }] });
		expect(row(/Odd/).querySelector("svg")?.getAttribute("class")).toContain(
			"lucide-monitor-smartphone"
		);
	});

	it("shows a spinner only while a row is checking", () => {
		picker();
		expect(row(/Attic/).querySelector("svg.animate-spin")).not.toBeNull();
		expect(row(/Bedroom TV/).querySelector("svg.animate-spin")).toBeNull();
	});

	it("puts each row's status on a line of its own", () => {
		picker();
		expect(screen.getByText("Fire TV")).toHaveClass("text-xs");
		expect(screen.getByText("Plays directly")).toHaveClass("text-xs");
	});

	it("groups the rows under their headings, TVs first among Cinette devices", () => {
		picker();
		const dialog = screen.getByRole("dialog", { name: "Play on" });
		const groups = within(dialog).getAllByRole("region");
		expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
			"This device",
			"Cinette devices",
			"Google Cast",
			"AirPlay",
		]);
		expect(
			within(groups[1])
				.getAllByRole("button")
				.map((b) => b.textContent)
		).toEqual(["Living RoomFire TV", "DenMac"]);
		expect(within(groups[0]).queryByRole("heading")).toBeNull();
		for (const heading of ["Cinette devices", "Google Cast", "AirPlay"]) {
			expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
		}
	});

	it("marks the row that plays now", () => {
		picker({ activeId: "cinette:tv" });
		expect(row(/Living Room/)).toHaveAttribute("aria-current", "true");
		expect(within(row(/Living Room/)).getByLabelText("Playing here")).toBeInTheDocument();
		expect(row(/This device/)).not.toHaveAttribute("aria-current");
	});

	it("chooses a row straight away", () => {
		const { onSelect } = picker();
		fireEvent.click(row(/Living Room/));
		fireEvent.click(row(/Bedroom TV/));
		expect(onSelect.mock.calls).toEqual([["cinette:tv"], ["cast:1"]]);
	});

	it("keeps rows that can't be chosen listed with the reason", () => {
		const { onSelect } = picker();
		expect(row(/Garage/)).toHaveAttribute("aria-disabled", "true");
		expect(row(/Garage/)).toHaveTextContent("Can't play this sound (dts)");
		expect(row(/Attic/)).toHaveAttribute("aria-disabled", "true");
		expect(row(/Attic/)).toHaveTextContent("Checking…");
		fireEvent.click(row(/Garage/));
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("asks before a route that keeps this computer busy", () => {
		const { onSelect } = picker();
		fireEvent.click(row(/Kitchen/));
		expect(onSelect).not.toHaveBeenCalled();
		const dialog = screen.getByRole("dialog", { name: "Play on Kitchen?" });
		expect(dialog).toHaveTextContent("needs this computer to stay on");
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		expect(onSelect).toHaveBeenCalledWith("cast:2");
		// The parent here leaves it open, so the list comes back.
		expect(screen.getByRole("dialog", { name: "Play on" })).toBeInTheDocument();
	});

	it("goes back to the list from the confirm step", () => {
		const { onSelect, onClose } = picker();
		fireEvent.click(row(/Kitchen/));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByRole("dialog", { name: "Play on" })).toBeInTheDocument();
		fireEvent.click(row(/Kitchen/));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(screen.getByRole("dialog", { name: "Play on" })).toBeInTheDocument();
		expect(onSelect).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("opens what an opening row opens instead of choosing it", () => {
		const { onSelect, onOpenEntry } = picker();
		fireEvent.click(row(/Samsung/));
		expect(onOpenEntry).toHaveBeenCalledWith("airplay:1");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("closes with Escape", () => {
		const { onClose } = picker();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("works without the optional callbacks", () => {
		render(
			<DevicePicker
				open
				entries={entries}
				activeId="local"
				onClose={() => {}}
				onSelect={() => {}}
			/>
		);
		fireEvent.click(row(/Samsung/));
	});
});
