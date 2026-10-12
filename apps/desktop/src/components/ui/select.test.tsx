// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Select } from "./select";

afterEach(cleanup);

const hours = [
	{ value: 6, label: "Every 6 hours" },
	{ value: 12, label: "Every 12 hours" },
	{ value: 24, label: "Every day" },
];

/** A Select that keeps its own value, the way the settings pages use it. */
const Harness = ({
	onChange,
	initial = 12,
}: {
	onChange?: (v: number) => void;
	initial?: number;
}) => {
	const [value, setValue] = useState(initial);
	return (
		<>
			<p>Outside</p>
			<Select
				aria-label="Refresh interval"
				value={value}
				options={hours}
				onChange={(v) => {
					onChange?.(v);
					setValue(v);
				}}
			/>
		</>
	);
};

const trigger = () => screen.getByRole("button", { name: "Refresh interval" });

describe("Select", () => {
	it("shows the chosen option and keeps the list closed", () => {
		render(<Harness />);

		expect(trigger()).toHaveTextContent("Every 12 hours");
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
		expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("falls back to the placeholder, then to a generic prompt, when nothing matches", () => {
		const { rerender } = render(
			<Select value={99} options={hours} onChange={vi.fn()} placeholder="Pick one" />
		);
		expect(screen.getByRole("button")).toHaveTextContent("Pick one");

		rerender(<Select value={99} options={hours} onChange={vi.fn()} />);
		expect(screen.getByRole("button")).toHaveTextContent("Select…");
	});

	it("opens a list with the current option marked", () => {
		render(<Harness />);
		fireEvent.click(trigger());

		expect(trigger()).toHaveAttribute("aria-expanded", "true");
		const list = screen.getByRole("listbox", { name: "Refresh interval" });
		expect(list).toBeInTheDocument();
		const options = screen.getAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual(hours.map((h) => h.label));
		expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual([
			"false",
			"true",
			"false",
		]);
	});

	it("picks an option, reports its value and closes", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);

		fireEvent.click(trigger());
		fireEvent.click(screen.getByRole("option", { name: "Every day" }));

		expect(onChange).toHaveBeenCalledExactlyOnceWith(24);
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger()).toHaveTextContent("Every day");
	});

	it("closes when the button is pressed again", () => {
		render(<Harness />);
		fireEvent.click(trigger());
		fireEvent.click(trigger());

		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
	});

	it("closes on a click outside but not on a click inside the list", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		fireEvent.click(trigger());

		fireEvent.mouseDown(screen.getByRole("listbox"));
		expect(screen.getByRole("listbox")).toBeInTheDocument();

		fireEvent.mouseDown(screen.getByText("Outside"));
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("lets a caller's class replace the default positioning", () => {
		const { container } = render(
			<Select value={6} options={hours} onChange={vi.fn()} className="absolute w-40" />
		);
		const root = container.firstElementChild;

		expect(root).toHaveClass("absolute", "w-40");
		expect(root).not.toHaveClass("relative");
	});
});
