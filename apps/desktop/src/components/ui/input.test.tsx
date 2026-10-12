// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Input } from "./input";

afterEach(cleanup);

describe("Input", () => {
	it("passes its type and attributes through and reports typing", () => {
		const onChange = vi.fn();
		render(<Input type="password" placeholder="Password" onChange={onChange} />);

		const input = screen.getByPlaceholderText("Password");
		expect(input).toHaveAttribute("type", "password");
		fireEvent.change(input, { target: { value: "hunter2" } });
		expect(onChange).toHaveBeenCalledOnce();
		expect(input).toHaveValue("hunter2");
	});

	it("gives its ref the input so a form can focus it", () => {
		const ref = createRef<HTMLInputElement>();
		render(<Input ref={ref} aria-label="Search" />);

		expect(ref.current).toBe(screen.getByRole("textbox", { name: "Search" }));
		ref.current?.focus();
		expect(screen.getByRole("textbox", { name: "Search" })).toHaveFocus();
	});

	it("lets a caller's class replace the default height", () => {
		render(<Input aria-label="Name" className="h-8" disabled />);

		const input = screen.getByRole("textbox", { name: "Name" });
		expect(input).toHaveClass("h-8", "rounded-md");
		expect(input).not.toHaveClass("h-10");
		expect(input).toBeDisabled();
	});
});
