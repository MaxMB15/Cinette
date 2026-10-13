// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoSearchResults } from "./NoSearchResults";

describe("NoSearchResults", () => {
	afterEach(cleanup);

	it("names what was searched and quotes the query without its outer spaces", () => {
		render(<NoSearchResults query="  dune " scope="movies" onClear={vi.fn()} />);
		expect(screen.getByText("No movies matching “dune”")).toBeInTheDocument();
	});

	it("talks about results when no scope is given", () => {
		render(<NoSearchResults query="dune" onClear={vi.fn()} />);
		expect(screen.getByText("No results matching “dune”")).toBeInTheDocument();
	});

	it("suggests checking the spelling when nothing else narrows the search", () => {
		render(<NoSearchResults query="dune" onClear={vi.fn()} />);
		expect(screen.getByText("Check the spelling or try a shorter search.")).toBeInTheDocument();
	});

	it("points at the active filter when one is narrowing the search", () => {
		render(<NoSearchResults query="dune" filtered onClear={vi.fn()} />);
		expect(
			screen.getByText("Try editing your search or removing the active filter.")
		).toBeInTheDocument();
		expect(screen.queryByText("Check the spelling or try a shorter search.")).toBeNull();
	});

	it("clears the search from its button", () => {
		const onClear = vi.fn();
		render(<NoSearchResults query="dune" onClear={onClear} />);
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect(onClear).toHaveBeenCalledOnce();
	});
});
