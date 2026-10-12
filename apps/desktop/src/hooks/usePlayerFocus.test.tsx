// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFocusTrap } from "./useFocusTrap";
import { usePlayerFocus } from "./usePlayerFocus";

/** A confirm, which opens outside the player. */
const Confirm = () => {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref);
	return (
		<div ref={ref} role="dialog">
			<button>Remove</button>
		</div>
	);
};

const Player = ({ url, confirm = false }: { url: string | null; confirm?: boolean }) => {
	const ref = useRef<HTMLDivElement>(null);
	usePlayerFocus(ref, url);
	return (
		<>
			<button>Sidebar</button>
			<div ref={ref} tabIndex={-1} data-testid="player">
				<button>Resume</button>
			</div>
			{confirm && <Confirm />}
		</>
	);
};

const player = () => screen.getByTestId("player");
const button = (name: string) => screen.getByRole("button", { name });

describe("usePlayerFocus", () => {
	it("focuses the player when it opens", () => {
		render(<Player url={null} />);
		expect(player()).toHaveFocus();
	});

	it("takes focus back when a new stream loads", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Sidebar").focus();
		rerender(<Player url="http://example.test/2" />);
		expect(player()).toHaveFocus();
	});

	it("leaves focus where it is when the stream stops", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Sidebar").focus();
		rerender(<Player url={null} />);
		expect(button("Sidebar")).toHaveFocus();
	});

	it("leaves focus that's already inside the player", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Resume").focus();
		rerender(<Player url="http://example.test/2" />);
		expect(button("Resume")).toHaveFocus();
	});

	it("leaves focus on a confirm open over the player", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		rerender(<Player url="http://example.test/1" confirm />);
		expect(button("Remove")).toHaveFocus();
		rerender(<Player url="http://example.test/2" confirm />);
		expect(button("Remove")).toHaveFocus();
	});
});
