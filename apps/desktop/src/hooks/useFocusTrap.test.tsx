// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, afterEach } from "vitest";
import { useRef } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { useFocusTrap } from "./useFocusTrap";

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

describe("useFocusTrap", () => {
	afterEach(() => {
		cleanup();
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

	it("restores the previous focus on close", () => {
		const { getByText, rerender } = render(<Harness open={false} />);
		getByText("Behind").focus();
		rerender(<Harness open />);
		expect(document.activeElement).toBe(getByText("First"));
		rerender(<Harness open={false} />);
		expect(document.activeElement).toBe(getByText("Behind"));
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
