// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelLogo } from "./ChannelLogo";

describe("ChannelLogo", () => {
	afterEach(cleanup);

	it("shows the fallback when there is no URL", () => {
		render(<ChannelLogo fallback={<span>N</span>} />);
		expect(screen.getByText("N")).toBeInTheDocument();
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("swaps the image for the fallback when it fails to load", () => {
		render(<ChannelLogo url="http://logo.test/a.png" alt="News" fallback={<span>N</span>} />);
		fireEvent.error(screen.getByRole("img", { name: "News" }));
		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByText("N")).toBeInTheDocument();
	});

	it("does not retry a URL that already failed after a remount", () => {
		const url = "http://logo.test/broken.png";
		const { unmount } = render(<ChannelLogo url={url} alt="News" fallback={<span>N</span>} />);
		fireEvent.error(screen.getByRole("img", { name: "News" }));
		unmount();

		render(<ChannelLogo url={url} alt="News" fallback={<span>N</span>} />);
		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByText("N")).toBeInTheDocument();
	});

	it("tries a new URL after the old one failed", () => {
		const { rerender } = render(
			<ChannelLogo url="http://logo.test/old.png" alt="News" fallback={<span>N</span>} />
		);
		fireEvent.error(screen.getByRole("img", { name: "News" }));
		expect(screen.queryByRole("img")).toBeNull();

		rerender(
			<ChannelLogo url="http://logo.test/new.png" alt="News" fallback={<span>N</span>} />
		);
		expect(screen.getByRole("img", { name: "News" })).toHaveAttribute(
			"src",
			"http://logo.test/new.png"
		);
	});
});
