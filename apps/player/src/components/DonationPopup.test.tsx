// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, beforeEach, type MockInstance } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { DonationPopup } from "./DonationPopup";
import { openUrl } from "@/lib/openUrl";

vi.mock("@/lib/openUrl", () => ({ openUrl: vi.fn() }));

const BMC_URL = "https://buymeacoffee.com/MaxMB15";

let frames: FrameRequestCallback[] = [];
let cancelFrame: MockInstance<Window["cancelAnimationFrame"]>;

/** Runs the animation frames the popup asked for. */
const nextFrame = () =>
	act(() => {
		const pending = frames;
		frames = [];
		pending.forEach((cb) => cb(performance.now()));
	});

beforeEach(() => {
	frames = [];
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
		frames.push(cb);
		return frames.length;
	});
	cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.mocked(openUrl).mockClear();
});

describe("DonationPopup", () => {
	it("slides into view on the frame after it mounts", () => {
		const { container } = render(<DonationPopup onDismiss={vi.fn()} />);
		const popup = container.firstElementChild as HTMLElement;

		expect(screen.getByText("Enjoying Cinette?")).toBeInTheDocument();
		expect(popup).toHaveClass("opacity-0", "translate-y-4");

		nextFrame();
		expect(popup).toHaveClass("opacity-100", "translate-y-0");
		expect(popup).not.toHaveClass("opacity-0");
	});

	it("cancels the slide in when it closes before the next frame", () => {
		const { unmount } = render(<DonationPopup onDismiss={vi.fn()} />);
		unmount();
		expect(cancelFrame).toHaveBeenCalledWith(1);
	});

	it.each(["Dismiss donation prompt", "dismiss"])("closes from the %s button", (name) => {
		const onDismiss = vi.fn();
		render(<DonationPopup onDismiss={onDismiss} />);

		fireEvent.click(screen.getByRole("button", { name }));
		expect(onDismiss).toHaveBeenCalledOnce();
		expect(openUrl).not.toHaveBeenCalled();
	});

	it.each(["Donate via Buy Me a Coffee (QR code)", "Support the project"])(
		"opens the donation page from the %s button without closing",
		(name) => {
			const onDismiss = vi.fn();
			render(<DonationPopup onDismiss={onDismiss} />);

			fireEvent.click(screen.getByRole("button", { name }));
			expect(openUrl).toHaveBeenCalledWith(BMC_URL);
			expect(onDismiss).not.toHaveBeenCalled();
		}
	);
});
