// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
	LEGAL_COPYRIGHT,
	LEGAL_CREDIT,
	LEGAL_LICENSE,
	LegalNotices,
	REPO_URL,
	fileUrl,
	legalLinks,
	sourceUrl,
} from "./LegalNotices";
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

	it("shows the text another screen can show too", () => {
		render(<LegalNotices />);
		expect(screen.getByText(LEGAL_CREDIT)).toBeTruthy();
		expect(screen.getByText(LEGAL_COPYRIGHT)).toBeTruthy();
		expect(screen.getByText(LEGAL_LICENSE)).toBeTruthy();
	});

	it("gives the credit that NOTICE protects", () => {
		expect(LEGAL_CREDIT).toBe("Created by Max Boksem");
	});

	it("lists the links at the running version's tag, with the policy on main", () => {
		expect(legalLinks("1.2.3")).toEqual([
			{ label: "License", url: `${REPO_URL}/blob/v1.2.3/LICENSE` },
			{ label: "Additional terms", url: `${REPO_URL}/blob/v1.2.3/NOTICE` },
			{ label: "Source code", url: `${REPO_URL}/tree/v1.2.3` },
			{ label: "Third-party notices", url: `${REPO_URL}/blob/v1.2.3/THIRD_PARTY_NOTICES.md` },
			{ label: "Privacy policy", url: `${REPO_URL}/blob/main/docs/privacy.md` },
		]);
	});

	it("lists the links on main while the version is unknown", () => {
		expect(legalLinks()).toEqual([
			{ label: "License", url: `${REPO_URL}/blob/main/LICENSE` },
			{ label: "Additional terms", url: `${REPO_URL}/blob/main/NOTICE` },
			{ label: "Source code", url: REPO_URL },
			{ label: "Third-party notices", url: `${REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md` },
			{ label: "Privacy policy", url: `${REPO_URL}/blob/main/docs/privacy.md` },
		]);
	});
});
