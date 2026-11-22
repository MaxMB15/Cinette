// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { Database, Info, KeyRound, SlidersHorizontal, Smartphone } from "lucide-react";
import { KeyStatus } from "@/components/settings/ApiKeyField";
import {
	LEGAL_COPYRIGHT,
	LEGAL_CREDIT,
	LEGAL_LICENSE,
	legalLinks,
} from "@/components/settings/LegalNotices";
import {
	OMDB_KEY,
	OPENSUBTITLES_KEY,
	SKIP_CHOICES,
	SKIP_SEGMENT_CHOICES,
} from "@/components/settings/Settings";
import { useApiKey, type ApiKeyState } from "@/hooks/useApiKey";
import { usePlayerPref } from "@/hooks/usePlayerPref";
import {
	ALWAYS_WARNING,
	MODE_TEXT,
	REMOTE_MODES,
	useRemoteControlSettings,
} from "@/hooks/useRemoteControlSettings";
import { useTvTasks } from "@/hooks/useTvTasks";
import {
	LIVE_REWIND_EVENT,
	LIVE_REWIND_OPTIONS,
	MAX_VOLUME,
	SKIP_INTERVALS_EVENT,
	SKIP_SEGMENT_MODES_EVENT,
	readDefaultVolume,
	readHwdecEnabled,
	readLiveRewind,
	readSkipIntervals,
	readSkipSegmentModes,
	writeDefaultVolume,
	writeHwdecEnabled,
	writeLiveRewind,
	writeSkipInterval,
	writeSkipSegmentMode,
} from "@/lib/player-prefs";
import { clearCacheData, clearHistoryData } from "@/lib/queries";
import { TvPrompt } from "./TvPrompt";
import { useTvProviderSections } from "./TvProviders";
import {
	TvSettingsColumns,
	choiceRow,
	toggleRow,
	type TvSetting,
	type TvSettingsSection,
} from "./TvSettingsColumns";
import { TvButton } from "./ui";

const VOLUME_CHOICES = [25, 50, 75, 100, MAX_VOLUME].map((n) => ({ value: n, label: `${n}%` }));
const REWIND_CHOICES = LIVE_REWIND_OPTIONS.map((n) => ({ value: n, label: `${n} min` }));

const SKIP_TIMES_NOTE =
	"Skip times need an OMDb key under Services, and only some movies and series have them. They come from SkipDB, under the ODbL 1.0, and from IntroDB. People add the times by hand, so a few may be off. When the player can't be sure they fit the video, Automatic shows the button instead.";

/** A row that enters an API key, saves it when Done is pressed, and checks it unless it was cleared. */
const keyRow = (
	id: string,
	name: string,
	field: ApiKeyState,
	about: string,
	getKey: string,
	validNote?: string
): TvSetting => ({
	id,
	label: `${name} key`,
	value: field.saved ? "Saved" : "Not set",
	busy: field.saveStatus === "saving" || field.testStatus === "testing",
	hint: (
		<>
			<p>{about}</p>
			{!field.saved && <p>{getKey}</p>}
			<div role="status" className="mt-[0.5rem] text-base opacity-100">
				<KeyStatus field={field} validNote={validNote} />
			</div>
		</>
	),
	entry: {
		title: `${name} API key`,
		value: field.saved,
		onDone: (text) => {
			void field.save(text).then(() => field.test(text));
		},
	},
});

/**
 * Settings for the remote, in columns like every other TV screen. It leaves out
 * what a TV has no use for: downloads, updates and Manage Categories' AI key.
 */
export const TvSettings = () => {
	const queryClient = useQueryClient();
	const [hwdec, setHwdec] = useState(readHwdecEnabled);
	const [volume, setVolume] = useState(readDefaultVolume);
	const skips = usePlayerPref(readSkipIntervals, SKIP_INTERVALS_EVENT);
	const segments = usePlayerPref(readSkipSegmentModes, SKIP_SEGMENT_MODES_EVENT);
	const rewind = usePlayerPref(readLiveRewind, LIVE_REWIND_EVENT);
	const omdb = useApiKey(OMDB_KEY);
	const openSubtitles = useApiKey(OPENSUBTITLES_KEY);
	const remote = useRemoteControlSettings();
	const tasks = useTvTasks();
	const providerSections = useTvProviderSections();
	const [version, setVersion] = useState("");

	useEffect(
		() => {
			getVersion()
				.then(setVersion)
				.catch(() => {});
		},
		// Stryker disable next-line ArrayDeclaration: any constant list runs the effect once, as an empty one does.
		[]
	);

	const clearRow = (
		id: string,
		label: string,
		message: string,
		clear: () => Promise<void>,
		done: string,
		failed: string
	): TvSetting => ({
		id,
		label,
		busy: tasks.busy(id),
		hint: tasks.message(id),
		confirm: {
			title: `${label}?`,
			message,
			label: "Clear",
			onConfirm: () =>
				tasks.run(id, () =>
					clear().then(
						() => done,
						() => failed
					)
				),
		},
	});

	const playback: TvSettingsSection = {
		id: "playback",
		label: "Playback",
		icon: <SlidersHorizontal aria-hidden />,
		settings: [
			toggleRow(
				"hwdec",
				"Hardware decoding",
				hwdec,
				(on) => {
					setHwdec(on);
					writeHwdecEnabled(on);
				},
				"Turn this off if video shows artifacts or green frames. It applies to the next video you play."
			),
			choiceRow(
				"volume",
				"Default volume",
				VOLUME_CHOICES,
				volume,
				(n) => {
					setVolume(n);
					writeDefaultVolume(n);
				},
				"Playback starts at this volume."
			),
			choiceRow(
				"skip-back",
				"Skip back",
				SKIP_CHOICES,
				skips.back,
				(n) => writeSkipInterval("back", n),
				"How far Left goes back in the player."
			),
			choiceRow(
				"skip-forward",
				"Skip forward",
				SKIP_CHOICES,
				skips.forward,
				(n) => writeSkipInterval("forward", n),
				"How far Right goes forward in the player."
			),
			choiceRow(
				"live-rewind",
				"Live rewind",
				REWIND_CHOICES,
				rewind.minutes,
				writeLiveRewind,
				"How far back you can go on a live channel. More minutes use more memory. It applies to the next channel you play."
			),
			choiceRow(
				"openings",
				"Intros and recaps",
				SKIP_SEGMENT_CHOICES,
				segments.opening,
				(mode) => writeSkipSegmentMode("opening", mode),
				SKIP_TIMES_NOTE
			),
			choiceRow(
				"endings",
				"Credits and previews",
				SKIP_SEGMENT_CHOICES,
				segments.ending,
				(mode) => writeSkipSegmentMode("ending", mode),
				SKIP_TIMES_NOTE
			),
		],
	};

	const services: TvSettingsSection = {
		id: "services",
		label: "Services",
		icon: <KeyRound aria-hidden />,
		settings: [
			keyRow(
				"omdb",
				"OMDb",
				omdb,
				"Adds details and ratings to movies and series. With a key set, the app sends titles to OMDb, and IMDb IDs to whatson-api for more ratings and to SkipDB and IntroDB for skip times.",
				"Get a free key at omdbapi.com",
				"Free keys allow 1,000 calls a day."
			),
			...(omdb.saved || openSubtitles.saved
				? [
						keyRow(
							"opensubtitles",
							"OpenSubtitles",
							openSubtitles,
							"Finds subtitles for movies and episodes in the player. The app sends their IMDb IDs to OpenSubtitles.",
							"Get a key at opensubtitles.com"
						),
					]
				: []),
		],
	};

	const { form } = remote;
	const remoteControl: TvSettingsSection | null =
		form || remote.loadError
			? {
					id: "remote",
					label: "Remote control",
					icon: <Smartphone aria-hidden />,
					aside: (remote.loadError || remote.error || remote.done) && (
						<p role="status" className="text-base opacity-100">
							{remote.loadError ?? remote.error ?? remote.done}
						</p>
					),
					settings: form
						? [
								toggleRow(
									"discoverable",
									"Discoverable on this network",
									form.settings.discoverable,
									(on) => remote.save({ discoverable: on }),
									<p>
										Lets other Cinette devices on this network find this one.
										Turning this off stops new connections. Devices already
										connected stay connected until you disconnect them.
										{remote.limit && ` ${remote.limit}`}
									</p>
								),
								{
									...choiceRow(
										"mode",
										"Remote control",
										REMOTE_MODES,
										form.settings.remoteControl,
										remote.chooseMode
									),
									choices: REMOTE_MODES.map(({ value, label }) => ({
										label,
										selected: value === form.settings.remoteControl,
										onPick: () => remote.chooseMode(value),
										hint: MODE_TEXT[value],
									})),
								},
								{
									id: "name",
									label: "Device name",
									value: form.name || form.settings.defaultName,
									hint: "What other devices call this one.",
									entry: {
										title: "Device name",
										value: form.name || form.settings.defaultName,
										onDone: remote.saveName,
									},
								},
								...(remote.sessionRows.length > 0
									? remote.sessionRows.map((row) => ({
											id: `session/${row.key}`,
											label: row.name,
											value: "Disconnect",
											hint: `Connected: ${row.name}${row.detail}`,
											onSelect: row.act,
										}))
									: [
											{
												id: "sessions",
												label: "Connected devices",
												value: "None",
												hint: "No device is controlling this one.",
											},
										]),
								...(remote.blockedRows.length > 0
									? remote.blockedRows.map((row) => ({
											id: `blocked/${row.key}`,
											label: row.name,
											value: "Unblock",
											hint: `Blocked: ${row.name}${row.detail}`,
											onSelect: row.act,
										}))
									: [
											{
												id: "blocked",
												label: "Blocked devices",
												value: "None",
												hint: "No device is blocked. Denying a request to control this device blocks the device that asked.",
											},
										]),
								{
									id: "reset",
									label: "Reset device identity",
									hint: "Other devices see this one as new, and every session ends.",
									confirm: {
										title: "Reset device identity?",
										message:
											"Every device controlling this one is disconnected, and other devices see this one as new.",
										label: "Reset",
										onConfirm: remote.resetIdentity,
									},
								},
							]
						: [],
				}
			: null;

	const data: TvSettingsSection = {
		id: "data",
		label: "History and cache",
		icon: <Database aria-hidden />,
		settings: [
			clearRow(
				"history",
				"Clear watch history",
				"This can't be undone.",
				() => clearHistoryData(queryClient),
				"Watch history cleared.",
				"Couldn't clear the watch history. Try again."
			),
			clearRow(
				"caches",
				"Clear caches",
				"This clears cached movie and series details, guide data, episode lists and downloaded subtitles. It can't be undone.",
				() => clearCacheData(queryClient),
				"Caches cleared.",
				"Couldn't clear the caches. Try again."
			),
		],
	};

	const about: TvSettingsSection = {
		id: "about",
		label: "About",
		icon: <Info aria-hidden />,
		aside: (
			<>
				<p>{LEGAL_CREDIT}</p>
				<p>{LEGAL_COPYRIGHT}</p>
				<p>{LEGAL_LICENSE}</p>
			</>
		),
		settings: [
			{ id: "version", label: "Version", value: version },
			...legalLinks(version || undefined).map(({ label, url }) => ({
				id: label,
				label,
				hint: <p className="break-all">{url}</p>,
			})),
		],
	};

	return (
		<>
			<TvSettingsColumns
				title="Settings"
				memoryKey="settings"
				groups={[
					{ label: "Providers", sections: providerSections },
					{
						label: "App",
						sections: [
							playback,
							services,
							...(remoteControl ? [remoteControl] : []),
							data,
							about,
						],
					},
				]}
			/>
			{remote.confirm === "always" && (
				<TvPrompt
					title="Always allow remote control?"
					text={ALWAYS_WARNING}
					onClose={() => remote.setConfirm(null)}
				>
					<TvButton onClick={() => remote.setConfirm(null)}>Cancel</TvButton>
					<TvButton onClick={remote.allowAlways}>Always allow</TvButton>
				</TvPrompt>
			)}
		</>
	);
};
