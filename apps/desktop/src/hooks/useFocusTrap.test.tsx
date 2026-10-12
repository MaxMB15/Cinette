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

	it("restores the previous focus on close", () => {
		const { getByText, rerender } = render(<Harness open={false} />);
		getByText("Behind").focus();
		rerender(<Harness open />);
		expect(document.activeElement).toBe(getByText("First"));
		rerender(<Harness open={false} />);
		expect(document.activeElement).toBe(getByText("Behind"));
	});
});
