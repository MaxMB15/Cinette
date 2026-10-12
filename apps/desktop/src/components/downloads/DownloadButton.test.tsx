// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { DownloadButton } from "./DownloadButton";

const renderComplete = (onRemove: () => Promise<unknown>, removeSummary?: string) =>
	render(
		<DownloadButton
			state="complete"
			onStart={vi.fn()}
			onStop={vi.fn()}
			onRemove={onRemove}
			removeSummary={removeSummary}
		/>
	);

const confirmRemove = () => {
	fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
	fireEvent.click(screen.getByRole("button", { name: "Remove" }));
};

describe("DownloadButton", () => {
	afterEach(cleanup);

	it("removes once the user confirms", async () => {
		const onRemove = vi.fn(() => Promise.resolve());
		renderComplete(onRemove);
		fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
		expect(onRemove).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await act(async () => {});
		expect(onRemove).toHaveBeenCalledOnce();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("says why a download couldn't be removed", async () => {
		renderComplete(() => Promise.reject("Could not delete /a.mkv: denied"));
		confirmRemove();

		const dialog = await screen.findByRole("dialog", { name: "Couldn't remove the download" });
		expect(dialog.textContent).toContain("Could not delete /a.mkv: denied");
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "OK" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("lists what a batch couldn't remove", async () => {
		renderComplete(
			() => Promise.reject("Deleted 1 of 2.\nCould not delete /b.mkv: denied"),
			"2 episodes"
		);
		confirmRemove();

		const dialog = await screen.findByRole("dialog", {
			name: "Couldn't remove every download",
		});
		expect(dialog.textContent).toContain("Deleted 1 of 2.");
		expect(dialog.textContent).toContain("Could not delete /b.mkv: denied");

		// Clicking the backdrop around a notice closes it.
		fireEvent.click(dialog.parentElement!);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("DownloadButton for a changing item", () => {
	afterEach(cleanup);

	/** The player's button, which stays mounted as one episode follows another. */
	const PlayerButton = (props: {
		itemId: string;
		state: "downloading" | "complete" | "idle";
		onStop?: () => void;
		onRemove?: () => Promise<unknown>;
	}) => (
		<DownloadButton
			itemId={props.itemId}
			state={props.state}
			onStart={vi.fn()}
			onStop={props.onStop ?? vi.fn()}
			onRemove={props.onRemove ?? (() => Promise.resolve())}
		/>
	);

	it("closes a confirm left open for the last item", () => {
		const onStop = vi.fn();
		const { rerender } = render(
			<PlayerButton itemId="e1" state="downloading" onStop={onStop} />
		);
		fireEvent.click(screen.getByRole("button", { name: "Downloading" }));
		expect(screen.getByRole("dialog", { name: "Stop download?" })).toBeInTheDocument();

		rerender(<PlayerButton itemId="e2" state="downloading" onStop={onStop} />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onStop).not.toHaveBeenCalled();
	});

	it("keeps a confirm open while the item stays the same", () => {
		const { rerender } = render(<PlayerButton itemId="e1" state="downloading" />);
		fireEvent.click(screen.getByRole("button", { name: "Downloading" }));
		rerender(<PlayerButton itemId="e1" state="downloading" />);
		expect(screen.getByRole("dialog", { name: "Stop download?" })).toBeInTheDocument();
	});

	it("lets go of focus when the item changes", () => {
		const { rerender } = render(<PlayerButton itemId="e1" state="downloading" />);
		const button = screen.getByRole("button", { name: "Downloading" });
		button.focus();
		fireEvent.click(button);
		expect(button).not.toHaveFocus();

		rerender(<PlayerButton itemId="e2" state="idle" />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByRole("button", { name: "Download" })).not.toHaveFocus();
		expect(document.body).toHaveFocus();
	});

	it("keeps focus while the item stays the same", () => {
		const { rerender } = render(<PlayerButton itemId="e1" state="idle" />);
		const button = screen.getByRole("button", { name: "Download" });
		button.focus();
		rerender(<PlayerButton itemId="e1" state="downloading" />);
		expect(button).toHaveFocus();
	});

	it("keeps a failed removal on screen after the next item starts", async () => {
		const { rerender } = render(
			<PlayerButton
				itemId="e1"
				state="complete"
				onRemove={() => Promise.reject("Could not delete /a.mkv: denied")}
			/>
		);
		confirmRemove();
		await screen.findByRole("dialog", { name: "Couldn't remove the download" });

		rerender(<PlayerButton itemId="e2" state="idle" />);
		const dialog = screen.getByRole("dialog", { name: "Couldn't remove the download" });
		expect(dialog.textContent).toContain("Could not delete /a.mkv: denied");
	});

	it("still says a removal failed after the next item starts", async () => {
		let fail: (reason: string) => void = () => {};
		const onRemove = () =>
			new Promise((_resolve, reject) => {
				fail = reject;
			});
		const { rerender } = render(
			<PlayerButton itemId="e1" state="complete" onRemove={onRemove} />
		);
		confirmRemove();
		rerender(<PlayerButton itemId="e2" state="idle" onRemove={onRemove} />);

		await act(async () => fail("Could not delete /a.mkv: denied"));
		const dialog = screen.getByRole("dialog", { name: "Couldn't remove the download" });
		expect(dialog.textContent).toContain("Could not delete /a.mkv: denied");
	});
});
