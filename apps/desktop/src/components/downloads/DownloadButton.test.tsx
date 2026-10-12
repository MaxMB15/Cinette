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

		// Clicking outside a notice closes it.
		fireEvent.click(dialog.parentElement!);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
