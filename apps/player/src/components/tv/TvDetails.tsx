// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Heart, Play, Repeat } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { RatingsRow } from "@/components/ui/ratings-row";
import { useChannels } from "@/hooks/useChannels";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useSheetDetails } from "@/hooks/useMediaDetails";
import { dedupeEpisodes, episodeLabel, sortEpisodes } from "@/lib/episodes";
import { mediaFacts } from "@/lib/media-facts";
import { channelSources, describeSource, withSource } from "@/lib/sources";
import { focusTvStart } from "@/lib/tv-focus";
import { cn } from "@/lib/utils";
import type { Channel, OmdbData, WhatsonData } from "@/lib/types";
import { TvList } from "./TvList";
import { TvButton, TvTextRow } from "./ui";
import { useRemembered } from "./tv-nav";

const ROW_HEIGHT = 2.75;
const LISTS_HEIGHT = ROW_HEIGHT * 7;

export interface TvDetailsProps {
	item: Channel;
	onClose: () => void;
	onPlay: (channel: Channel, episodes?: Channel[]) => void;
	episodesOf: (show: Channel) => Promise<Channel[]>;
	/** What the movie's first button says. */
	playLabel?: string;
	/** The episode to open a show on, instead of where the viewer last was. */
	currentEpisode?: Channel;
	/** What the player already loaded. Unset to load it here. */
	omdbData?: OmdbData | null;
	whatsonData?: WhatsonData | null;
}

const seasonName = (season: number): string =>
	season === 0 ? "Other episodes" : `Season ${season}`;

/**
 * A movie or show on the whole screen. A movie opens on Play, and a show on
 * its first episode, so OK starts watching right away. Back closes it.
 */
export const TvDetails = ({
	item,
	onClose,
	onPlay,
	episodesOf,
	playLabel = "Play",
	currentEpisode,
	omdbData: prefetchedOmdbData,
	whatsonData: prefetchedWhatsonData,
}: TvDetailsProps) => {
	const isShow = item.contentType === "series";
	const { channels, toggleFavorite } = useChannels();
	const { omdbData, whatsonData } = useSheetDetails(
		{ id: item.id, title: item.name, kind: isShow ? "series" : "movie" },
		prefetchedOmdbData,
		prefetchedWhatsonData
	);
	const facts = mediaFacts(omdbData, whatsonData, item.logoUrl);
	const favorite = channels.find((c) => c.id === item.id)?.isFavorite ?? item.isFavorite;

	const favoriteButton = (
		<TvButton onClick={() => void toggleFavorite(item.id)}>
			<Heart
				aria-hidden
				className={favorite ? "size-[1.25rem] fill-current" : "size-[1.25rem]"}
			/>
			{favorite ? "Remove from favorites" : "Add to favorites"}
		</TvButton>
	);

	return (
		<Dialog
			label={item.name}
			onClose={onClose}
			overlayClassName="bg-background"
			className={`flex size-full gap-[2rem] p-[2rem] text-foreground ${isShow ? "" : "items-center"}`}
		>
			<div
				className={`flex shrink-0 flex-col gap-[1rem] ${isShow ? "w-[13rem]" : "w-[17rem]"}`}
			>
				<Poster url={facts.poster} name={item.name} />
				{isShow && favoriteButton}
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				<h2 className="line-clamp-2 text-[2rem] leading-[2.5rem] font-semibold">
					{item.name}
				</h2>
				<Facts values={[facts.year, facts.rated, facts.genre, facts.runtime]} />
				<div className="mt-[0.5rem]">
					<RatingsRow omdbData={omdbData} whatsonData={whatsonData} />
				</div>
				{facts.plot && (
					<p
						className={`mt-[0.75rem] max-w-[42rem] text-base ${isShow ? "line-clamp-2" : "line-clamp-6"}`}
					>
						{facts.plot}
					</p>
				)}
				{isShow ? (
					<Episodes
						show={item}
						episodesOf={episodesOf}
						onPlay={onPlay}
						current={currentEpisode}
					/>
				) : (
					<>
						{facts.director && <Credit label="Directed by" names={facts.director} />}
						{facts.actors && <Credit label="With" names={facts.actors} />}
						<MovieActions
							movie={item}
							playLabel={playLabel}
							favoriteButton={favoriteButton}
							onPlay={onPlay}
						/>
					</>
				)}
			</div>
		</Dialog>
	);
};

/** The poster, or the name's first letter when there's none. */
export const Poster = ({
	url,
	name,
	className,
}: {
	url: string | null;
	name: string;
	className?: string;
}) => (
	<div
		className={cn(
			"flex aspect-2/3 w-full shrink-0 items-center justify-center overflow-clip rounded-[0.5rem] bg-[hsl(220_14%_14%)]",
			className
		)}
	>
		{url ? (
			<img src={url} alt="" className="size-full object-cover" />
		) : (
			<span className="text-[4rem] font-semibold">{name.charAt(0).toUpperCase()}</span>
		)}
	</div>
);

/** The year, rating and the like, the ones that are known, on one line. */
export const Facts = ({
	values,
	className,
}: {
	values: readonly (string | null)[];
	className?: string;
}) => (
	<p className={cn("mt-[0.25rem] flex flex-wrap gap-x-[1rem] text-base opacity-70", className)}>
		{values.filter(Boolean).map((value) => (
			<span key={value}>{value}</span>
		))}
	</p>
);

const Credit = ({ label, names }: { label: string; names: string }) => (
	<p className="mt-[0.5rem] max-w-[42rem] truncate text-[0.875rem] leading-[1.25rem]">
		<span className="opacity-70">{label} </span>
		{names}
	</p>
);

/** Play, favorite, and the source, which OK steps through when the movie has several. */
const MovieActions = ({
	movie,
	playLabel,
	favoriteButton,
	onPlay,
}: {
	movie: Channel;
	playLabel: string;
	favoriteButton: ReactNode;
	onPlay: (channel: Channel) => void;
}) => {
	const sources = channelSources(movie);
	const [source, setSource] = useRemembered(`source:${movie.id}`, 0);
	const detail = describeSource(sources[source] ?? movie.url);
	return (
		<div className="mt-[1.5rem] flex gap-[0.75rem]">
			<TvButton
				onClick={() => {
					const url = sources[source] ?? movie.url;
					onPlay(url === movie.url ? movie : withSource(movie, url));
				}}
			>
				<Play aria-hidden className="size-[1.25rem] fill-current" />
				{playLabel}
			</TvButton>
			{favoriteButton}
			{sources.length > 1 && (
				<TvButton
					className="min-w-0"
					onClick={() => setSource((source + 1) % sources.length)}
				>
					<Repeat aria-hidden className="size-[1.25rem] shrink-0" />
					Source {source + 1} of {sources.length}
					{detail && <span className="min-w-0 truncate opacity-70">{detail}</span>}
				</TvButton>
			)}
		</div>
	);
};

/** Where an episode sits in the seasons and in its own season's list. */
const placeOf = (episodes: readonly Channel[], at: Channel) => {
	const seasons = [...new Set(episodes.map((ep) => ep.season ?? 0))];
	const inSeason = episodes.filter((ep) => (ep.season ?? 0) === (at.season ?? 0));
	return {
		season: Math.max(0, seasons.indexOf(at.season ?? 0)),
		episode: Math.max(
			0,
			inSeason.findIndex((ep) => ep.episode === at.episode)
		),
		inSeasons: false,
	};
};

/** A show's seasons and the episodes of the season the cursor is on. */
const Episodes = ({
	show,
	episodesOf,
	onPlay,
	current,
}: {
	show: Channel;
	episodesOf: TvDetailsProps["episodesOf"];
	onPlay: TvDetailsProps["onPlay"];
	current?: Channel;
}) => {
	const [episodes, setEpisodes] = useState<Channel[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [place, setPlace] = useRemembered(`episodes:${show.id}`, {
		season: 0,
		episode: 0,
		inSeasons: false,
	});
	const listsRef = useRef<HTMLDivElement>(null);
	// The player passes a new function each time it renders, and a new show
	// object too, so only another show loads again.
	const loadRef = useLatestRef(() => episodesOf(show));
	const currentRef = useLatestRef(current);
	const setPlaceRef = useLatestRef(setPlace);

	useEffect(() => {
		let live = true;
		loadRef
			.current()
			.then((list) => {
				if (!live) return;
				const sorted = sortEpisodes(dedupeEpisodes(list));
				setEpisodes(sorted);
				const at = currentRef.current;
				if (at) setPlaceRef.current(placeOf(sorted, at));
			})
			.catch(() => {
				if (live) setFailed(true);
			});
		return () => {
			live = false;
		};
	}, [show.id, loadRef, currentRef, setPlaceRef]);

	// Xtream providers hand episodes out on request, so the focus comes here
	// from the favorite button once they're in.
	const loaded = episodes !== null && episodes.length > 0;
	useEffect(() => {
		// Stryker disable next-line LogicalOperator: the lists are on the page exactly while they're loaded, so these two are never different.
		if (loaded && listsRef.current) focusTvStart(listsRef.current);
	}, [loaded]);

	if (episodes === null || episodes.length === 0) {
		return (
			<p className="mt-[1rem] text-base opacity-70">
				{failed
					? "This provider didn't send the episodes. Press Back and try again."
					: episodes === null
						? "Loading episodes"
						: "This show has no episodes yet."}
			</p>
		);
	}

	const seasons = [...new Set(episodes.map((ep) => ep.season ?? 0))];
	const season = seasons[Math.min(place.season, seasons.length - 1)];
	const inSeason = episodes.filter((ep) => (ep.season ?? 0) === season);

	return (
		<div ref={listsRef} className="mt-auto flex gap-[1rem]">
			{seasons.length > 1 && (
				<TvList
					className="w-[11rem] shrink-0"
					items={seasons}
					label="Seasons"
					itemKey={(s) => String(s)}
					active={place.season}
					onActiveChange={(i) => setPlace({ season: i, episode: 0, inSeasons: true })}
					rowHeight={ROW_HEIGHT}
					height={LISTS_HEIGHT}
					start={place.inSeasons}
					itemClassName="rounded-[0.5rem]"
					renderItem={(s) => <TvTextRow label={seasonName(s)} />}
				/>
			)}
			<TvList
				className="min-w-0 flex-1"
				items={inSeason}
				label={seasonName(season)}
				itemKey={(ep) => ep.id}
				active={place.episode}
				onActiveChange={(i) => setPlace({ ...place, episode: i, inSeasons: false })}
				onSelect={(ep) => onPlay(ep, episodes)}
				rowHeight={ROW_HEIGHT}
				height={LISTS_HEIGHT}
				start={!place.inSeasons}
				itemClassName="rounded-[0.5rem]"
				renderItem={(ep) => <TvTextRow label={episodeLabel(ep)} />}
			/>
		</div>
	);
};
