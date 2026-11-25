// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const sessions = vi.hoisted(() => ({ list: [] as { connected: boolean }[] }));
vi.mock("@/hooks/useRemoteTarget", () => ({
	useRemoteSessions: () => sessions.list,
	usePlayingOnTarget: vi.fn(),
}));

import { usePlayingOnTarget } from "@/hooks/useRemoteTarget";
import { PlayingOnTarget } from "./PlayingOnTarget";

const renderAt = (path: string) =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<PlayingOnTarget />
		</MemoryRouter>
	);

afterEach(() => {
	vi.clearAllMocks();
});

describe("PlayingOnTarget", () => {
	it("follows mpv off the player page while a controller is connected", () => {
		sessions.list = [{ connected: false }, { connected: true }];
		renderAt("/settings");
		expect(usePlayingOnTarget).toHaveBeenCalled();
	});

	it("does nothing with no controller connected", () => {
		sessions.list = [{ connected: false }];
		renderAt("/settings");
		expect(usePlayingOnTarget).not.toHaveBeenCalled();
	});

	it("leaves the player page to report itself", () => {
		sessions.list = [{ connected: true }];
		renderAt("/player");
		expect(usePlayingOnTarget).not.toHaveBeenCalled();
	});
});
