// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubtitleOverlay } from "./SubtitleOverlay";
import type { SubtitleCue } from "@/lib/types";

const cues: SubtitleCue[] = [
	{ start: 10, end: 12, text: "Where are you going?" },
	{ start: 15, end: 18, text: "Home.\nI'm going home." },
];

/** Renders the overlay in a 1000 by 500 px player, the box it's dragged within. */
const renderInPlayer = (props: ComponentProps<typeof SubtitleOverlay>) => {
	const result = render(
		<div data-testid="player">
			<SubtitleOverlay {...props} />
		</div>
	);
	const player = screen.getByTestId("player");
	player.getBoundingClientRect = () => ({ width: 1000, height: 500 }) as DOMRect;
	return result;
};

/** The box that holds the text and is dragged around. */
const overlayOf = (text: string) =>
	screen.getByText(text).closest("div")!.parentElement as HTMLElement;

describe("SubtitleOverlay", () => {
	afterEach(cleanup);

	it("shows nothing between cues", () => {
		const { container } = render(<SubtitleOverlay cues={cues} position={13} positionAt={0} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows nothing without cues", () => {
		const { container } = render(<SubtitleOverlay cues={[]} position={11} positionAt={0} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the cue under the playhead, including at its first and last second", () => {
		const { rerender } = render(<SubtitleOverlay cues={cues} position={10} positionAt={0} />);
		expect(screen.getByText("Where are you going?")).toBeInTheDocument();
		rerender(<SubtitleOverlay cues={cues} position={12} positionAt={0} />);
		expect(screen.getByText("Where are you going?")).toBeInTheDocument();
		rerender(<SubtitleOverlay cues={cues} position={12.1} positionAt={0} />);
		expect(screen.queryByText("Where are you going?")).toBeNull();
	});

	it("counts on from when the position was read", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			vi.advanceTimersByTime(5000);
			// mpv read 9.5 s 400 ms ago, so the cue starts 100 ms from now.
			render(
				<SubtitleOverlay
					cues={cues}
					position={9.5}
					positionAt={performance.now() - 400}
					playing
				/>
			);
			act(() => vi.advanceTimersByTime(98));
			expect(screen.queryByText("Where are you going?")).toBeNull();
			act(() => vi.advanceTimersByTime(4));
			expect(screen.getByText("Where are you going?")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("breaks a cue into its lines", () => {
		const { container } = render(<SubtitleOverlay cues={cues} position={16} positionAt={0} />);
		expect(screen.getByText("Home.")).toBeInTheDocument();
		expect(screen.getByText("I'm going home.")).toBeInTheDocument();
		expect(container.querySelectorAll("br")).toHaveLength(1);
	});

	it("shows each cue later for a positive delay, as mpv does", () => {
		const { rerender } = render(
			<SubtitleOverlay cues={cues} position={13} positionAt={0} delay={2} />
		);
		expect(screen.getByText("Where are you going?")).toBeInTheDocument();
		rerender(<SubtitleOverlay cues={cues} position={9} positionAt={0} delay={2} />);
		expect(screen.queryByText("Where are you going?")).toBeNull();
		rerender(<SubtitleOverlay cues={cues} position={9} positionAt={0} delay={-2} />);
		expect(screen.getByText("Where are you going?")).toBeInTheDocument();
		rerender(<SubtitleOverlay cues={cues} position={13} positionAt={0} delay={-2} />);
		expect(screen.queryByText("Where are you going?")).toBeNull();
	});

	it("draws the text in the chosen font, size and place", () => {
		render(
			<SubtitleOverlay
				cues={cues}
				position={11}
				positionAt={0}
				fontSize={24}
				fontFamily="Georgia, serif"
				posX={30}
				posY={70}
			/>
		);
		const text = screen.getByText("Where are you going?").closest("div") as HTMLElement;
		expect(text.style.fontSize).toBe("24px");
		expect(text.style.fontFamily).toBe("Georgia, serif");
		const box = overlayOf("Where are you going?");
		expect(box.style.left).toBe("30%");
		expect(box.style.top).toBe("70%");
		// Clicks go through to the player outside positioning mode.
		expect(box.style.pointerEvents).toBe("none");
	});

	it("sits near the bottom center by default", () => {
		render(<SubtitleOverlay cues={cues} position={11} positionAt={0} />);
		const box = overlayOf("Where are you going?");
		expect(box.style.left).toBe("50%");
		expect(box.style.top).toBe("88%");
		const text = screen.getByText("Where are you going?").closest("div") as HTMLElement;
		expect(text.style.fontSize).toBe("18px");
	});

	it("shows a faded sample to position when no cue is on screen", () => {
		render(<SubtitleOverlay cues={[]} position={0} positionAt={0} editMode />);
		const text = screen.getByText("Sample subtitle text").closest("div") as HTMLElement;
		expect(text.style.opacity).toBe("0.5");
		expect(text.style.border).toContain("dashed");
		expect(overlayOf("Sample subtitle text").style.pointerEvents).toBe("auto");
	});

	it("shows the real cue at full strength while positioning", () => {
		render(<SubtitleOverlay cues={cues} position={11} positionAt={0} editMode />);
		const text = screen.getByText("Where are you going?").closest("div") as HTMLElement;
		expect(text.style.opacity).toBe("1");
		expect(screen.queryByText("Sample subtitle text")).toBeNull();
	});

	it("follows a drag in positioning mode as a share of the player's size", () => {
		const onPositionChange = vi.fn();
		renderInPlayer({ cues, position: 11, positionAt: 0, editMode: true, onPositionChange });
		const box = overlayOf("Where are you going?");

		fireEvent.mouseDown(box, { clientX: 500, clientY: 400 });
		fireEvent.mouseMove(document, { clientX: 600, clientY: 350 });
		expect(onPositionChange).toHaveBeenLastCalledWith(60, 78);

		fireEvent.mouseUp(document);
		fireEvent.mouseMove(document, { clientX: 700, clientY: 300 });
		expect(onPositionChange).toHaveBeenCalledTimes(1);
	});

	it("keeps a dragged subtitle inside the player", () => {
		const onPositionChange = vi.fn();
		renderInPlayer({ cues, position: 11, positionAt: 0, editMode: true, onPositionChange });
		const box = overlayOf("Where are you going?");

		fireEvent.mouseDown(box, { clientX: 500, clientY: 400 });
		fireEvent.mouseMove(document, { clientX: 5000, clientY: 5000 });
		expect(onPositionChange).toHaveBeenLastCalledWith(95, 97);
		fireEvent.mouseMove(document, { clientX: -5000, clientY: -5000 });
		expect(onPositionChange).toHaveBeenLastCalledWith(5, 3);
		fireEvent.mouseUp(document);
	});

	it("can't be dragged outside positioning mode", () => {
		const onPositionChange = vi.fn();
		renderInPlayer({ cues, position: 11, positionAt: 0, onPositionChange });
		fireEvent.mouseDown(overlayOf("Where are you going?"), { clientX: 500, clientY: 400 });
		fireEvent.mouseMove(document, { clientX: 600, clientY: 350 });
		fireEvent.mouseUp(document);
		expect(onPositionChange).not.toHaveBeenCalled();
	});
});
