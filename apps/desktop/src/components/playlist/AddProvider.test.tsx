// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({
		onDragDropEvent: () => Promise.resolve(() => {}),
	}),
}));

import { AddProvider } from "./AddProvider";
import { open } from "@tauri-apps/plugin-dialog";

const renderForm = () =>
	render(<AddProvider onAddM3u={vi.fn()} onAddM3uFile={vi.fn()} onAddXtream={vi.fn()} />);

const showFileMode = () => {
	renderForm();
	fireEvent.click(screen.getByRole("button", { name: "File" }));
	return screen.getByRole("button", { name: /\.m3u file/ });
};

describe("AddProvider", () => {
	beforeEach(() => {
		vi.mocked(open).mockResolvedValue("/Users/me/lists/Sports.m3u8");
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it.each(["Enter", " "])("opens the file picker when %j is pressed on the drop zone", (key) => {
		const dropZone = showFileMode();
		expect(dropZone.tabIndex).toBe(0);
		fireEvent.keyDown(dropZone, { key });
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("names the button that clears the chosen file", async () => {
		fireEvent.click(showFileMode());
		expect(await screen.findByText("Sports.m3u8")).toBeTruthy();
		expect(screen.getByDisplayValue("Sports")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Clear selected file" }));
		await waitFor(() => expect(screen.queryByText("Sports.m3u8")).toBeNull());
	});
});
