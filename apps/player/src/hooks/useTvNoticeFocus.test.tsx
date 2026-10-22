// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

const os = vi.hoisted(() => ({ platform: "tv" }));
vi.mock("@/lib/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/platform")>()),
	getPlatform: () => os.platform,
}));

import { useTvNoticeFocus } from "./useTvNoticeFocus";

/** A page button, and a notice showing `message` while there is one. */
const Page = ({ message, onDismiss }: { message: string | null; onDismiss: () => void }) => {
	const target = useRef<HTMLButtonElement>(null);
	const onKeyDown = useTvNoticeFocus(target, message, onDismiss);
	return (
		<>
			<button type="button">Page</button>
			{message && (
				<div role="status" onKeyDown={onKeyDown}>
					<span>{message}</span>
					<button ref={target} type="button">
						Dismiss
					</button>
				</div>
			)}
		</>
	);
};

afterEach(() => {
	os.platform = "tv";
});

describe("useTvNoticeFocus", () => {
	it("brings the focus to a notice on a TV and back to the page when it goes", () => {
		const onDismiss = vi.fn();
		const { rerender } = render(<Page message={null} onDismiss={onDismiss} />);
		const page = screen.getByRole("button", { name: "Page" });
		page.focus();
		rerender(<Page message="Added" onDismiss={onDismiss} />);
		expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
		rerender(<Page message={null} onDismiss={onDismiss} />);
		expect(page).toHaveFocus();
	});

	it("takes the focus again for a new notice", () => {
		const { rerender } = render(<Page message="One" onDismiss={() => {}} />);
		const page = screen.getByRole("button", { name: "Page" });
		page.focus();
		rerender(<Page message="Two" onDismiss={() => {}} />);
		expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
	});

	it("leaves the focus alone off a TV", () => {
		os.platform = "android";
		const { rerender } = render(<Page message={null} onDismiss={() => {}} />);
		const page = screen.getByRole("button", { name: "Page" });
		page.focus();
		rerender(<Page message="Added" onDismiss={() => {}} />);
		expect(page).toHaveFocus();
	});

	it("doesn't move the focus while nothing shows", () => {
		const { rerender } = render(<Page message={null} onDismiss={() => {}} />);
		const page = screen.getByRole("button", { name: "Page" });
		page.focus();
		rerender(<Page message={null} onDismiss={() => {}} />);
		expect(page).toHaveFocus();
	});

	it("brings the focus back to an SVG control too", () => {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("tabindex", "0");
		document.body.append(svg);
		svg.focus();
		expect(document.activeElement).toBe(svg);
		const { rerender } = render(<Page message="Added" onDismiss={() => {}} />);
		expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
		rerender(<Page message={null} onDismiss={() => {}} />);
		expect(document.activeElement).toBe(svg);
		svg.remove();
	});

	it("doesn't send the focus to something that left the page", () => {
		const outside = document.createElement("button");
		document.body.append(outside);
		outside.focus();
		const { rerender } = render(<Page message="Added" onDismiss={() => {}} />);
		outside.remove();
		rerender(<Page message={null} onDismiss={() => {}} />);
		expect(document.activeElement).not.toBe(outside);
	});

	it("dismisses with Escape, the TV's Back, and only with it", () => {
		const onDismiss = vi.fn();
		render(<Page message="Added" onDismiss={onDismiss} />);
		const dismiss = screen.getByRole("button", { name: "Dismiss" });
		fireEvent.keyDown(dismiss, { key: "Enter" });
		expect(onDismiss).not.toHaveBeenCalled();
		const escape = new KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		});
		const reachedTop = vi.fn();
		document.addEventListener("keydown", reachedTop);
		dismiss.dispatchEvent(escape);
		document.removeEventListener("keydown", reachedTop);
		expect(onDismiss).toHaveBeenCalledOnce();
		// So the TV's Back stops here rather than going home.
		expect(escape.defaultPrevented).toBe(true);
		expect(reachedTop).not.toHaveBeenCalled();
	});
});
