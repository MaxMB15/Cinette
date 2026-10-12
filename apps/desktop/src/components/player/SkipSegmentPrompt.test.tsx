// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SkipSegmentPrompt } from "./SkipSegmentPrompt";
import type { SegmentSkipping } from "@/hooks/useSegmentSkipping";

const makeSkipping = (overrides: Partial<SegmentSkipping> = {}): SegmentSkipping => ({
	offer: null,
	notice: null,
	countdown: null,
	skip: vi.fn(() => true),
	undo: vi.fn(),
	cancelCountdown: vi.fn(),
	...overrides,
});

const OFFER = { label: "Skip intro", next: false, fresh: true, unsure: false };

const renderPrompt = (
	skipping: SegmentSkipping,
	{ controlsVisible = false, playing = true, onPressed = vi.fn() } = {}
) => {
	const onParentClick = vi.fn();
	const view = render(
		<div onClick={onParentClick}>
			<SkipSegmentPrompt
				skipping={skipping}
				controlsVisible={controlsVisible}
				playing={playing}
				onPressed={onPressed}
			/>
		</div>
	);
	return { ...view, onParentClick, onPressed };
};

describe("SkipSegmentPrompt", () => {
	afterEach(cleanup);

	it("shows nothing with nothing to skip", () => {
		renderPrompt(makeSkipping());
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("skips when the button is pressed, without the click reaching the player", () => {
		const skipping = makeSkipping({ offer: OFFER });
		const { onParentClick, onPressed } = renderPrompt(skipping);
		fireEvent.click(screen.getByRole("button", { name: "Skip intro" }));
		expect(skipping.skip).toHaveBeenCalledTimes(1);
		expect(onPressed).toHaveBeenCalledTimes(1);
		expect(onParentClick).not.toHaveBeenCalled();
	});

	it("keeps an older offer only while the controls show", () => {
		const skipping = makeSkipping({ offer: { ...OFFER, fresh: false } });
		const { rerender } = renderPrompt(skipping);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		rerender(<SkipSegmentPrompt skipping={skipping} controlsVisible playing />);
		expect(screen.getByRole("button", { name: "Skip intro" })).toBeInTheDocument();
	});

	it("says when the times may be off", () => {
		renderPrompt(makeSkipping({ offer: { ...OFFER, unsure: true } }));
		const button = screen.getByRole("button", { name: "Skip intro" });
		expect(button).toHaveAccessibleDescription("Times may be off");
	});

	it("leaves out the hint when the times fit", () => {
		renderPrompt(makeSkipping({ offer: OFFER }));
		expect(screen.queryByText("Times may be off")).not.toBeInTheDocument();
	});

	it("goes back from the notice with Undo", () => {
		const skipping = makeSkipping({ notice: { label: "Skipped intro" } });
		const { onParentClick } = renderPrompt(skipping);
		expect(screen.getByText("Skipped intro")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		expect(skipping.undo).toHaveBeenCalledTimes(1);
		expect(onParentClick).not.toHaveBeenCalled();
	});

	describe("counting down to the next episode", () => {
		const countdown = { cancelLabel: "Watch credits" };

		it("goes on when the countdown runs out", () => {
			const skipping = makeSkipping({ countdown });
			renderPrompt(skipping);
			expect(screen.getByText(/starts in a few seconds/)).toBeInTheDocument();
			fireEvent.animationEnd(screen.getByTestId("countdown-fill"));
			expect(skipping.skip).toHaveBeenCalledTimes(1);
		});

		it("goes on right away from the button", () => {
			const skipping = makeSkipping({ countdown });
			renderPrompt(skipping);
			fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
			expect(skipping.skip).toHaveBeenCalledTimes(1);
		});

		it("stays on the credits from the other button", () => {
			const skipping = makeSkipping({ countdown });
			renderPrompt(skipping);
			fireEvent.click(screen.getByRole("button", { name: "Watch credits" }));
			expect(skipping.cancelCountdown).toHaveBeenCalledTimes(1);
			expect(skipping.skip).not.toHaveBeenCalled();
		});

		it("holds while the video is paused", () => {
			const { rerender } = renderPrompt(makeSkipping({ countdown }), { playing: false });
			const fill = screen.getByTestId("countdown-fill");
			expect(fill.style.animationPlayState).toBe("paused");
			rerender(
				<SkipSegmentPrompt
					skipping={makeSkipping({ countdown })}
					controlsVisible={false}
					playing
				/>
			);
			expect(screen.getByTestId("countdown-fill").style.animationPlayState).toBe("running");
		});

		it("takes the place of an offer", () => {
			renderPrompt(makeSkipping({ countdown, offer: OFFER }));
			expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
		});
	});
});
