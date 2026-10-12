// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

/** A sheet that slides in with a transform, which would clip a fixed dialog inside it. */
const Sheet = ({
	onConfirm = vi.fn(),
	notice = false,
}: {
	onConfirm?: () => void;
	notice?: boolean;
}) => {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);
	return (
		<div data-testid="sheet" style={{ transform: "translateY(0)" }}>
			<button onClick={() => setOpen(true)}>Download season</button>
			<ConfirmDialog
				open={open}
				title="Download episodes?"
				message="Download 12 episodes?"
				confirmLabel="Download"
				onConfirm={() => {
					onConfirm();
					close();
				}}
				onCancel={notice ? undefined : close}
			/>
		</div>
	);
};

const openFrom = (opener: HTMLElement) => {
	opener.focus();
	fireEvent.click(opener);
	return screen.getByRole("dialog", { name: "Download episodes?" });
};

describe("ConfirmDialog", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders as a modal outside the sheet that opened it", () => {
		render(<Sheet />);
		const dialog = openFrom(screen.getByRole("button", { name: "Download season" }));
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(screen.getByTestId("sheet").contains(dialog)).toBe(false);
		expect(document.body.contains(dialog)).toBe(true);
	});

	it("moves focus to its first button and back to the opener on close", () => {
		render(<Sheet />);
		const opener = screen.getByRole("button", { name: "Download season" });
		openFrom(opener);
		const cancel = screen.getByRole("button", { name: "Cancel" });
		expect(document.activeElement).toBe(cancel);

		fireEvent.click(cancel);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it("cancels on Escape without the player behind seeing the key", () => {
		const onConfirm = vi.fn();
		const onWindowKeyDown = vi.fn();
		window.addEventListener("keydown", onWindowKeyDown);
		render(<Sheet onConfirm={onConfirm} />);
		openFrom(screen.getByRole("button", { name: "Download season" }));

		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		window.removeEventListener("keydown", onWindowKeyDown);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onWindowKeyDown).not.toHaveBeenCalled();
	});

	it("confirms a notice on Escape", () => {
		const onConfirm = vi.fn();
		render(<Sheet onConfirm={onConfirm} notice />);
		openFrom(screen.getByRole("button", { name: "Download season" }));
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onConfirm).toHaveBeenCalledOnce();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("keeps focus inside while open", () => {
		render(<Sheet />);
		openFrom(screen.getByRole("button", { name: "Download season" }));
		const confirm = screen.getByRole("button", { name: "Download" });
		confirm.focus();
		fireEvent.keyDown(confirm, { key: "Tab" });
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
	});
});
