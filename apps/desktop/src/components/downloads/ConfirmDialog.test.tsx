// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const renderInPlayer = (onPlayerKey: () => void, onCancel = vi.fn(), onConfirm = vi.fn()) => {
	render(
		// The player handles its shortcuts on a parent element like this one.
		<div onKeyDown={onPlayerKey}>
			<ConfirmDialog
				open
				title="Stop recording?"
				message="What it recorded so far stays."
				confirmLabel="Stop"
				cancelLabel="Keep recording"
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>
		</div>
	);
	return { onCancel, onConfirm };
};

describe("ConfirmDialog", () => {
	afterEach(cleanup);

	it("is a modal named by its title, with focus on its first button", () => {
		renderInPlayer(vi.fn());
		const dialog = screen.getByRole("dialog", { name: "Stop recording?" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(document.activeElement).toBe(screen.getByText("Keep recording"));
	});

	it("cancels on Escape and keeps keys from the player behind it", () => {
		const onPlayerKey = vi.fn();
		const { onCancel } = renderInPlayer(onPlayerKey);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(document.activeElement!, { key: " " });
		expect(onPlayerKey).not.toHaveBeenCalled();
	});

	it("keeps Tab inside the dialog", () => {
		renderInPlayer(vi.fn());
		const [keep, stop] = [screen.getByText("Keep recording"), screen.getByText("Stop")];
		stop.focus();
		fireEvent.keyDown(stop, { key: "Tab" });
		expect(document.activeElement).toBe(keep);
	});

	it("renders nothing while closed", () => {
		render(
			<ConfirmDialog
				open={false}
				title="Stop recording?"
				message=""
				confirmLabel="Stop"
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
