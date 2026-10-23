// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Link } from "@/lib/remote-control";

const control = vi.hoisted(() => ({ link: null as Link | null }));
vi.mock("@/hooks/useRemoteControl", () => ({ useRemoteControl: () => control }));
vi.mock("@/components/channels/ChannelList", () => ({
	ChannelList: () => <p>This device's channels</p>,
}));
const platform = vi.hoisted(() => ({ controller: true }));
vi.mock("@/lib/platform", () => ({ controlsOthers: () => platform.controller }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/components/remote/RemoteCatalog", () => ({
	RemoteCatalog: ({ link, onPlayed }: { link: Link; onPlayed: () => void }) => (
		<button type="button" onClick={onPlayed}>
			{link.name}'s catalog
		</button>
	),
}));

import { ChannelsPage } from "./ChannelsPage";

const link = (phase: Link["phase"]) =>
	({ deviceId: "tv1", name: "Living Room", phase }) as unknown as Link;

describe("ChannelsPage", () => {
	it("shows this device's channels without a link", () => {
		control.link = null;
		render(<ChannelsPage />);
		expect(screen.getByText("This device's channels")).toBeInTheDocument();
	});

	it("shows the other device's catalog while it's connected or reconnecting", () => {
		for (const phase of [
			{ phase: "connected" },
			{ phase: "reconnecting", attempt: 1 },
		] as Link["phase"][]) {
			control.link = link(phase);
			const { unmount } = render(<ChannelsPage />);
			expect(screen.getByText("Living Room's catalog")).toBeInTheDocument();
			unmount();
		}
	});

	it("shows this device's channels where it can't control others", () => {
		platform.controller = false;
		control.link = link({ phase: "connected" });
		render(<ChannelsPage />);
		expect(screen.getByText("This device's channels")).toBeInTheDocument();
		platform.controller = true;
	});

	it("opens the player page once the other device takes an item", () => {
		navigate.mockClear();
		control.link = link({ phase: "connected" });
		render(<ChannelsPage />);
		expect(navigate).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("Living Room's catalog"));
		expect(navigate).toHaveBeenCalledWith("/player");
	});

	it("keeps this device's channels while still asking", () => {
		control.link = link({ phase: "pending", expiresInMs: 1 });
		render(<ChannelsPage />);
		expect(screen.getByText("This device's channels")).toBeInTheDocument();
	});
});
