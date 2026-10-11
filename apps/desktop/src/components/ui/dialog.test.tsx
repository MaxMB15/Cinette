// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Dialog } from "./dialog";

const renderDialog = (onClose = vi.fn(), onOuterKeyDown = vi.fn()) => {
	render(
		<div onKeyDown={onOuterKeyDown}>
			<button>Behind</button>
			<Dialog onClose={onClose} labelledBy="dialog-title">
				<h2 id="dialog-title">Playlist settings</h2>
				<p>Body text</p>
				<button>Save</button>
			</Dialog>
		</div>
	);
	return { onClose, onOuterKeyDown };
};

describe("Dialog", () => {
	afterEach(() => {
		cleanup();
	});

	it("is a modal dialog named by its title", () => {
		renderDialog();
		const dialog = screen.getByRole("dialog", { name: "Playlist settings" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
	});

	it("can be named without a visible title", () => {
		render(
			<Dialog onClose={vi.fn()} label="Keyboard shortcuts">
				<button>Close</button>
			</Dialog>
		);
		expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
	});

	it("moves focus into the dialog", () => {
		renderDialog();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
	});

	it("closes on Escape without passing the key to the screen behind", () => {
		const { onClose, onOuterKeyDown } = renderDialog();
		fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onOuterKeyDown).not.toHaveBeenCalled();
	});

	it("lets other keys through", () => {
		const { onClose, onOuterKeyDown } = renderDialog();
		fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), { key: "Enter" });
		expect(onClose).not.toHaveBeenCalled();
		expect(onOuterKeyDown).toHaveBeenCalled();
	});

	it("closes on a backdrop click but not on a click inside", () => {
		const { onClose } = renderDialog();
		fireEvent.click(screen.getByText("Body text"));
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("dialog").parentElement!);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
