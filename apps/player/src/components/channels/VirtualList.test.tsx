// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { VirtualList } from "./VirtualList";

const row = (index: number) => <p>row {index}</p>;

/** The element each row is drawn in. */
const slot = (index: number) => screen.getByText(`row ${index}`).parentElement as HTMLElement;

/** Lets the virtualizer's measure, which it schedules, reach the screen. */
const flush = () => act(async () => {});

beforeEach(() => {
	// jsdom has no layout, so give the scroll area a size.
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
});

afterEach(() => vi.restoreAllMocks());

describe("VirtualList", () => {
	it("is as tall as all its rows, and stacks the rows in view at their places", async () => {
		const { container } = render(
			<VirtualList count={100} rowHeight={50} renderRow={row} className="extra" />
		);
		await flush();

		const scroller = container.firstElementChild as HTMLElement;
		expect(scroller).toHaveClass("overflow-auto", "extra");
		const body = scroller.firstElementChild as HTMLElement;
		expect(body.style.height).toBe("5000px");
		expect(body.style.width).toBe("100%");
		expect(body.style.position).toBe("relative");

		expect(slot(0).style.position).toBe("absolute");
		expect(slot(0).style.top).toBe("0px");
		expect(slot(0).style.left).toBe("0px");
		expect(slot(0).style.width).toBe("100%");
		expect(slot(0).style.height).toBe("50px");
		expect(slot(0).style.transform).toBe("translateY(0px)");
		expect(slot(1).style.transform).toBe("translateY(50px)");
		// Only the rows in view and a few more are drawn.
		expect(screen.queryByText("row 99")).toBeNull();
	});

	it("measures the rows again when their height changes", async () => {
		const { container, rerender } = render(
			<VirtualList count={10} rowHeight={50} renderRow={row} />
		);
		await flush();
		rerender(<VirtualList count={10} rowHeight={80} renderRow={row} />);
		await flush();

		const body = container.firstElementChild!.firstElementChild as HTMLElement;
		expect(body.style.height).toBe("800px");
		expect(slot(1).style.height).toBe("80px");
		expect(slot(1).style.transform).toBe("translateY(80px)");
	});

	it("draws what's behind the rows, and shows the placeholder in place of them", async () => {
		const { rerender } = render(
			<VirtualList count={3} rowHeight={50} renderRow={row} background={<i>grid</i>} />
		);
		await flush();
		expect(screen.getByText("grid")).toBeInTheDocument();

		rerender(
			<VirtualList
				count={3}
				rowHeight={50}
				renderRow={row}
				background={<i>grid</i>}
				placeholder={<b>nothing here</b>}
			/>
		);
		expect(screen.getByText("nothing here")).toBeInTheDocument();
		expect(screen.queryByText("row 0")).toBeNull();
		expect(screen.queryByText("grid")).toBeNull();
	});
});
