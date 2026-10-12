// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { OMDB_KEY_FOCUS, useScrollToOmdbKey } from "./useScrollToOmdbKey";

const KeyField = () => {
	const ref = useRef<HTMLInputElement>(null);
	useScrollToOmdbKey(ref);
	const location = useLocation();
	const state = location.state as { focus?: string } | null;
	return (
		<>
			<p>focus={state?.focus ?? "none"}</p>
			<input ref={ref} aria-label="OMDb key" />
		</>
	);
};

const renderSettings = (state: unknown) => {
	const scrollIntoView = vi.fn();
	Element.prototype.scrollIntoView = scrollIntoView;
	render(
		<MemoryRouter initialEntries={[{ pathname: "/settings", state }]}>
			<Routes>
				<Route path="/settings" element={<KeyField />} />
			</Routes>
		</MemoryRouter>
	);
	return { scrollIntoView, input: screen.getByLabelText("OMDb key") };
};

describe("useScrollToOmdbKey", () => {
	afterEach(() => cleanup());

	it("scrolls to the key field and focuses it once, then clears the route state", async () => {
		const { scrollIntoView, input } = renderSettings(OMDB_KEY_FOCUS);
		expect(await screen.findByText("focus=none")).toBeTruthy();
		expect(scrollIntoView).toHaveBeenCalledTimes(1);
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
		expect(document.activeElement).toBe(input);
	});

	it("leaves the page alone when Settings opens normally", () => {
		const { scrollIntoView, input } = renderSettings(null);
		expect(screen.getByText("focus=none")).toBeTruthy();
		expect(scrollIntoView).not.toHaveBeenCalled();
		expect(document.activeElement).not.toBe(input);
	});
});
