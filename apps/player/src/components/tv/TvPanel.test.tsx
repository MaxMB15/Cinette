// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TvPanel } from "./TvPanel";

const renderPanel = (props: Partial<Parameters<typeof TvPanel>[0]> = {}) => {
	const onClose = vi.fn();
	render(
		<TvPanel title="Source" onClose={onClose} {...props}>
			<button type="button">Pick</button>
		</TvPanel>
	);
	return { onClose };
};

describe("TvPanel", () => {
	it("names the dialog and heads it with the title", () => {
		renderPanel();
		expect(screen.getByRole("dialog", { name: "Source" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Source" })).toBeInTheDocument();
	});

	it("takes the focus onto what's inside it", () => {
		renderPanel();
		expect(screen.getByRole("button", { name: "Pick" })).toHaveFocus();
	});

	it("sits on the right unless it's told otherwise, without a dimmed backdrop", () => {
		renderPanel();
		const overlay = screen.getByRole("dialog").parentElement;
		expect(overlay).toHaveClass("justify-end", "bg-transparent");
		expect(overlay).not.toHaveClass("justify-start");
	});

	it("sits on the left when asked", () => {
		renderPanel({ side: "left" });
		expect(screen.getByRole("dialog").parentElement).toHaveClass("justify-start");
	});

	it("closes on Back", () => {
		const { onClose } = renderPanel();
		fireEvent.keyDown(screen.getByRole("button", { name: "Pick" }), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
