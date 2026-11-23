// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// The TV guide in the hero, built once when the site is built. The channels
// and programs are made up. Times count minutes from 7:30 PM. A program that
// began before the guide's left edge starts there, and one too short to show
// its title has none. The stylesheet sets --m, the width of a minute, and
// --chw, the width of the channel column.

type Program = [title: string, from: number, to: number];

type Channel = {
	/** The logo is `img/logo-<logo>.png`. */
	logo: string;
	name: string;
	group: string;
	programs: Program[];
};

/** The time on the guide's red line. */
export const NOW = 71;

/** The time at the guide's left edge, where each channel's first program starts. */
export const START = 20;

const CHANNELS: Channel[] = [
	{
		logo: "meridian-news",
		name: "Meridian News 24",
		group: "News",
		programs: [
			["", 20, 30],
			["Meridian Tonight", 30, 90],
			["World Desk", 90, 120],
			["The Briefing", 120, 150],
			["Weather Hour", 150, 180],
			["Meridian Tonight", 180, 240],
		],
	},
	{
		logo: "pulse-sports",
		name: "Pulse Sports",
		group: "Sports",
		programs: [
			["", 20, 30],
			["Champions Cup: Semifinal", 30, 150],
			["Pulse Tonight", 150, 210],
			["Fight Night Preview", 210, 240],
		],
	},
	{
		logo: "nova-one",
		name: "Nova One",
		group: "Entertainment",
		programs: [
			["Night Owls", 20, 45],
			["The Quiet Meridian", 45, 170],
			["Late Show with Ray Okoro", 170, 230],
			["Night Owls", 230, 260],
		],
	},
	{
		logo: "lumen-cinema",
		name: "Lumen Cinema",
		group: "Movies",
		programs: [
			["Ember Valley", 20, 151],
			["Glass Cathedral", 151, 273],
		],
	},
	{
		logo: "velocity",
		name: "Velocity Motor",
		group: "Sports",
		programs: [
			["Rally Highlights", 20, 45],
			["Grand Prix Qualifying", 45, 135],
			["Pit Lane", 135, 165],
			["Rally Highlights", 165, 225],
			["Pit Lane", 225, 255],
		],
	},
	{
		logo: "northwind-news",
		name: "Northwind News",
		group: "News",
		programs: [
			["Northwind Live", 20, 60],
			["Northwind Evening", 60, 120],
			["Late Edition", 120, 150],
			["Northwind Evening", 150, 210],
			["Northwind Live", 210, 300],
		],
	},
	{
		logo: "atlas-nature",
		name: "Atlas Nature",
		group: "Documentary",
		programs: [
			["Wild Coasts", 20, 40],
			["Summit", 40, 100],
			["Wild Coasts", 100, 160],
			["Summit", 160, 220],
			["Wild Coasts", 220, 280],
		],
	},
	{
		logo: "echo-comedy",
		name: "Echo Comedy",
		group: "Entertainment",
		programs: [
			["", 20, 30],
			["Stand-Up Hour", 30, 90],
			["Flatmates", 90, 120],
			["Flatmates", 120, 150],
			["Office Hours", 150, 180],
			["Stand-Up Hour", 180, 240],
		],
	},
];

/** The ruler's times, every half hour from 8:00 PM. */
const MARKS = [30, 60, 90, 120, 150, 180, 210];

/** The clock time this many minutes after 7:30 PM, such as `8:41 PM`. */
export const clock = (minutes: number): string => {
	const total = (19 * 60 + 30 + minutes + 24 * 60) % (24 * 60);
	const hours = Math.floor(total / 60);
	const mins = String(total % 60).padStart(2, "0");
	return `${hours % 12 || 12}:${mins} ${hours < 12 ? "AM" : "PM"}`;
};

/** How far from the left of the track a time is, for a CSS calc(). */
const offset = (minutes: number): string => `${minutes - START} * var(--m)`;

/** One program. While it's on, it's filled up to the red line. */
export const renderProgram = ([title, from, to]: Program): string => {
	const length = to - from;
	const on = from <= NOW && NOW < to;
	const done = on ? `;--done:${Math.round(((NOW - from) / length) * 1000) / 10}%` : "";
	return `<div class="prog${on ? " now" : ""}" style="left:calc(${offset(from)} + 2px);width:calc(${length} * var(--m) - 4px)${done}"><span>${title}</span></div>`;
};

const row = (channel: Channel, index: number): string =>
	`<div class="row" style="--r:${index}"><div class="ch"><img src="./img/logo-${channel.logo}.png" alt="" width="30" height="30"><span><b>${channel.name}</b><i>${channel.group}</i></span></div><div class="track">${channel.programs.map(renderProgram).join("")}</div></div>`;

/**
 * The guide's HTML: a ruler of times, a row for each channel and the red line
 * at the current time. The program on now is filled up to that line.
 */
export const renderGuide = (): string => {
	const ruler = `<div class="ruler"><span></span><div class="track">${MARKS.map((m) => `<span style="left:calc(${offset(m)})">${clock(m)}</span>`).join("")}</div></div>`;
	const line = `<div class="nowline" style="left:calc(var(--chw) + ${offset(NOW)})"><span>${clock(NOW)}</span></div>`;
	return `<div class="guide-inner">${ruler}${CHANNELS.map(row).join("")}${line}</div>`;
};
