// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/lib/types";
import { ProviderSettingsModal } from "./ProviderSettingsModal";

vi.mock("@/lib/tauri", () => ({
	refreshEpg: vi.fn(),
	setEpgUrl: vi.fn(),
	detectEpgUrl: vi.fn(),
}));

vi.mock("@/hooks/useChannels", () => ({
	loadProviderSettings: () => ({
		autoRefresh: false,
		refreshIntervalHours: 24,
		epgAutoRefresh: true,
		epgRefreshIntervalHours: 24,
	}),
	saveProviderSettings: vi.fn(),
}));

import { refreshEpg } from "@/lib/tauri";

const mockRefreshEpg = vi.mocked(refreshEpg);

const provider: Provider = {
	id: "p1",
	name: "Test provider",
	type: "xtream",
	url: "http://example.test",
	username: "user",
	password: "pass",
	channelCount: 3,
	epgUrl: "http://example.test/xmltv.php",
};

const renderModal = () =>
	render(
		<ProviderSettingsModal
			provider={provider}
			onClose={vi.fn()}
			onRefreshNow={vi.fn().mockResolvedValue(undefined)}
			onUpdateProvider={vi.fn().mockResolvedValue(undefined)}
		/>
	);

/** Presses Refresh EPG and waits for the refresh to finish. */
const refreshGuide = async () => {
	fireEvent.click(screen.getByRole("button", { name: "Refresh EPG" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Refresh EPG" })).toBeEnabled());
};

describe("ProviderSettingsModal guide refresh", () => {
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
