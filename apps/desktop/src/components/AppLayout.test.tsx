// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { LayoutMode } from "@/lib/types";

const platform = vi.hoisted(() => ({ layoutMode: "desktop" as LayoutMode }));

vi.mock("@/hooks/usePlatform", () => ({
	usePlatform: () => ({ platform: "ios", layoutMode: platform.layoutMode }),
}));

vi.mock("@/lib/tauri", () => ({
	mpvSetVisible: vi.fn().mockResolvedValue(undefined),
}));

import { AppLayout } from "./AppLayout";

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
});
