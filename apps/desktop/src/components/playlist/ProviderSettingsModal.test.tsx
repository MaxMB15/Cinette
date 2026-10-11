// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Provider } from "@/lib/types";

vi.mock("@/lib/tauri", () => ({
	refreshEpg: vi.fn(),
	setEpgUrl: vi.fn(),
	detectEpgUrl: vi.fn(),
}));

import { ProviderSettingsModal } from "./ProviderSettingsModal";

const provider: Provider = {
	id: "p1",
	name: "My IPTV",
	type: "xtream",
	url: "http://example.com:8080",
	username: "me",
	password: "secret",
	channelCount: 12,
};

const renderModal = () => {
	const onClose = vi.fn();
	render(
		<ProviderSettingsModal
			provider={provider}
			onClose={onClose}
			onRefreshNow={vi.fn()}
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

	it("closes on Escape", () => {
		const onClose = renderModal();
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
