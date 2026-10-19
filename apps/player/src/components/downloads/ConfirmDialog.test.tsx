// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useRef, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { isInside } from "@/lib/hotkeys";
import { ConfirmDialog } from "./ConfirmDialog";

/** A sheet that slides in with `translate`, which would clip a fixed dialog inside it. */
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
		<div data-testid="sheet" style={{ translate: "0 0" }}>
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

	it("keeps its keys from a player that checks where they came from", () => {
		// React passes keys from the portal to the player's handler, like the
		// player's own `onKeyDown`, so the player has to check.
		const onPlayerKey = vi.fn();
		const Player = () => {
			const ref = useRef<HTMLDivElement>(null);
			return (
				<div
					ref={ref}
					onKeyDown={(e) => {
						if (isInside(ref.current, e.target)) onPlayerKey(e.key);
					}}
				>
					<Sheet />
				</div>
			);
		};
		render(<Player />);
		const opener = screen.getByRole("button", { name: "Download season" });
		fireEvent.keyDown(opener, { key: "f" });
		expect(onPlayerKey).toHaveBeenCalledExactlyOnceWith("f");

		openFrom(opener);
		fireEvent.keyDown(document.activeElement!, { key: "f" });
		fireEvent.keyDown(document.activeElement!, { key: " " });
		expect(onPlayerKey).toHaveBeenCalledOnce();
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

	it("closes a notice with its one button, Escape or a click outside", () => {
		const onConfirm = vi.fn();
		render(
			<ConfirmDialog
				open
				title="Couldn't remove the download"
				message="The file is in use."
				confirmLabel="OK"
				onConfirm={onConfirm}
			/>
		);
		expect(screen.queryByText("Cancel")).toBeNull();
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		fireEvent.click(screen.getByRole("dialog").parentElement!);
		fireEvent.click(screen.getByText("OK"));
		expect(onConfirm).toHaveBeenCalledTimes(3);
	});

	it("makes the confirm button red when it asks, unless told otherwise, and never for a notice", () => {
		const dialog = (props: { onCancel?: () => void; destructive?: boolean }) => (
			<ConfirmDialog
				open
				title="Remove?"
				message=""
				confirmLabel="Go"
				onConfirm={vi.fn()}
				{...props}
			/>
		);
		const go = () => screen.getByRole("button", { name: "Go" });
		const { rerender } = render(dialog({ onCancel: vi.fn() }));
		expect(go()).toHaveClass("bg-red-600");

		rerender(dialog({ onCancel: vi.fn(), destructive: false }));
		expect(go()).not.toHaveClass("bg-red-600");

		rerender(dialog({}));
		expect(go()).not.toHaveClass("bg-red-600");

		rerender(dialog({ destructive: true }));
		expect(go()).toHaveClass("bg-red-600");
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
