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

interface PromptProps {
	controlsVisible?: boolean;
	playing?: boolean;
	held?: boolean;
}

const renderPrompt = (skipping: SegmentSkipping, props: PromptProps = {}) => {
	const onParentClick = vi.fn();
	const onFocusLost = vi.fn();
	const prompt = (skipping: SegmentSkipping, props: PromptProps = {}) => (
		<div onClick={onParentClick}>
			<SkipSegmentPrompt
				skipping={skipping}
				controlsVisible={props.controlsVisible ?? false}
				playing={props.playing ?? true}
				held={props.held}
				onFocusLost={onFocusLost}
			/>
			<button type="button">Elsewhere</button>
		</div>
	);
	const view = render(prompt(skipping, props));
	const update = (skipping: SegmentSkipping, props: PromptProps = {}) =>
		view.rerender(prompt(skipping, props));
	return { ...view, update, onParentClick, onFocusLost };
};

describe("SkipSegmentPrompt", () => {
	afterEach(cleanup);

	it("shows nothing with nothing to skip", () => {
		renderPrompt(makeSkipping());
		expect(screen.queryByRole("button", { name: /skip|undo|next/i })).not.toBeInTheDocument();
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it("skips when the button is pressed, without the click reaching the player", () => {
		const skipping = makeSkipping({ offer: OFFER });
		const { onParentClick } = renderPrompt(skipping);
		fireEvent.click(screen.getByRole("button", { name: "Skip intro" }));
		expect(skipping.skip).toHaveBeenCalledTimes(1);
		expect(onParentClick).not.toHaveBeenCalled();
	});

	it("keeps an older offer only while the controls show", () => {
		const skipping = makeSkipping({ offer: { ...OFFER, fresh: false } });
		const { update } = renderPrompt(skipping);
		expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
		update(skipping, { controlsVisible: true });
		expect(screen.getByRole("button", { name: "Skip intro" })).toBeInTheDocument();
	});

	it("tells screen readers about an offer once, not each time the controls show", () => {
		const skipping = makeSkipping({ offer: { ...OFFER, fresh: false } });
		const { update } = renderPrompt(skipping);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("Skip intro");
		update(skipping, { controlsVisible: true });
		expect(screen.getByRole("status")).toBe(status);
		expect(status).toHaveTextContent("Skip intro");
	});

	it("says when the times may be off, and why", () => {
		renderPrompt(makeSkipping({ offer: { ...OFFER, unsure: true } }));
		const button = screen.getByRole("button", { name: "Skip intro" });
		expect(button).toHaveAccessibleDescription(
			"Times may be off. This video's length doesn't match the one these times were made for."
		);
	});

	it("leaves out the hint when the times fit", () => {
		renderPrompt(makeSkipping({ offer: OFFER }));
		expect(screen.queryByText("Times may be off")).not.toBeInTheDocument();
	});

	it("goes back from the notice with Undo", () => {
		const skipping = makeSkipping({ notice: { label: "Skipped intro" } });
		const { onParentClick } = renderPrompt(skipping);
		expect(screen.getByRole("status")).toHaveTextContent("Skipped intro");
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		expect(skipping.undo).toHaveBeenCalledTimes(1);
		expect(onParentClick).not.toHaveBeenCalled();
	});

	it("hides while something is open over it", () => {
		const { container } = renderPrompt(makeSkipping({ offer: OFFER }), { held: true });
		expect(container.querySelector(".invisible")).toContainElement(
			screen.getByRole("button", { name: "Skip intro", hidden: true })
		);
	});

	describe("focus", () => {
		it("hands focus back when the focused button goes away", () => {
			const { update, onFocusLost } = renderPrompt(makeSkipping({ offer: OFFER }));
			screen.getByRole("button", { name: "Skip intro" }).focus();
			update(makeSkipping({ notice: { label: "Skipped intro" } }));
			expect(onFocusLost).toHaveBeenCalledTimes(1);
		});

		it("keeps out of it when focus was moved somewhere else", () => {
			const { update, onFocusLost } = renderPrompt(makeSkipping({ offer: OFFER }));
			screen.getByRole("button", { name: "Skip intro" }).focus();
			screen.getByRole("button", { name: "Elsewhere" }).focus();
			update(makeSkipping());
			expect(onFocusLost).not.toHaveBeenCalled();
		});

		it("keeps out of it when focus was never on the prompt", () => {
			const { update, onFocusLost } = renderPrompt(makeSkipping({ offer: OFFER }));
			update(makeSkipping());
			expect(onFocusLost).not.toHaveBeenCalled();
		});
	});

	describe("counting down to the next episode", () => {
		const countdown = { cancelLabel: "Watch credits" };

		it("goes on when the countdown runs out", () => {
			const skipping = makeSkipping({ countdown });
			renderPrompt(skipping);
			expect(screen.getByRole("status")).toHaveTextContent(/starts in a few seconds/);
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
			const { update } = renderPrompt(makeSkipping({ countdown }), { playing: false });
			const fill = screen.getByTestId("countdown-fill");
			expect(fill.style.animationPlayState).toBe("paused");
			update(makeSkipping({ countdown }));
			expect(fill.style.animationPlayState).toBe("running");
		});

		it("holds while something is open over it, then goes on from there", () => {
			const { update } = renderPrompt(makeSkipping({ countdown }), { held: true });
			const fill = screen.getByTestId("countdown-fill");
			expect(fill.style.animationPlayState).toBe("paused");
			update(makeSkipping({ countdown }));
			// The same element, so the animation isn't started over.
			expect(screen.getByTestId("countdown-fill")).toBe(fill);
			expect(fill.style.animationPlayState).toBe("running");
		});

		it("takes the place of an offer", () => {
			renderPrompt(makeSkipping({ countdown, offer: OFFER }));
			expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
		});
	});
});
