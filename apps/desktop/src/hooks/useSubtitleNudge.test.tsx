// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUBTITLE_POSITION } from "@/lib/subtitle-position";
import { useFocusTrap } from "./useFocusTrap";
import { useSubtitleNudge } from "./useSubtitleNudge";

/** A confirm open over the player. */
const Confirm = () => {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref);
	return (
		<div ref={ref} role="dialog">
			<button>Remove</button>
		</div>
	);
};

/** Shows where the subtitles are, so the tests can read it. */
const Player = ({ active, confirm = false }: { active: boolean; confirm?: boolean }) => {
	const [pos, setPos] = useState(DEFAULT_SUBTITLE_POSITION);
	useSubtitleNudge(active, setPos);
	return (
		<>
			<output>{`${pos.x},${pos.y}`}</output>
			{confirm && <Confirm />}
		</>
	);
};

const position = () => screen.getByRole("status").textContent;

/** Presses `key` on the window, and says whether the hook took it. */
const press = (key: string): boolean => !fireEvent.keyDown(window, { key });

describe("useSubtitleNudge", () => {
	it("moves the subtitles with the arrow keys while positioning", () => {
		render(<Player active />);
		expect(press("ArrowUp")).toBe(true);
		expect(press("ArrowLeft")).toBe(true);
		expect(position()).toBe("48,86");
		press("ArrowDown");
		press("ArrowRight");
		press("ArrowRight");
		expect(position()).toBe("52,88");
	});

	it("leaves other keys to the player", () => {
		render(<Player active />);
		expect(press("Enter")).toBe(false);
		expect(position()).toBe("50,88");
	});

	it("does nothing outside positioning mode", () => {
		const { rerender } = render(<Player active />);
		rerender(<Player active={false} />);
		expect(press("ArrowUp")).toBe(false);
		expect(position()).toBe("50,88");
	});

	it("leaves the arrow keys to a confirm open over the player", () => {
		const { rerender } = render(<Player active />);
		rerender(<Player active confirm />);
		expect(press("ArrowUp")).toBe(false);
		expect(position()).toBe("50,88");
	});
});
