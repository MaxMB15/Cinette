// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Routes, Route } from "react-router";
import type { LayoutMode } from "@/lib/types";

const platform = vi.hoisted(() => ({ layoutMode: "desktop" as LayoutMode, controller: true }));

vi.mock("@/lib/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/platform")>()),
	controlsOthers: () => platform.controller,
}));

vi.mock("@/hooks/usePlatform", () => ({
	usePlatform: () => ({ platform: "ios", layoutMode: platform.layoutMode }),
}));

vi.mock("@/lib/tauri", () => ({
	mpvSetVisible: vi.fn().mockResolvedValue(undefined),
}));

// Remote control has tests of its own. These show where the layout puts it.
vi.mock("@/components/remote/RemoteControls", () => ({
	DevicesButton: () => <button type="button">Devices</button>,
	RemoteBar: () => <p>Remote bar</p>,
	ControllersBar: () => <p>Controllers bar</p>,
	ProvidersAddedNotice: () => <p>Providers added</p>,
}));

import { AppLayout } from "./AppLayout";
import { FullscreenContext } from "@/lib/fullscreen-context";
import { mpvSetVisible } from "@/lib/tauri";

const mounts = vi.fn();

const Page = () => {
	useEffect(() => {
		mounts();
	}, []);
	return <p>page</p>;
};

const tree = (path: string) => (
	<MemoryRouter initialEntries={[path]}>
		<Routes>
			<Route element={<AppLayout />}>
				<Route path="*" element={<Page />} />
			</Route>
		</Routes>
	</MemoryRouter>
);

describe("AppLayout", () => {
	afterEach(() => {
		cleanup();
		mounts.mockClear();
		vi.mocked(mpvSetVisible).mockClear();
		platform.layoutMode = "desktop";
	});

	it("keeps the page mounted when an iPad switches between layouts", () => {
		const { rerender } = render(tree("/player"));
		expect(mounts).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("complementary")).not.toBeNull();

		platform.layoutMode = "mobile";
		rerender(tree("/player"));
		expect(screen.queryByRole("complementary")).toBeNull();

		platform.layoutMode = "tablet";
		rerender(tree("/player"));
		expect(screen.queryByRole("complementary")).not.toBeNull();
		expect(mounts).toHaveBeenCalledTimes(1);
	});

	it("shows the tab bar on a phone except in the player", () => {
		platform.layoutMode = "mobile";
		render(tree("/"));
		expect(screen.getByRole("navigation").className).not.toContain("hidden");
		cleanup();
		render(tree("/player"));
		expect(screen.getByRole("navigation").className).toContain("hidden");
	});

	it("hides the sidebar for a full screen player only", () => {
		platform.layoutMode = "tablet";
		const fullscreen = (path: string) => (
			<FullscreenContext.Provider value={{ isFullscreen: true, setFullscreen: () => {} }}>
				{tree(path)}
			</FullscreenContext.Provider>
		);
		render(fullscreen("/player"));
		expect(screen.getByRole("complementary").className).toContain("hidden");
		cleanup();
		render(fullscreen("/"));
		expect(screen.getByRole("complementary").className).not.toContain("hidden");
	});

	it("shows the native video view only while the player page is open", () => {
		render(tree("/"));
		expect(mpvSetVisible).toHaveBeenLastCalledWith(false);

		fireEvent.click(screen.getByRole("link", { name: "Player" }));
		expect(mpvSetVisible).toHaveBeenLastCalledWith(true);

		fireEvent.click(screen.getByRole("link", { name: "Channels" }));
		expect(mpvSetVisible).toHaveBeenLastCalledWith(false);
		expect(mounts).toHaveBeenCalledTimes(1);
	});

	it("gives a TV a side menu that marks the open page", () => {
		platform.layoutMode = "tv";
		render(tree("/playlists"));

		expect(screen.getByText("page")).toBeInTheDocument();
		const links = screen.getAllByRole("link");
		expect(links.map((link) => link.textContent)).toEqual([
			"Channels",
			"Player",
			"Playlists",
			"Settings",
		]);
		// A remote moves focus from link to link.
		for (const link of links) expect(link).toHaveAttribute("tabindex", "0");

		const playlists = screen.getByRole("link", { name: "Playlists" });
		expect(playlists).toHaveAttribute("aria-current", "page");
		expect(playlists).toHaveClass("bg-primary/10", "text-primary");
		expect(screen.getByRole("link", { name: "Channels" })).not.toHaveClass("bg-primary/10");
		expect(screen.queryByRole("navigation")).toBeNull();
	});

	it("shows the video view on a TV only on the player page", () => {
		platform.layoutMode = "tv";
		render(tree("/player"));
		expect(mpvSetVisible).toHaveBeenLastCalledWith(true);

		fireEvent.click(screen.getByRole("link", { name: "Channels" }));
		expect(mpvSetVisible).toHaveBeenLastCalledWith(false);
	});

	it("gives the page the TV sizes while the TV layout shows", () => {
		platform.layoutMode = "tv";
		const { unmount } = render(tree("/"));
		expect(document.documentElement).toHaveClass("tv");
		expect(window.__cinetteBack).toBeTypeOf("function");

		unmount();
		expect(document.documentElement).not.toHaveClass("tv");
	});

	it("leaves the TV sizes out of the other layouts", () => {
		render(tree("/"));
		expect(document.documentElement).not.toHaveClass("tv");
		expect(window.__cinetteBack).toBeUndefined();
	});

	it("moves the TV menu's highlight to the page it opens", () => {
		platform.layoutMode = "tv";
		render(tree("/"));

		fireEvent.click(screen.getByRole("link", { name: "Settings" }));

		expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
			"aria-current",
			"page"
		);
		expect(screen.getByRole("link", { name: "Channels" })).not.toHaveAttribute("aria-current");
		expect(mounts).toHaveBeenCalledTimes(1);
	});

	describe("remote control", () => {
		afterEach(() => {
			platform.controller = true;
			platform.layoutMode = "desktop";
		});

		it("puts the devices button in the sidebar and the bar above the page", () => {
			render(tree("/"));
			expect(screen.getByRole("button", { name: "Devices" })).toBeInTheDocument();
			expect(screen.getByText("Remote bar")).toBeInTheDocument();
			expect(screen.getByText("Controllers bar")).toBeInTheDocument();
			expect(screen.getByText("Providers added")).toBeInTheDocument();
			expect(screen.getByText("page")).toBeInTheDocument();
		});

		it("puts the devices button in a phone's tab bar, beside the pages", () => {
			platform.layoutMode = "mobile";
			render(tree("/"));
			const tabs = screen.getByRole("navigation");
			expect(within(tabs).getByRole("button", { name: "Devices" })).toBeInTheDocument();
			expect(within(tabs).getByRole("link", { name: "Settings" })).toBeInTheDocument();
			expect(screen.getByText("Remote bar")).toBeInTheDocument();
			expect(screen.getByText("Controllers bar")).toBeInTheDocument();
			expect(screen.getByText("Providers added")).toBeInTheDocument();
		});

		it("leaves both bars off a phone's player, which keeps the whole screen", () => {
			platform.layoutMode = "mobile";
			const { unmount } = render(tree("/player"));
			expect(screen.queryByText("Remote bar")).toBeNull();
			expect(screen.queryByText("Controllers bar")).toBeNull();
			expect(screen.queryByText("Providers added")).toBeNull();
			expect(screen.getByText("page")).toBeInTheDocument();
			unmount();
			// The sidebar layout keeps them on the player.
			platform.layoutMode = "desktop";
			render(tree("/player"));
			expect(screen.getByText("Remote bar")).toBeInTheDocument();
			expect(screen.getByText("Controllers bar")).toBeInTheDocument();
			expect(screen.getByText("Providers added")).toBeInTheDocument();
		});

		it("shows a device that's only controlled who controls it, and nothing to control others with", () => {
			platform.controller = false;
			render(tree("/"));
			expect(screen.queryByRole("button", { name: "Devices" })).toBeNull();
			expect(screen.queryByText("Remote bar")).toBeNull();
			expect(screen.getByText("Controllers bar")).toBeInTheDocument();
		});

		it("shows a TV's controllers above every page but the player", () => {
			platform.layoutMode = "tv";
			platform.controller = false;
			const { unmount } = render(tree("/settings"));
			expect(screen.getByText("Controllers bar")).toBeInTheDocument();
			expect(screen.getByText("page")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Devices" })).toBeNull();
			unmount();
			render(tree("/player"));
			expect(screen.queryByText("Controllers bar")).toBeNull();
			expect(screen.queryByText("Providers added")).toBeNull();
			expect(screen.getByText("page")).toBeInTheDocument();
		});
	});
});
