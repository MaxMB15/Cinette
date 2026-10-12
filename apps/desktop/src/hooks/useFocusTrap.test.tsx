// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, afterEach, vi } from "vitest";
import { useRef } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { hasOpenFocusTrap, onFocusLostOnClose, useFocusTrap } from "./useFocusTrap";

const Dialog = () => {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref);
	return (
		<div ref={ref} role="dialog">
			<button>First</button>
			<button>Last</button>
		</div>
	);
};

const NamedTrap = ({ name }: { name: string }) => {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref);
	return (
		<div ref={ref} role="dialog" aria-label={name}>
			<button>{name} first</button>
			<button>{name} last</button>
		</div>
	);
};

/** A dialog with nothing to focus inside it, such as a plain message. */
const EmptyDialog = () => {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref);
	return (
		<div ref={ref} role="dialog" tabIndex={-1}>
			Saving…
		</div>
	);
};

const Harness = ({ open }: { open: boolean }) => (
	<div>
		<button>Behind</button>
		{open && <Dialog />}
	</div>
);

/** A button that opens two modals, with the second one first on the page. */
const Pair = ({ opener, bottom, top }: { opener: boolean; bottom: boolean; top: boolean }) => (
	<div>
		{opener && <button>Opener</button>}
		{top && <NamedTrap name="Top" />}
		{bottom && <NamedTrap name="Bottom" />}
	</div>
);

/** Unsubscribes the listeners a test added. */
const stops: (() => void)[] = [];

/** A mock that `onFocusLostOnClose` calls until the test ends. */
const listen = () => {
	const listener = vi.fn();
	stops.push(onFocusLostOnClose(listener));
	return listener;
};

describe("useFocusTrap", () => {
	afterEach(() => {
		cleanup();
		stops.splice(0).forEach((stop) => stop());
	});

	it("moves focus to the first control on open", () => {
		const { getByText } = render(<Harness open />);
		expect(document.activeElement).toBe(getByText("First"));
	});

	it("wraps Tab and Shift+Tab inside the dialog", () => {
		const { getByText } = render(<Harness open />);
		getByText("Last").focus();
		fireEvent.keyDown(document.activeElement!, { key: "Tab" });
		expect(document.activeElement).toBe(getByText("First"));
		fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(getByText("Last"));
	});

	it("pulls focus back in when it has escaped", () => {
		const { getByText } = render(<Harness open />);
		getByText("Behind").focus();
		fireEvent.keyDown(document.activeElement!, { key: "Tab" });
		expect(document.activeElement).toBe(getByText("First"));
	});

	it("leaves Tab to the top modal when one is open over another", () => {
		const Stack = ({ top }: { top: boolean }) => (
			<>
				<NamedTrap name="Bottom" />
				{top && <NamedTrap name="Top" />}
			</>
		);
		const { getByText, rerender } = render(<Stack top={false} />);
		rerender(<Stack top />);
		expect(document.activeElement).toBe(getByText("Top first"));
		// Tab between the top modal's own controls is left to the browser.
		expect(fireEvent.keyDown(document.activeElement!, { key: "Tab" })).toBe(true);
		expect(document.activeElement).toBe(getByText("Top first"));
		getByText("Top last").focus();
		fireEvent.keyDown(document.activeElement!, { key: "Tab" });
		expect(document.activeElement).toBe(getByText("Top first"));
	});

	it("says whether a modal is open", () => {
		const { rerender } = render(<Harness open={false} />);
		expect(hasOpenFocusTrap()).toBe(false);
		rerender(<Harness open />);
		expect(hasOpenFocusTrap()).toBe(true);
		rerender(<Harness open={false} />);
		expect(hasOpenFocusTrap()).toBe(false);
	});

	it("restores the previous focus on close", () => {
		const { getByText, rerender } = render(<Harness open={false} />);
		getByText("Behind").focus();
		rerender(<Harness open />);
		expect(document.activeElement).toBe(getByText("First"));
		rerender(<Harness open={false} />);
		expect(document.activeElement).toBe(getByText("Behind"));
	});

	it("says when the last modal closes with nowhere to hand focus back", () => {
		const listener = vi.fn();
		const stop = onFocusLostOnClose(listener);
		stops.push(stop);
		const Opener = ({ opener, open }: { opener: boolean; open: boolean }) => (
			<div>
				{opener && <button>Opener</button>}
				{open && <Dialog />}
			</div>
		);
		const { getByText, rerender } = render(<Opener opener open={false} />);
		getByText("Opener").focus();
		rerender(<Opener opener open />);
		rerender(<Opener opener={false} open />);
		rerender(<Opener opener={false} open={false} />);
		expect(listener).toHaveBeenCalledTimes(1);

		stop();
		rerender(<Opener opener open={false} />);
		getByText("Opener").focus();
		rerender(<Opener opener open />);
		rerender(<Opener opener={false} open />);
		rerender(<Opener opener={false} open={false} />);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("stays quiet when focus goes back or another modal is still open", () => {
		const listener = listen();
		const { getByText, rerender } = render(<Harness open={false} />);
		getByText("Behind").focus();
		rerender(<Harness open />);
		rerender(<Harness open={false} />);

		const Stack = ({ opener, top }: { opener: boolean; top: boolean }) => (
			<div>
				{opener && <button>Opener</button>}
				<NamedTrap name="Bottom" />
				{top && <NamedTrap name="Top" />}
			</div>
		);
		rerender(<Stack opener top={false} />);
		getByText("Opener").focus();
		rerender(<Stack opener top />);
		rerender(<Stack opener={false} top />);
		rerender(<Stack opener={false} top={false} />);
		expect(listener).not.toHaveBeenCalled();
	});

	it("says when nothing had focus as the modal opened", () => {
		const listener = listen();
		const { rerender } = render(<Harness open={false} />);
		(document.activeElement as HTMLElement | null)?.blur();
		expect(document.body).toHaveFocus();
		rerender(<Harness open />);
		rerender(<Harness open={false} />);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("says when the control that had focus can no longer take it", () => {
		const listener = listen();
		const Page = ({ disabled, open }: { disabled: boolean; open: boolean }) => (
			<div>
				<button disabled={disabled}>Opener</button>
				{open && <Dialog />}
			</div>
		);
		const { getByText, rerender } = render(<Page disabled={false} open={false} />);
		getByText("Opener").focus();
		rerender(<Page disabled={false} open />);
		rerender(<Page disabled open />);
		rerender(<Page disabled open={false} />);
		expect(document.body).toHaveFocus();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("says once when two modals close together with nowhere to hand focus back", () => {
		const listener = listen();
		const { getByText, rerender } = render(<Pair opener bottom={false} top={false} />);
		getByText("Opener").focus();
		rerender(<Pair opener bottom top={false} />);
		rerender(<Pair opener bottom top />);
		rerender(<Pair opener={false} bottom={false} top={false} />);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("hands focus back to the opener when two modals close together", () => {
		const listener = listen();
		const { getByText, rerender } = render(<Pair opener bottom={false} top={false} />);
		getByText("Opener").focus();
		rerender(<Pair opener bottom top={false} />);
		rerender(<Pair opener bottom top />);
		rerender(<Pair opener bottom={false} top={false} />);
		expect(getByText("Opener")).toHaveFocus();
		expect(listener).not.toHaveBeenCalled();
	});

	it("says so when the bottom modal closes after the top one", () => {
		const listener = listen();
		const { getByText, rerender } = render(<Pair opener bottom={false} top={false} />);
		getByText("Opener").focus();
		rerender(<Pair opener bottom top={false} />);
		rerender(<Pair opener bottom top />);
		rerender(<Pair opener={false} bottom top />);
		rerender(<Pair opener={false} bottom top={false} />);
		expect(getByText("Bottom first")).toHaveFocus();
		expect(listener).not.toHaveBeenCalled();
		rerender(<Pair opener={false} bottom={false} top={false} />);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("leaves focus that moved outside while the modal was open", () => {
		const listener = listen();
		const Page = ({ opener, open }: { opener: boolean; open: boolean }) => (
			<div>
				{opener && <button>Opener</button>}
				<button>Elsewhere</button>
				{open && <Dialog />}
			</div>
		);
		const { getByText, rerender } = render(<Page opener open={false} />);
		getByText("Opener").focus();
		rerender(<Page opener open />);
		getByText("Elsewhere").focus();
		rerender(<Page opener open={false} />);
		expect(document.activeElement).toBe(getByText("Elsewhere"));

		getByText("Opener").focus();
		rerender(<Page opener open />);
		getByText("Elsewhere").focus();
		rerender(<Page opener={false} open />);
		rerender(<Page opener={false} open={false} />);
		expect(document.activeElement).toBe(getByText("Elsewhere"));
		expect(listener).not.toHaveBeenCalled();
	});

	it("keeps focus on a dialog that has no controls", () => {
		const { getByRole, getByText } = render(
			<div>
				<button>Behind</button>
				<EmptyDialog />
			</div>
		);
		const dialog = getByRole("dialog");
		expect(document.activeElement).toBe(dialog);

		getByText("Behind").focus();
		const notPrevented = fireEvent.keyDown(document.activeElement!, { key: "Tab" });
		expect(notPrevented).toBe(false);
		expect(document.activeElement).toBe(dialog);
	});

	it("ignores keys other than Tab", () => {
		const { getByText } = render(<Harness open />);
		getByText("Last").focus();
		const notPrevented = fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
		expect(notPrevented).toBe(true);
		expect(document.activeElement).toBe(getByText("Last"));
	});
});
