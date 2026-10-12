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

	it("stays open when a control inside keeps Escape", () => {
		const onClose = vi.fn();
		const onOuterKeyDown = vi.fn();
		render(
			<div onKeyDown={onOuterKeyDown}>
				<Dialog onClose={onClose} label="Rename">
					<input
						aria-label="Name"
						onKeyDown={(e) => e.key === "Escape" && e.preventDefault()}
					/>
				</Dialog>
			</div>
		);
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
		expect(onOuterKeyDown).not.toHaveBeenCalled();
	});

	it("lets other keys through", () => {
		const { onClose, onOuterKeyDown } = renderDialog();
		fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), { key: "Enter" });
		expect(onClose).not.toHaveBeenCalled();
		expect(onOuterKeyDown).toHaveBeenCalled();
	});

	it("closes on Escape when focus has left the dialog", () => {
		const { onClose, onOuterKeyDown } = renderDialog();
		const onWindowKeyDown = vi.fn();
		window.addEventListener("keydown", onWindowKeyDown);

		screen.getByRole("button", { name: "Behind" }).focus();
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		(document.activeElement as HTMLElement).blur();
		fireEvent.keyDown(document.body, { key: "Escape" });

		window.removeEventListener("keydown", onWindowKeyDown);
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onOuterKeyDown).not.toHaveBeenCalled();
		expect(onWindowKeyDown).not.toHaveBeenCalled();
	});

	it("closes only the top dialog when one is open over another", () => {
		const onCloseBottom = vi.fn();
		const onCloseTop = vi.fn();
		const Stack = ({ top }: { top: boolean }) => (
			<>
				<Dialog onClose={onCloseBottom} label="Bottom">
					<button>Bottom button</button>
				</Dialog>
				{top && (
					<Dialog onClose={onCloseTop} label="Top">
						<button>Top button</button>
					</Dialog>
				)}
			</>
		);
		const { rerender } = render(<Stack top={false} />);
		rerender(<Stack top />);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Top button" }));

		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		(document.activeElement as HTMLElement).blur();
		fireEvent.keyDown(document.body, { key: "Escape" });
		expect(onCloseTop).toHaveBeenCalledTimes(2);
		expect(onCloseBottom).not.toHaveBeenCalled();

		rerender(<Stack top={false} />);
		fireEvent.keyDown(document.body, { key: "Escape" });
		expect(onCloseBottom).toHaveBeenCalledTimes(1);
	});

	it("closes on a backdrop click but not on a click inside", () => {
		const { onClose } = renderDialog();
		fireEvent.click(screen.getByText("Body text"));
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("dialog").parentElement!);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("keeps clicks inside from reaching the screen behind", () => {
		const onOuterClick = vi.fn();
		render(
			<div onClick={onOuterClick}>
				<Dialog onClose={vi.fn()} label="Remove download?">
					<button>Remove</button>
				</Dialog>
			</div>
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(screen.getByRole("dialog").parentElement!);
		expect(onOuterClick).not.toHaveBeenCalled();
	});
});
