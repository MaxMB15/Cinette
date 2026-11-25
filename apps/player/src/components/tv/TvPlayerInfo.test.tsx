// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { Channel, OmdbData, WhatsonData } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import type { TvDetails } from "./TvDetails";
import type { TvLiveInfo } from "./TvLiveInfo";
import { TvPlayerInfo } from "./TvPlayerInfo";

const seen = vi.hoisted(() => ({
	details: null as unknown,
	live: null as unknown,
}));

vi.mock("./TvDetails", () => ({
	TvDetails: (props: unknown) => {
		seen.details = props;
		return <div>Details</div>;
	},
}));

vi.mock("./TvLiveInfo", () => ({
	TvLiveInfo: (props: unknown) => {
		seen.live = props;
		return <div>Live info</div>;
	},
}));

const omdb = { title: "From OMDb" } as unknown as OmdbData;
const whatson = { title: "From Whatson" } as unknown as WhatsonData;
const SHOW = { name: "Harbor Lights", id: "show-1" };

const renderInfo = (channel: Channel, episodes: Channel[] = []) => {
	const handlers = { onPlay: vi.fn(), onClose: vi.fn() };
	render(
		<TvPlayerInfo
			channel={channel}
			show={SHOW}
			episodes={episodes}
			omdbData={omdb}
			whatsonData={whatson}
			{...handlers}
		/>
	);
	return handlers;
};

const detailsProps = () => seen.details as ComponentProps<typeof TvDetails>;

describe("TvPlayerInfo", () => {
	it("opens the channel's guide for a live channel", () => {
		const channel = makeChannel({ id: "news", name: "News" });
		const { onClose } = renderInfo(channel);
		expect(screen.getByText("Live info")).toBeInTheDocument();
		expect(screen.queryByText("Details")).not.toBeInTheDocument();
		const props = seen.live as ComponentProps<typeof TvLiveInfo>;
		expect(props.channel).toBe(channel);
		expect(props.onClose).toBe(onClose);
	});

	it("opens a movie's details, with its play button set to keep watching", () => {
		const movie = makeChannel({
			id: "movie-1",
			name: "The Lantern Keeper",
			contentType: "movie",
		});
		const { onClose, onPlay } = renderInfo(movie);
		expect(screen.getByText("Details")).toBeInTheDocument();
		expect(screen.queryByText("Live info")).not.toBeInTheDocument();
		const props = detailsProps();
		expect(props.item).toBe(movie);
		expect(props.currentEpisode).toBeUndefined();
		expect(props.playLabel).toBe("Keep watching");
		expect(props.omdbData).toBe(omdb);
		expect(props.whatsonData).toBe(whatson);
		expect(props.onPlay).toBe(onPlay);
		expect(props.onClose).toBe(onClose);
	});

	it("opens the show an episode belongs to, with the episode as the one playing", async () => {
		const episode = makeChannel({
			id: "episode-2",
			name: "Episode 2",
			contentType: "series",
			season: 1,
			episode: 2,
		});
		const other = makeChannel({ id: "episode-3", contentType: "series" });
		renderInfo(episode, [episode, other]);
		const props = detailsProps();
		expect(props.item).toEqual({ ...episode, name: "Harbor Lights", id: "show-1" });
		expect(props.currentEpisode).toBe(episode);
		await expect(props.episodesOf(props.item)).resolves.toEqual([episode, other]);
	});
});
