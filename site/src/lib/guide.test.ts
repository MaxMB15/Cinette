// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.
// @vitest-environment jsdom

import { expect, test } from "vitest";
import { NOW, START, clock, renderGuide, renderProgram } from "./guide";

/** The guide as a browser reads it, inside a div. */
const guide = (): HTMLDivElement => {
	const div = document.createElement("div");
	div.innerHTML = renderGuide();
	return div;
};

test("clock counts from 7:30 PM", () => {
	expect(clock(0)).toBe("7:30 PM");
	expect(clock(NOW)).toBe("8:41 PM");
	expect(clock(START)).toBe("7:50 PM");
	expect(clock(209)).toBe("10:59 PM");
	expect(clock(270)).toBe("12:00 AM");
	expect(clock(330)).toBe("1:00 AM");
	expect(clock(-30)).toBe("7:00 PM");
	expect(clock(-450)).toBe("12:00 PM");
	expect(clock(-451)).toBe("11:59 AM");
});

test("renderGuide draws the same guide each time", () => {
	expect(renderGuide().replaceAll("><", ">\n<")).toMatchSnapshot();
});

test("renderGuide has a row for each channel, numbered for the animation", () => {
	const rows = [...guide().querySelectorAll<HTMLElement>(".row")];
	expect(rows).toHaveLength(8);
	expect(rows.map((row) => row.style.getPropertyValue("--r"))).toEqual([
		"0",
		"1",
		"2",
		"3",
		"4",
		"5",
		"6",
		"7",
	]);
	for (const image of guide().querySelectorAll("img")) {
		expect(image.getAttribute("alt")).toBe("");
		expect(image.getAttribute("src")).toMatch(/^\.\/img\/logo-[a-z-]+\.png$/);
	}
});

test("renderGuide fills each channel's program on now up to the red line", () => {
	const now = [...guide().querySelectorAll<HTMLElement>(".prog.now")];
	expect(now.map((prog) => prog.style.getPropertyValue("--done"))).toEqual([
		"68.3%",
		"34.2%",
		"20.8%",
		"38.9%",
		"28.9%",
		"18.3%",
		"51.7%",
		"68.3%",
	]);
	for (const prog of guide().querySelectorAll(".prog:not(.now)")) {
		expect(prog.getAttribute("style")).not.toContain("--done");
	}
	expect(guide().querySelector(".nowline")?.outerHTML).toBe(
		'<div class="nowline" style="left:calc(var(--chw) + 51 * var(--m))"><span>8:41 PM</span></div>'
	);
});

test("renderGuide marks the ruler every half hour", () => {
	const marks = [...guide().querySelectorAll(".ruler .track span")];
	expect(marks.map((mark) => mark.textContent)).toEqual([
		"8:00 PM",
		"8:30 PM",
		"9:00 PM",
		"9:30 PM",
		"10:00 PM",
		"10:30 PM",
		"11:00 PM",
	]);
	expect(marks[0].getAttribute("style")).toBe("left:calc(10 * var(--m))");
});

test("renderGuide starts each channel's first program at the left edge", () => {
	const first = guide().querySelector(".prog");
	expect(first?.getAttribute("style")).toBe(
		"left:calc(0 * var(--m) + 2px);width:calc(10 * var(--m) - 4px)"
	);
	for (const row of guide().querySelectorAll(".row")) {
		expect(row.querySelector(".prog")?.getAttribute("style")).toMatch(/^left:calc\(0 \* var/);
	}
});

test("renderProgram counts a program as on from its start up to its end", () => {
	expect(renderProgram(["Starts now", NOW, NOW + 30])).toContain('class="prog now"');
	expect(renderProgram(["Ends now", NOW - 30, NOW])).toContain('class="prog"');
});

test("renderGuide leaves the title off a program too short to show it", () => {
	const firsts = [...guide().querySelectorAll(".row")].map(
		(row) => row.querySelector(".prog")?.textContent
	);
	expect(firsts).toEqual([
		"",
		"",
		"Night Owls",
		"Ember Valley",
		"Rally Highlights",
		"Northwind Live",
		"Wild Coasts",
		"",
	]);
});
