// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import type { Provider } from "@/lib/types";

vi.mock("@/hooks/useChannels", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useChannels")>()),
	useChannels: vi.fn(),
}));

// The add form talks to the window and file dialog, which this screen's tests don't need.
vi.mock("./AddProvider", () => ({ AddProvider: () => null }));

import { PlaylistManager } from "./PlaylistManager";
import { useChannels } from "@/hooks/useChannels";

const provider: Provider = {
	id: "p1",
	name: "My IPTV",
	type: "m3u",
	url: "http://example.com/list.m3u",
	channelCount: 12,
};

const removeProvider = vi.fn();
const refreshProvider = vi.fn();

const renderManager = () => {
	vi.mocked(useChannels).mockReturnValue({
		providers: [provider],
		loadM3u: vi.fn(),
		loadM3uFile: vi.fn(),
		loadXtream: vi.fn(),
		removeProvider,
		refreshProvider,
		updateProvider: vi.fn(),
	} as unknown as ReturnType<typeof useChannels>);
	return render(<PlaylistManager />);
};

describe("PlaylistManager", () => {
	beforeEach(() => {
		removeProvider.mockResolvedValue(undefined);
		refreshProvider.mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("asks before removing a provider", () => {
		renderManager();
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(removeProvider).not.toHaveBeenCalled();

		const prompt = screen.getByText(/Remove "My IPTV"\?/).parentElement!;
		fireEvent.click(within(prompt).getByRole("button", { name: "Remove" }));
		expect(removeProvider).toHaveBeenCalledWith("p1");
		expect(screen.queryByText(/Remove "My IPTV"\?/)).toBeNull();
	});

	it("keeps the provider when removal is cancelled", () => {
		renderManager();
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(removeProvider).not.toHaveBeenCalled();
		expect(screen.queryByText(/Remove "My IPTV"\?/)).toBeNull();
	});

	it("shows a failed refresh on the provider card", async () => {
		refreshProvider.mockRejectedValue("Server returned 503");
		renderManager();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("Server returned 503")).toBeTruthy();
	});

	it("shows a failed refresh in the provider settings", async () => {
		refreshProvider.mockRejectedValue("Server returned 503");
		renderManager();
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
		// One under the modal's button and one on the card behind it.
		await waitFor(() => expect(screen.getAllByText("Server returned 503")).toHaveLength(2));
	});
});
