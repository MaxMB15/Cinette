// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category } from "@/lib/types";
import { CategoryFilter } from "./CategoryFilter";

const categories: Category[] = [
	{ id: "News", name: "News", channelCount: 12 },
	{ id: "Sports", name: "Sports", channelCount: 4 },
];

const chip = (name: RegExp) => screen.getByRole("button", { name });

describe("CategoryFilter", () => {
	afterEach(cleanup);

	it("shows an All chip and one chip per category with its channel count", () => {
		render(<CategoryFilter categories={categories} selected={null} onSelect={vi.fn()} />);
		const names = screen.getAllByRole("button").map((b) => b.textContent);
		expect(names).toEqual(["All", "News12", "Sports4"]);
	});

	it("highlights All when no category is chosen", () => {
		render(<CategoryFilter categories={categories} selected={null} onSelect={vi.fn()} />);
		expect(chip(/^All$/)).toHaveClass("bg-primary");
		expect(chip(/^News/)).not.toHaveClass("bg-primary");
	});

	it("highlights the chosen category instead of All", () => {
		render(<CategoryFilter categories={categories} selected="Sports" onSelect={vi.fn()} />);
		expect(chip(/^Sports/)).toHaveClass("bg-primary");
		expect(chip(/^All$/)).not.toHaveClass("bg-primary");
	});

	it("chooses a category when its chip is clicked", () => {
		const onSelect = vi.fn();
		render(<CategoryFilter categories={categories} selected={null} onSelect={onSelect} />);
		fireEvent.click(chip(/^News/));
		expect(onSelect).toHaveBeenCalledWith("News");
	});

	it("clears the choice when the chosen chip or All is clicked", () => {
		const onSelect = vi.fn();
		render(<CategoryFilter categories={categories} selected="News" onSelect={onSelect} />);
		fireEvent.click(chip(/^News/));
		fireEvent.click(chip(/^All$/));
		expect(onSelect.mock.calls).toEqual([[null], [null]]);
	});
});
