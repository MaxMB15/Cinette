// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router";
import { Ellipsis, MonitorSmartphone, Pause, Play, Square, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Menu, MenuItem } from "@/components/ui/menu";
import { DevicePicker } from "@/components/remote/DevicePicker";
import { SendProvidersDialog } from "@/components/remote/SendProvidersDialog";
import { TransferHistoryDialog } from "@/components/remote/TransferHistoryDialog";
import { useNowPlaying } from "@/hooks/useNowPlaying";
import { useRemoteControl } from "@/hooks/useRemoteControl";
import { useTvNoticeFocus } from "@/hooks/useTvNoticeFocus";
import { useRemoteSessions, useTauriEvent } from "@/hooks/useRemoteTarget";
import { channelsQuery, providersQuery } from "@/lib/queries";
import { providersAddedText } from "@/lib/remote-transfer";
import {
	getVpnActive,
	remoteDisconnect,
	remoteLocalNetworkDenied,
	remoteOpen,
	type RemoteProvidersAdded,
} from "@/lib/tauri";
import { VPN_HINT } from "@/lib/cast";
import { cinetteEntries, cinetteId, LOCAL_ENTRY } from "@/lib/device-picker";
import type { PlaybackDestination } from "@/lib/destination";
import { nowPlaying } from "@/lib/now-playing";
import { endedText, formatCode, localNetworkDenied } from "@/lib/remote-devices";
import { getPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** At least 44 points each way on a touch screen, as iOS asks. */
const TOUCH = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

const BUTTON = cn(
	"px-3 py-1.5 text-xs rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
	TOUCH
);

/** The bar at the top while another device is controlled, and after its
 *  link ended by itself: one row, opaque, with the tint on top so the page
 *  doesn't show through. */
const BAR =
	"flex min-h-12 items-center gap-2 px-4 py-1.5 border-b border-border bg-card bg-linear-to-r from-primary/10 to-primary/10";

/** A button with only an icon. */
const ICON_BUTTON = cn("inline-flex items-center justify-center", TOUCH);

/**
 * Opens the device picker. While another device is controlled, it shows in
 * the primary color, so it's plain which device receives commands.
 */
export const DevicesButton = ({ className }: { className?: string }) => {
	const { devices, link, connect, leave } = useRemoteControl();
	const [leaveFailed, setLeaveFailed] = useState(false);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [denied, setDenied] = useState(false);
	const [vpn, setVpn] = useState(false);
	// Discovery gets a moment before the picker says it found nothing.
	const [looked, setLooked] = useState(false);
	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => setLooked(true), LOOKING_MS);
		return () => clearTimeout(timer);
	}, [open]);
	// Asked each time the picker opens, since the user can allow it meanwhile.
	const checkNetwork = () => {
		// Remote control may only start now, which is when iOS asks about the
		// local network.
		remoteOpen()
			.catch(() => {})
			.then(() => remoteLocalNetworkDenied())
			.then((refused) => setDenied(refused === true))
			.catch(() => setDenied(false));
		// Many VPN apps block devices on the local network.
		getVpnActive()
			.then((on) => setVpn(on === true))
			.catch(() => setVpn(false));
	};
	// Closed, it looks again from the start the next time it opens.
	const close = () => {
		setOpen(false);
		setLooked(false);
	};
	const activeId = link ? cinetteId(link.deviceId) : LOCAL_ENTRY.id;
	const select = (id: string) => {
		close();
		if (id === activeId) return;
		// Choosing this device is returning to independent playback.
		if (id === LOCAL_ENTRY.id) {
			setLeaveFailed(false);
			leave().catch(() => setLeaveFailed(true));
			return;
		}
		// The picker's rows come from this list, so the device is in it.
		const device = devices.find((d) => cinetteId(d.deviceId) === id)!;
		setError(null);
		connect(device).catch((e: unknown) => setError(String(e)));
	};
	return (
		<>
			<button
				type="button"
				title={link ? `Playing on ${link.name}` : "Play on another device"}
				aria-label={link ? `Devices, playing on ${link.name}` : undefined}
				aria-haspopup="dialog"
				onClick={() => setOpen(true)}
				className={cn(
					"flex flex-col items-center justify-center w-full py-3 gap-1 transition-colors",
					link ? "text-primary" : "text-muted-foreground hover:text-foreground",
					className
				)}
			>
				<MonitorSmartphone className="h-5 w-5" aria-hidden />
				<span className="text-[9px] font-medium leading-none">Devices</span>
			</button>
			<DevicePicker
				open={open}
				onClose={close}
				entries={cinetteEntries(devices)}
				activeId={activeId}
				onSelect={select}
				onOpen={checkNetwork}
				notice={
					denied
						? localNetworkDenied(getPlatform())
						: devices.length > 0
							? null
							: looked
								? vpn
									? `${NONE_FOUND} ${VPN_HINT}`
									: NONE_FOUND
								: LOOKING
				}
			/>
			{error && <Notice message={error} onDismiss={() => setError(null)} raised />}
			{leaveFailed && (
				<Notice message={LEAVE_FAILED} onDismiss={() => setLeaveFailed(false)} raised />
			)}
		</>
	);
};

/** How long the picker looks before it says it found no device. */
export const LOOKING_MS = 3000;

/** What the picker says while it hasn't found a device yet. */
export const LOOKING = "Looking for other Cinette devices on this network…";

/** What the picker says when it found no other device. */
export const NONE_FOUND =
	"No other Cinette device on this network yet. Cinette needs to be open on it, with discovery on.";

/** What shows when ending a session didn't work. */
export const LEAVE_FAILED =
	"Couldn't end the session. If the other device still shows this one, disconnect it there.";

/** A note at the bottom of the screen. A `raised` one sits above the
 *  others, so two don't cover each other. On a TV it takes the focus, so
 *  the remote can reach its Dismiss, and Back closes it. */
const Notice = ({
	message,
	onDismiss,
	raised = false,
}: {
	message: string;
	onDismiss: () => void;
	raised?: boolean;
}) => {
	const tv = useTvNoticeFocus(message, onDismiss);
	return createPortal(
		<div
			role="status"
			{...tv}
			className={cn(
				"fixed left-1/2 -translate-x-1/2 z-10000 flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2 text-sm shadow-xl max-w-[calc(100vw-2rem)] break-words",
				raised ? "bottom-20" : "bottom-4"
			)}
		>
			<span>{message}</span>
			<button
				type="button"
				aria-label="Dismiss"
				className={cn(ICON_BUTTON, "text-muted-foreground hover:text-foreground")}
				onClick={onDismiss}
			>
				<X className="h-4 w-4" aria-hidden />
			</button>
		</div>,
		document.body
	);
};

/**
 * While this device waits for another to let it in: the code to compare
 * with the one on that screen, and Cancel.
 */
export const ConnectStatusDialog = () => {
	const { link, leave } = useRemoteControl();
	const titleId = useId();
	const [leaveFailed, setLeaveFailed] = useState(false);
	const cancel = () => {
		setLeaveFailed(false);
		leave().catch(() => setLeaveFailed(true));
	};
	const failed = leaveFailed && (
		<Notice message={LEAVE_FAILED} onDismiss={() => setLeaveFailed(false)} raised />
	);
	const phase = link?.phase.phase;
	if (!link || (phase !== "connecting" && phase !== "verifying" && phase !== "pending"))
		return failed || null;
	const code = link.code;
	return (
		<>
			{failed}
			{createPortal(
				<Dialog
					onClose={cancel}
					labelledBy={titleId}
					overlayClassName="z-10000"
					className="bg-card border border-border rounded-lg p-5 w-[320px] max-w-[calc(100vw-2rem)] shadow-xl"
				>
					<h2 id={titleId} className="text-base font-semibold mb-1 break-words">
						{phase === "pending" ? "Waiting for " : "Connecting to "}
						<bdi className="font-bold">{link.name}</bdi>
						{phase === "pending" ? " to allow it" : ""}
					</h2>
					<p className="text-xs text-muted-foreground mb-4">
						{code
							? "Check that this code matches the one on that device."
							: "Looking for it on the network…"}
					</p>
					{code && (
						<p className="text-3xl font-mono font-semibold tracking-widest text-center mb-5">
							<span aria-hidden>{formatCode(code)}</span>
							<span className="sr-only">Code {code.split("").join(" ")}</span>
						</p>
					)}
					<div className="flex justify-end">
						<button
							type="button"
							className={`${BUTTON} hover:bg-accent`}
							onClick={cancel}
						>
							Cancel
						</button>
					</div>
				</Dialog>,
				document.body
			)}
		</>
	);
};

const useDestinationState = (destination: PlaybackDestination) =>
	useSyncExternalStore(destination.subscribe, destination.getState);

/** Play or Pause, and Stop, for what plays there. */
const PlayStop = ({ destination }: { destination: PlaybackDestination }) => {
	const state = useDestinationState(destination);
	const playing = state.status === "playing" || state.status === "buffering";
	const run = (action: () => Promise<void>) => void action().catch(() => {});
	if (!state.item) return null;
	return (
		<>
			{destination.capabilities.pause && (
				<button
					type="button"
					aria-label={playing ? "Pause" : "Play"}
					className={cn(ICON_BUTTON, "shrink-0 p-1 rounded hover:bg-accent")}
					onClick={() => run(playing ? destination.pause : destination.play)}
				>
					{playing ? (
						<Pause className="h-4 w-4" aria-hidden />
					) : (
						<Play className="h-4 w-4" aria-hidden />
					)}
				</button>
			)}
			<button
				type="button"
				aria-label="Stop"
				className={cn(ICON_BUTTON, "shrink-0 p-1 rounded hover:bg-accent")}
				onClick={() => run(destination.stop)}
			>
				<Square className="h-4 w-4" aria-hidden />
			</button>
		</>
	);
};

/** What plays there, under the device's name. */
const Title = ({ destination }: { destination: PlaybackDestination }) => {
	const state = useDestinationState(destination);
	return (
		<span className="block truncate text-sm">
			{state.item ? state.item.title : "Nothing playing"}
		</span>
	);
};

/**
 * The devices controlling this one, each with Disconnect, a reconnecting
 * one too. Shown on every page while any is, so they can be cut off at
 * any time.
 */
export const ControllersBar = () => {
	const sessions = useRemoteSessions();
	if (sessions.length === 0) return null;
	return (
		<div
			role="region"
			aria-label="Devices controlling this one"
			className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-border bg-primary/10 text-sm"
		>
			<MonitorSmartphone className="h-4 w-4 text-primary shrink-0" aria-hidden />
			<span className="font-medium">Controlled from</span>
			{sessions.map((s) => (
				<span key={s.sessionId} className="flex items-center gap-1 min-w-0">
					<bdi className="truncate max-w-64 font-medium" title={s.name}>
						{s.name}
					</bdi>
					{/* One that dropped can come back without asking for 30 s,
					    so it stays here, and can be cut off. */}
					{!s.connected && (
						<span className="text-xs text-muted-foreground shrink-0">
							Reconnecting…
						</span>
					)}
					<button
						type="button"
						className={`${BUTTON} shrink-0 hover:bg-accent`}
						aria-label={`Disconnect ${s.name}`}
						onClick={() => void remoteDisconnect(s.sessionId).catch(() => {})}
					>
						Disconnect
					</button>
				</span>
			))}
		</div>
	);
};

/**
 * A bar at the top of every page while another device is controlled: which
 * device receives commands, what plays there, and the way back to
 * independent playback. When a link ends by itself, it says why once.
 */
export const RemoteBar = () => {
	const { link, ended, leave } = useRemoteControl();
	const [dismissed, setDismissed] = useState<typeof ended>(null);
	const [leaveFailed, setLeaveFailed] = useState(false);
	// The link each dialog was opened for, so neither comes back by itself
	// on the next link.
	const [sendingFor, setSendingFor] = useState<number | null>(null);
	const [transferringFor, setTransferringFor] = useState<number | null>(null);
	// The link the menu was opened for, so it doesn't open by itself on the next.
	const [menuFor, setMenuFor] = useState<number | null>(null);
	// Leaving clears the link here before the backend answers, so this
	// shows whatever the bar shows by then.
	const failed = leaveFailed && (
		<Notice message={LEAVE_FAILED} onDismiss={() => setLeaveFailed(false)} raised />
	);
	if (link && (link.phase.phase === "connected" || link.phase.phase === "reconnecting")) {
		const connected = link.phase.phase === "connected";
		// Transfers need the session up, and a device that offers them.
		const actions = [
			connected &&
				link.features.includes("history") && {
					label: "Transfer history",
					run: () => setTransferringFor(link.id),
				},
			connected &&
				link.features.includes("providers") && {
					label: "Send providers",
					run: () => setSendingFor(link.id),
				},
			{
				label: "Return to independent playback",
				run: () => {
					setLeaveFailed(false);
					leave().catch(() => setLeaveFailed(true));
				},
			},
		].filter((action) => action !== false);
		return (
			<DestinationBar
				label="Remote control"
				destination={link.destination}
				heading={
					<>
						{connected ? "Playing on " : "Reconnecting to "}
						<bdi>{link.name}</bdi>
						{connected ? "" : "…"}
					</>
				}
				title={link.name}
				actions={actions}
				menuOpen={menuFor === link.id}
				onMenuOpenChange={(open) => setMenuFor(open ? link.id : null)}
			>
				{sendingFor === link.id && (
					<SendProvidersDialog link={link} onClose={() => setSendingFor(null)} />
				)}
				{transferringFor === link.id && (
					<TransferHistoryDialog link={link} onClose={() => setTransferringFor(null)} />
				)}
				{failed}
			</DestinationBar>
		);
	}
	const text = ended && ended !== dismissed ? endedText(ended.name, ended.reason) : null;
	return (
		<>
			{failed}
			{text && <EndedRow text={text} onDismiss={() => setDismissed(ended)} />}
		</>
	);
};

/** One thing the bar can do, inline from `sm` up and in its menu below. */
interface BarAction {
	label: string;
	run: () => void;
}

/**
 * The bar's one row while something plays elsewhere, like a music app's mini
 * player: the device and what plays there, which open the player, Play or
 * Pause and Stop, and its `actions`, in a menu on a phone. The player page
 * has its own Play and Stop, so there the bar has only the rest.
 */
const DestinationBar = ({
	label,
	destination,
	heading,
	title,
	actions,
	menuOpen,
	onMenuOpenChange,
	children,
}: {
	label: string;
	destination: PlaybackDestination;
	/** The line over the title, such as "Playing on <name>". */
	heading: ReactNode;
	/** The device's name in full, for when the heading is cut short. */
	title: string;
	actions: BarAction[];
	menuOpen: boolean;
	onMenuOpenChange: (open: boolean) => void;
	children?: ReactNode;
}) => {
	const onPlayer = useLocation().pathname === "/player";
	return (
		<div role="region" aria-label={label} className={BAR}>
			<MonitorSmartphone className="h-4 w-4 text-primary shrink-0" aria-hidden />
			<Link
				to="/player"
				className={cn(
					"min-w-0 flex-1 rounded focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
					TOUCH
				)}
			>
				<span className="block truncate text-xs text-muted-foreground" title={title}>
					{heading}
				</span>
				<Title destination={destination} />
			</Link>
			{!onPlayer && <PlayStop destination={destination} />}
			{!onPlayer && actions.length > 0 && (
				<span className="hidden sm:flex shrink-0 gap-1">
					{actions.map((action) => (
						<button
							key={action.label}
							type="button"
							className={`${BUTTON} hover:bg-accent`}
							onClick={action.run}
						>
							{action.label}
						</button>
					))}
				</span>
			)}
			{actions.length > 0 && (
				<span className={cn("shrink-0", !onPlayer && "sm:hidden")}>
					<Menu
						open={menuOpen}
						onOpenChange={onMenuOpenChange}
						trigger={(props) => (
							<button
								{...props}
								type="button"
								aria-label="More"
								className={cn(ICON_BUTTON, "p-1 rounded hover:bg-accent")}
							>
								<Ellipsis className="h-4 w-4" aria-hidden />
							</button>
						)}
						className="right-0 top-full mt-1 w-64 border border-border bg-card text-sm"
					>
						{actions.map((action) => (
							<MenuItem
								key={action.label}
								onSelect={action.run}
								className={cn("hover:bg-accent focus-visible:bg-accent", TOUCH)}
							>
								{action.label}
							</MenuItem>
						))}
					</Menu>
				</span>
			)}
			{children}
		</div>
	);
};

/** Why something that played elsewhere ended, in the bar's row, so the page
 *  doesn't move until it's dismissed. */
const EndedRow = ({ text, onDismiss }: { text: string; onDismiss: () => void }) => (
	<div role="status" className={cn(BAR, "text-sm")}>
		<MonitorSmartphone className="h-4 w-4 text-primary shrink-0" aria-hidden />
		<span className="min-w-0 flex-1 truncate" title={text}>
			{text}
		</span>
		<button
			type="button"
			aria-label="Dismiss"
			className={cn(ICON_BUTTON, "shrink-0 p-1 rounded hover:bg-accent")}
			onClick={onDismiss}
		>
			<X className="h-4 w-4" aria-hidden />
		</button>
	</div>
);

/**
 * The bar at the top of every page while a TV plays over AirPlay or Cast,
 * which goes on with the player page closed, or why one ended by itself.
 * A device this one controls has the bar to itself.
 */
export const TvBar = () => {
	const { destination, ended } = useNowPlaying();
	const { link } = useRemoteControl();
	const phase = link?.phase.phase;
	if (phase === "connected" || phase === "reconnecting") return null;
	if (destination)
		return (
			<DestinationBar
				label="Now playing"
				destination={destination}
				heading={
					<>
						{"Playing on "}
						<bdi>{destination.name}</bdi>
					</>
				}
				title={destination.name}
				actions={[]}
				menuOpen={false}
				onMenuOpenChange={() => {}}
			/>
		);
	return ended ? <EndedRow text={ended} onDismiss={nowPlaying.dismiss} /> : null;
};

/**
 * Says which providers another device sent were saved here, and loads the
 * provider and channel lists again, so they show without a restart.
 */
export const ProvidersAddedNotice = () => {
	const queryClient = useQueryClient();
	const [added, setAdded] = useState<RemoteProvidersAdded | null>(null);
	useTauriEvent<RemoteProvidersAdded>("remote://providers-added", (event) => {
		void queryClient.invalidateQueries({ queryKey: providersQuery().queryKey });
		void queryClient.invalidateQueries({ queryKey: channelsQuery().queryKey });
		setAdded(event);
	});
	return added ? (
		<Notice message={providersAddedText(added)} onDismiss={() => setAdded(null)} />
	) : null;
};
