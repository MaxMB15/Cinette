// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

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

	it("marks the chosen playlist source", () => {
		renderForm();
		const group = screen.getByRole("group", { name: "Playlist source" });
		const url = within(group).getByRole("button", { name: "URL" });
		const file = within(group).getByRole("button", { name: "File" });
		expect(url.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(file);
		expect(file.getAttribute("aria-pressed")).toBe("true");
		expect(url.getAttribute("aria-pressed")).toBe("false");
	});

	it("marks the chosen provider type", () => {
		renderForm();
		const group = screen.getByRole("group", { name: "Provider type" });
		const m3u = within(group).getByRole("button", { name: "M3U Playlist" });
		const xtream = within(group).getByRole("button", { name: "Xtream Codes" });
		expect(m3u.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(xtream);
		expect(xtream.getAttribute("aria-pressed")).toBe("true");
		expect(m3u.getAttribute("aria-pressed")).toBe("false");
	});

	it("names the provider name and playlist URL fields", () => {
		renderForm();
		expect(screen.getByLabelText("Provider name")).toBe(
			screen.getByPlaceholderText("Provider name (optional)")
		);
		const url = screen.getByLabelText("Playlist URL") as HTMLInputElement;
		expect(url).toBe(screen.getByPlaceholderText("M3U playlist URL"));
		expect(url.required).toBe(true);
	});

	it("names the Xtream fields and requires all of them", () => {
		renderForm();
		fireEvent.click(screen.getByRole("button", { name: "Xtream Codes" }));
		for (const label of ["Server URL", "Username", "Password"]) {
			expect((screen.getByLabelText(label) as HTMLInputElement).required).toBe(true);
		}
		expect(screen.getByPlaceholderText("Server URL (e.g. http://example.com:8080)")).toBe(
			screen.getByLabelText("Server URL")
		);
	});

	it("names the button that clears the chosen file", async () => {
		fireEvent.click(showFileMode());
		expect(await screen.findByText("Sports.m3u8")).toBeTruthy();
		expect(screen.getByDisplayValue("Sports")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Clear selected file" }));
		await waitFor(() => expect(screen.queryByText("Sports.m3u8")).toBeNull());
	});
});
