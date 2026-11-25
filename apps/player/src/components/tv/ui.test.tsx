// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatHHMM } from "@/lib/epg-window";
import { makeChannel } from "@/test/channel-fixtures";
import {
	COLUMN_HEIGHT,
	HEADER_HEIGHT,
	SCREEN_HEIGHT,
	TvButton,
	TvChannelRow,
	TvClock,
	TvEmpty,
	TvField,
	TvHeader,
	TvLogo,
	TvTextRow,
} from "./ui";

const NOW = 1_800_000_000;

vi.mock("@/hooks/useNow", () => ({ useNow: () => NOW }));

describe("TV screen parts", () => {
	afterEach(cleanup);

	it("leaves the columns the height of the screen less the header and a margin", () => {
		expect(SCREEN_HEIGHT).toBe(36);
		expect(HEADER_HEIGHT).toBe(3.5);
		expect(COLUMN_HEIGHT).toBe(32);
	});

	it("shows the time in the clock", () => {
		render(<TvClock />);
		expect(screen.getByText(formatHHMM(NOW))).toBeInTheDocument();
	});

	describe("TvField", () => {
		const field = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });

		it("keeps the system's keyboard closed when the D-pad reaches it", () => {
			render(<TvField aria-label="Name" />);
			act(() => field().focus());
			expect(field()).toHaveFocus();
			expect(field().inputMode).toBe("none");
		});

		it("takes the focus again with OK, so the WebView opens the keyboard", () => {
			render(<TvField aria-label="Name" />);
			act(() => field().focus());
			const blur = vi.spyOn(field(), "blur");
			const focus = vi.spyOn(field(), "focus");
			fireEvent.keyDown(field(), { key: "Enter" });
			expect(blur.mock.invocationCallOrder[0]).toBeLessThan(
				focus.mock.invocationCallOrder[0]
			);
			expect(field()).toHaveFocus();
			expect(field().inputMode).toBe("text");
		});

		it("closes the keyboard with its Enter key, and keeps the focus", () => {
			render(<TvField aria-label="Name" />);
			act(() => field().focus());
			fireEvent.keyDown(field(), { key: "Enter" });
			const blur = vi.spyOn(field(), "blur");
			fireEvent.keyDown(field(), { key: "Enter" });
			expect(field().inputMode).toBe("none");
			expect(blur).not.toHaveBeenCalled();
			expect(field()).toHaveFocus();
		});

		it("names that key Done", () => {
			render(<TvField aria-label="Name" />);
			expect(field()).toHaveAttribute("enterkeyhint", "done");
		});

		it("closes the keyboard again once the D-pad leaves", () => {
			render(<TvField aria-label="Name" />);
			act(() => field().focus());
			fireEvent.keyDown(field(), { key: "Enter" });
			act(() => field().blur());
			expect(field().inputMode).toBe("none");
		});

		it("leaves the other keys to the field", () => {
			render(<TvField aria-label="Name" />);
			act(() => field().focus());
			const blur = vi.spyOn(field(), "blur");
			fireEvent.keyDown(field(), { key: "ArrowLeft" });
			expect(blur).not.toHaveBeenCalled();
			expect(field().inputMode).toBe("none");
		});

		it("passes on what it's given", () => {
			render(<TvField aria-label="Name" defaultValue="Harbor" />);
			expect(field()).toHaveValue("Harbor");
		});
	});

	it("gives a screen a heading, the time, and the header's height", () => {
		render(<TvHeader title="Movies" />);
		expect(screen.getByRole("heading", { level: 1, name: "Movies" })).toBeInTheDocument();
		expect(screen.getByText(formatHHMM(NOW))).toBeInTheDocument();
		expect(screen.getByRole("banner").style.height).toBe("3.5rem");
	});

	it("makes a button that doesn't submit and passes its props on", () => {
		const onClick = vi.fn();
		render(
			<TvButton onClick={onClick} aria-label="Remove">
				<span>Text</span>
			</TvButton>
		);
		const button = screen.getByRole("button", { name: "Remove" });
		expect(button).toHaveAttribute("type", "button");
		expect(button).toHaveTextContent("Text");
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("shows a logo where there is one", () => {
		const { container } = render(<TvLogo url="http://logo.example.test/a.png" name="news" />);
		expect(container.querySelector("img")).toHaveAttribute(
			"src",
			"http://logo.example.test/a.png"
		);
		expect(screen.queryByText("N")).not.toBeInTheDocument();
	});

	it("falls back to the name's first letter, in capitals, without a logo", () => {
		render(<TvLogo name="news" />);
		expect(screen.getByText("N")).toBeInTheDocument();
	});

	it("shows a row's label, and what goes at its end only if it has one", () => {
		const { container, rerender } = render(<TvTextRow label="Sports" />);
		expect(screen.getByText("Sports")).toBeInTheDocument();
		expect(container.querySelectorAll("span")).toHaveLength(1);
		rerender(<TvTextRow label="Sports" end={0} />);
		expect(screen.getByText("0")).toBeInTheDocument();
	});

	it("says what's missing and what to do about it", () => {
		render(
			<TvEmpty title="Nothing here">
				<button type="button">Add some</button>
			</TvEmpty>
		);
		expect(screen.getByText("Nothing here")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add some" })).toBeInTheDocument();
	});

	describe("TvChannelRow", () => {
		it("shows only the name and first letter for a plain channel", () => {
			const { container } = render(<TvChannelRow channel={makeChannel({ name: "abc" })} />);
			expect(screen.getByText("abc")).toBeInTheDocument();
			expect(screen.getByText("A")).toBeInTheDocument();
			expect(container.querySelectorAll("p")).toHaveLength(1);
			expect(screen.queryByLabelText("Favorite")).not.toBeInTheDocument();
		});

		it("shows the logo, the line under the name, the end and the favorite mark", () => {
			const { container } = render(
				<TvChannelRow
					channel={makeChannel({
						name: "abc",
						logoUrl: "http://logo.example.test/b.png",
						isFavorite: true,
					})}
					line="On now"
					end="Live"
				/>
			);
			expect(container.querySelector("img")).toHaveAttribute(
				"src",
				"http://logo.example.test/b.png"
			);
			expect(screen.getByText("On now")).toBeInTheDocument();
			expect(screen.getByText("Live")).toBeInTheDocument();
			expect(screen.getByLabelText("Favorite")).toBeInTheDocument();
		});

		it("keeps an end of nothing out of the row", () => {
			render(<TvChannelRow channel={makeChannel({ name: "abc" })} end={undefined} />);
			expect(screen.getByText("abc").parentElement?.nextElementSibling).toBeNull();
		});

		it("shows an end of zero", () => {
			render(<TvChannelRow channel={makeChannel({ name: "abc" })} end={0} />);
			expect(screen.getByText("0")).toBeInTheDocument();
		});
	});
});
