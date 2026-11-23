// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// The page's font and the effects that follow the scroll. The page reads the
// same without this script.

import "@fontsource-variable/archivo/wdth.css";
import { animate, scroll } from "motion";

const hero = document.querySelector<HTMLElement>(".hero");
const win = document.getElementById("win");

if (matchMedia("(prefers-reduced-motion: no-preference)").matches) {
	// Time moves on as the hero scrolls away: the programs and the red line drift left.
	if (hero) {
		scroll(animate(".guide-inner .track > *, .nowline", { x: [0, -90] }, { ease: "linear" }), {
			target: hero,
			offset: ["start start", "end start"],
		});
	}

	// The app window tilts up as it comes into view. It starts small enough that
	// its near edge stays inside the page.
	if (win) {
		scroll(
			animate(win, { rotateX: [20, 0], scale: [0.82, 1], y: [40, 0] }, { ease: "linear" }),
			{ target: win, offset: ["start end", "start 35%"] }
		);
	}

	// Each feature's bar fills as you read it.
	for (const step of document.querySelectorAll<HTMLElement>(".step")) {
		const fill = step.querySelector(".bar-fill");
		if (fill) {
			scroll(animate(fill, { scaleX: [0, 1] }, { ease: "linear" }), {
				target: step,
				offset: ["start 75%", "end 50%"],
			});
		}
	}
}

// The window next to the features shows the screen for the one in the middle
// of the view. It isn't decoration, so it runs with motion off too.
const frames = [...document.querySelectorAll(".frames img")];
const showing = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			if (entry.isIntersecting) {
				const shot = Number((entry.target as HTMLElement).dataset.shot);
				frames.forEach((frame, index) => frame.classList.toggle("on", index === shot));
			}
		}
	},
	{ rootMargin: "-45% 0px -45% 0px" }
);
for (const step of document.querySelectorAll(".step")) {
	showing.observe(step);
}
