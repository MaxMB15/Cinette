// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/hooks/useDownloads", () => ({ useDownloads: () => ({ downloads: [] }) }));

import { DownloadHistoryDialog } from "./DownloadHistory";

describe("DownloadHistoryDialog", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders nothing while closed", () => {
		render(<DownloadHistoryDialog open={false} onClose={vi.fn()} />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("is a dialog named by its title that takes focus", () => {
		render(<DownloadHistoryDialog open onClose={vi.fn()} />);
		const dialog = screen.getByRole("dialog", { name: "Download history" });
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("closes on Escape", () => {
		const onClose = vi.fn();
		render(<DownloadHistoryDialog open onClose={onClose} />);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
