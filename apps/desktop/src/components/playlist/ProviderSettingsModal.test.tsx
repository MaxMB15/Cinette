// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import type { Provider } from "@/lib/types";

vi.mock("@/lib/tauri", () => ({
	refreshEpg: vi.fn(),
	setEpgUrl: vi.fn(),
	detectEpgUrl: vi.fn(),
}));

import { ProviderSettingsModal } from "./ProviderSettingsModal";
import { detectEpgUrl, refreshEpg } from "@/lib/tauri";

const mockRefreshEpg = vi.mocked(refreshEpg);

const provider: Provider = {
	id: "p1",
	name: "My IPTV",
	type: "xtream",
	url: "http://example.com:8080",
	username: "me",
	password: "secret",
	channelCount: 12,
};

const renderModal = (onRefreshNow = vi.fn()) => {
	const onClose = vi.fn();
	render(
		<ProviderSettingsModal
			provider={provider}
			onClose={onClose}
			onRefreshNow={onRefreshNow}
			onUpdateProvider={vi.fn()}
		/>
	);
	return onClose;
};

describe("ProviderSettingsModal", () => {
	beforeEach(() => localStorage.clear());

	afterEach(() => {
		cleanup();
	});

	it("is a dialog named by its title that takes focus", () => {
		renderModal();
		const dialog = screen.getByRole("dialog", { name: "Playlist Settings" });
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("reads the saved settings once, not on every render", () => {
		const getItem = vi.spyOn(Storage.prototype, "getItem");
		renderModal();
		fireEvent.change(screen.getByDisplayValue("My IPTV"), { target: { value: "Renamed" } });
		const reads = getItem.mock.calls.filter(([key]) => key === "provider-settings-p1");
		expect(reads).toHaveLength(1);
		getItem.mockRestore();
	});

	it("names each field with its label", () => {
		renderModal();
		const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
		expect(value("Name")).toBe("My IPTV");
		expect(value("Server URL")).toBe("http://example.com:8080");
		expect(value("Username")).toBe("me");
		expect(value("Password")).toBe("secret");
		expect(value("EPG URL")).toBe("");
		expect(value("EPG refresh interval")).toBe("24");
	});

	it("marks the chosen auto-refresh option and shows the interval when on", () => {
		renderModal();
		const group = screen.getByRole("group", { name: "Auto-refresh" });
		const off = within(group).getByRole("button", { name: "Off" });
		const on = within(group).getByRole("button", { name: "On" });
		expect(off.getAttribute("aria-pressed")).toBe("true");
		expect(screen.queryByLabelText("Refresh interval")).toBeNull();

		fireEvent.click(on);
		expect(on.getAttribute("aria-pressed")).toBe("true");
		expect(off.getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByLabelText("Refresh interval")).toBeTruthy();
	});

	it("shows a refresh error under the refresh button", async () => {
		let fail: (e: Error) => void = () => {};
		const onRefreshNow = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
		renderModal(onRefreshNow);

		fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
		const busy = screen.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement;
		expect(busy.disabled).toBe(true);
		expect(onRefreshNow).toHaveBeenCalledWith("p1");

		fail(new Error("Server unreachable"));
		expect(await screen.findByText("Error: Server unreachable")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Refresh now" })).toBeTruthy();
	});

	it("says so when no EPG URL is found", async () => {
		vi.mocked(detectEpgUrl).mockResolvedValue(null);
		renderModal();
		fireEvent.click(screen.getByRole("button", { name: "Auto-detect" }));
		expect(await screen.findByText("No EPG URL detected")).toBeTruthy();
	});

	it("closes on Escape", () => {
		const onClose = renderModal();
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

/** Presses Refresh EPG and waits for the refresh to finish. */
const refreshGuide = async () => {
	fireEvent.click(screen.getByRole("button", { name: "Refresh EPG" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Refresh EPG" })).toBeEnabled());
};

describe("ProviderSettingsModal guide refresh", () => {
	beforeEach(() => localStorage.clear());

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("says nothing after a refresh that saved programs", async () => {
		mockRefreshEpg.mockResolvedValue(120);
		renderModal();
		await refreshGuide();
		expect(mockRefreshEpg).toHaveBeenCalledExactlyOnceWith("p1");
		expect(screen.queryByText(/no programs/)).toBeNull();
	});

	it("says when the guide came back empty, as a note rather than an error", async () => {
		mockRefreshEpg.mockResolvedValueOnce(0);
		renderModal();
		await refreshGuide();
		const note = screen.getByText("The guide came back with no programs, so nothing changed.");
		expect(note).toHaveClass("text-muted-foreground");
		expect(note).not.toHaveClass("text-destructive");

		mockRefreshEpg.mockResolvedValueOnce(120);
		await refreshGuide();
		expect(screen.queryByText(/no programs/)).toBeNull();
	});

	it("shows why a refresh failed, and clears it on the next try", async () => {
		mockRefreshEpg.mockRejectedValueOnce("Failed to fetch EPG: timed out");
		renderModal();
		await refreshGuide();
		expect(screen.getByText("Failed to fetch EPG: timed out")).toBeInTheDocument();

		mockRefreshEpg.mockResolvedValueOnce(120);
		await refreshGuide();
		expect(screen.queryByText("Failed to fetch EPG: timed out")).toBeNull();
	});
});
