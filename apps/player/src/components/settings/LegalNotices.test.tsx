// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LegalNotices, REPO_URL, fileUrl, sourceUrl } from "./LegalNotices";
import { openUrl } from "@/lib/openUrl";

vi.mock("@/lib/openUrl", () => ({ openUrl: vi.fn() }));

describe("LegalNotices", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows the app's names, author, copyright, license and lack of warranty", () => {
		render(<LegalNotices version="1.2.3" />);
		expect(screen.getByText("Created by Max Boksem")).toBeTruthy();
		expect(screen.getByText("Copyright © 2026 Max Boksem")).toBeTruthy();
		expect(screen.getByText(/GNU General Public License version 3/)).toBeTruthy();
		expect(
			screen.getByText(/^Cinette, formerly Max Video Player, is free software\./)
		).toBeTruthy();
		expect(screen.getByText(/It comes with no warranty/)).toBeTruthy();
	});

	it.each([
		["License", "LICENSE"],
		["Additional terms", "NOTICE"],
		["Third-party notices", "THIRD_PARTY_NOTICES.md"],
	])("opens %s from the running version's tag", (label, file) => {
		render(<LegalNotices version="1.2.3" />);
		fireEvent.click(screen.getByRole("button", { name: label }));
		expect(openUrl).toHaveBeenCalledWith(`${REPO_URL}/blob/v1.2.3/${file}`);
	});

	it("links to the source of the running version", () => {
		render(<LegalNotices version="1.2.3" />);
		fireEvent.click(screen.getByRole("button", { name: "Source code" }));
		expect(openUrl).toHaveBeenCalledWith("https://github.com/MaxMB15/Cinette/tree/v1.2.3");
	});

	it("opens the current privacy policy on main", () => {
		render(<LegalNotices version="1.2.3" />);
		fireEvent.click(screen.getByRole("button", { name: "Privacy policy" }));
		expect(openUrl).toHaveBeenCalledWith(`${REPO_URL}/blob/main/docs/privacy.md`);
	});

	it("falls back to main while the version is unknown", () => {
		expect(sourceUrl(undefined)).toBe(REPO_URL);
		expect(sourceUrl("")).toBe(REPO_URL);
		expect(fileUrl("LICENSE", undefined)).toBe(`${REPO_URL}/blob/main/LICENSE`);
		expect(fileUrl("LICENSE", "")).toBe(`${REPO_URL}/blob/main/LICENSE`);
	});
});
