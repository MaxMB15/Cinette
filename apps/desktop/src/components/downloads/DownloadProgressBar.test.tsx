// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeDownload } from "@/test/channel-fixtures";
import type { DownloadRecord } from "@/lib/types";
import { DownloadProgressBar } from "./DownloadProgressBar";

const renderBar = (overrides: Partial<DownloadRecord>) => {
	render(<DownloadProgressBar download={makeDownload({ title: "Sintel", ...overrides })} />);
	const bar = screen.getByRole("progressbar", { name: "Downloading Sintel" });
	return { bar, fill: bar.firstElementChild as HTMLElement };
};

describe("DownloadProgressBar", () => {
	it("fills as far as the download has got", () => {
		const { bar, fill } = renderBar({
			status: "downloading",
			totalBytes: 1000,
			downloadedBytes: 250,
		});
		expect(bar).toHaveAttribute("aria-valuenow", "25");
		expect(fill).toHaveStyle({ width: "25%" });
		expect(fill).not.toHaveClass("animate-pulse");
	});

	it("stays full when the file grows past the size the server gave", () => {
		const { bar, fill } = renderBar({
			status: "downloading",
			totalBytes: 1000,
			downloadedBytes: 1012,
		});
		expect(bar).toHaveAttribute("aria-valuenow", "100");
		expect(fill).toHaveStyle({ width: "100%" });
	});

	it("pulses across the whole bar while the size is unknown", () => {
		const { bar, fill } = renderBar({
			status: "downloading",
			totalBytes: null,
			downloadedBytes: 105_000_000,
		});
		expect(bar).not.toHaveAttribute("aria-valuenow");
		expect(fill).toHaveStyle({ width: "100%" });
		expect(fill).toHaveClass("animate-pulse", "motion-reduce:animate-none");
	});

	it("stays empty while the download waits its turn", () => {
		const { bar, fill } = renderBar({ status: "queued", totalBytes: null, downloadedBytes: 0 });
		expect(bar).toHaveAttribute("aria-valuenow", "0");
		expect(bar).toHaveAttribute("aria-valuetext", "Queued");
		expect(fill).toHaveStyle({ width: "0%" });
		expect(fill).not.toHaveClass("animate-pulse");
	});
});
