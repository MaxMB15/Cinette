// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Link } from "@/lib/remote-control";

const control = vi.hoisted(() => ({
	link: null as Link | null,
	leave: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/hooks/useRemoteControl", () => ({ useRemoteControl: () => control }));
vi.mock("@/components/channels/ChannelList", () => ({
	ChannelList: () => <p>This device's channels</p>,
}));
const platform = vi.hoisted(() => ({ controller: true }));
vi.mock("@/lib/platform", () => ({
	controlsOthers: () => platform.controller,
	getPlatform: () => "macos",
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/components/remote/RemoteCatalog", () => ({
	RemoteCatalog: ({ link, onPlayed }: { link: Link; onPlayed: () => void }) => (
		<button type="button" onClick={onPlayed}>
			{link.name}'s catalog
		</button>
	),
}));
vi.mock("@/components/remote/RemoteLibrary", () => ({
	RemoteLibrary: ({ link, onLeave }: { link: Link; onLeave: () => void }) => (
		<button type="button" onClick={onLeave}>
			{link.name}'s library
		</button>
	),
}));

import { ChannelsPage } from "./ChannelsPage";
import { LEAVE_FAILED } from "./RemoteControls";

const link = (phase: Link["phase"], features: string[] = []) =>
	({ id: 3, deviceId: "tv1", name: "Living Room", phase, features }) as unknown as Link;

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

	it("shows the other device's library in the channel screens when it sends one", () => {
		control.link = link({ phase: "connected" }, ["library"]);
		render(<ChannelsPage />);
		expect(screen.getByText("Living Room's library")).toBeInTheDocument();
		expect(screen.queryByText("Living Room's catalog")).not.toBeInTheDocument();
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

	it("says when disconnecting from the library didn't work, after the library is gone", async () => {
		control.link = link({ phase: "connected" }, ["library"]);
		// The store lets the link go before the backend answers.
		control.leave.mockImplementationOnce(() => {
			control.link = null;
			return Promise.reject(new Error("gone"));
		});
		const { rerender } = render(<ChannelsPage />);
		fireEvent.click(screen.getByText("Living Room's library"));
		rerender(<ChannelsPage />);
		expect(await screen.findByRole("status")).toHaveTextContent(LEAVE_FAILED);
		expect(screen.getByText("This device's channels")).toBeInTheDocument();
		expect(control.leave).toHaveBeenCalledOnce();
	});

	it("keeps this device's channels while still asking", () => {
		control.link = link({ phase: "pending", expiresInMs: 1 });
		render(<ChannelsPage />);
		expect(screen.getByText("This device's channels")).toBeInTheDocument();
	});
});
