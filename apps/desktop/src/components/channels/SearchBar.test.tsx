// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
	afterEach(cleanup);

	it("shows the current text with the channel placeholder by default", () => {
		render(<SearchBar value="news" onChange={vi.fn()} />);
		const input = screen.getByPlaceholderText("Search channels...");
		expect(input).toHaveValue("news");
	});

	it("uses a custom placeholder", () => {
		render(<SearchBar value="" onChange={vi.fn()} placeholder="Search movies..." />);
		expect(screen.getByPlaceholderText("Search movies...")).toBeInTheDocument();
	});

	it("reports each change of the text", () => {
		const onChange = vi.fn();
		render(<SearchBar value="" onChange={onChange} />);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "spo" } });
		expect(onChange).toHaveBeenCalledWith("spo");
	});

	it("offers a clear button only while there is text, and clearing empties it", () => {
		const onChange = vi.fn();
		const { rerender } = render(<SearchBar value="" onChange={onChange} />);
		expect(screen.queryByRole("button")).toBeNull();

		rerender(<SearchBar value="sport" onChange={onChange} />);
		fireEvent.click(screen.getByRole("button"));
		expect(onChange).toHaveBeenCalledExactlyOnceWith("");
	});

	it("adds the caller's class to its own width", () => {
		const { container } = render(
			<SearchBar value="" onChange={vi.fn()} className="flex-1 w-auto" />
		);
		const root = container.firstElementChild as HTMLElement;
		expect(root).toHaveClass("relative", "flex-1", "w-auto");
		expect(root).not.toHaveClass("w-52");
	});
});
