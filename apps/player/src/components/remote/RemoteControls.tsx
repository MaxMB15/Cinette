// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { MonitorSmartphone, Pause, Play, Square, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { DevicePicker } from "@/components/remote/DevicePicker";
import { useRemoteControl } from "@/hooks/useRemoteControl";
import { useRemoteSessions } from "@/hooks/useRemoteTarget";
import { remoteDisconnect, remoteLocalNetworkDenied } from "@/lib/tauri";
import { cinetteEntries, cinetteId, LOCAL_ENTRY } from "@/lib/device-picker";
import type { CinetteDestination } from "@/lib/cinette-destination";
import { endedText, formatCode } from "@/lib/remote-devices";
import { cn } from "@/lib/utils";

const BUTTON = cn(
	"px-3 py-1.5 text-xs rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
);

/**
 * Opens the device picker. While another device is controlled, it shows in
 * the primary color, so it's plain which device receives commands.
 */
export const DevicesButton = ({ className }: { className?: string }) => {
	const { devices, link, connect, leave } = useRemoteControl();
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [denied, setDenied] = useState(false);
	// Asked each time the picker opens, since the user can allow it meanwhile.
	const checkNetwork = () => {
		remoteLocalNetworkDenied()
			.then((refused) => setDenied(refused === true))
			.catch(() => setDenied(false));
	};
	const activeId = link ? cinetteId(link.deviceId) : LOCAL_ENTRY.id;
	const select = (id: string) => {
		setOpen(false);
		if (id === activeId) return;
		// Choosing this device is returning to independent playback.
		if (id === LOCAL_ENTRY.id) {
			void leave();
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
				aria-label={link ? `Playing on ${link.name}` : "Play on another device"}
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
				onClose={() => setOpen(false)}
				entries={cinetteEntries(devices)}
				activeId={activeId}
				onSelect={select}
				onOpen={checkNetwork}
				notice={denied ? LOCAL_NETWORK_DENIED : null}
			/>
			{error && <Notice message={error} onDismiss={() => setError(null)} />}
		</>
	);
};

/** What the picker says while macOS keeps Cinette off the local network. */
export const LOCAL_NETWORK_DENIED =
	"Cinette can't look for other devices. Allow it under Local Network in System Settings, Privacy & Security.";

const Notice = ({ message, onDismiss }: { message: string; onDismiss: () => void }) =>
	createPortal(
		<div
			role="status"
			className="fixed bottom-4 left-1/2 -translate-x-1/2 z-10000 flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2 text-sm shadow-xl"
		>
			<span>{message}</span>
			<button
				type="button"
				aria-label="Dismiss"
				className="text-muted-foreground hover:text-foreground"
				onClick={onDismiss}
			>
				<X className="h-4 w-4" aria-hidden />
			</button>
		</div>,
		document.body
	);

/**
 * While this device waits for another to let it in: the code to compare
 * with the one on that screen, and Cancel.
 */
export const ConnectStatusDialog = () => {
	const { link, leave } = useRemoteControl();
	const titleId = useId();
	if (!link) return null;
	const { phase } = link;
	if (phase.phase !== "connecting" && phase.phase !== "verifying" && phase.phase !== "pending")
		return null;
	const code = link.code;
	return createPortal(
		<Dialog
			onClose={() => void leave()}
			labelledBy={titleId}
			overlayClassName="z-10000"
			className="bg-card border border-border rounded-lg p-5 w-[320px] max-w-[calc(100vw-2rem)] shadow-xl"
		>
			<h2 id={titleId} className="text-base font-semibold mb-1">
				{phase.phase === "pending"
					? `Waiting for ${link.name} to allow it`
					: `Connecting to ${link.name}`}
			</h2>
			<p className="text-xs text-muted-foreground mb-4">
				{code
					? "Check that this code matches the one on that device."
					: "Looking for it on the network…"}
			</p>
			{code && (
				<p
					className="text-3xl font-mono font-semibold tracking-widest text-center mb-5"
					aria-label={`Code ${code.split("").join(" ")}`}
				>
					{formatCode(code)}
				</p>
			)}
			<div className="flex justify-end">
				<button
					type="button"
					className={`${BUTTON} hover:bg-accent`}
					onClick={() => void leave()}
				>
					Cancel
				</button>
			</div>
		</Dialog>,
		document.body
	);
};

const useDestinationState = (destination: CinetteDestination) =>
	useSyncExternalStore(destination.subscribe, destination.getState);

const NowPlaying = ({ destination }: { destination: CinetteDestination }) => {
	const state = useDestinationState(destination);
	const playing = state.status === "playing" || state.status === "buffering";
	const caps = destination.capabilities;
	const run = (action: () => Promise<void>) => void action().catch(() => {});
	return (
		<div className="flex items-center gap-2 min-w-0">
			<span className="truncate text-xs text-muted-foreground">
				{state.item ? state.item.title : "Nothing playing"}
			</span>
			{state.item && caps.pause && (
				<button
					type="button"
					aria-label={playing ? "Pause" : "Play"}
					className="p-1 rounded hover:bg-accent"
					onClick={() => run(playing ? destination.pause : destination.play)}
				>
					{playing ? (
						<Pause className="h-4 w-4" aria-hidden />
					) : (
						<Play className="h-4 w-4" aria-hidden />
					)}
				</button>
			)}
			{state.item && (
				<button
					type="button"
					aria-label="Stop"
					className="p-1 rounded hover:bg-accent"
					onClick={() => run(destination.stop)}
				>
					<Square className="h-4 w-4" aria-hidden />
				</button>
			)}
		</div>
	);
};

/**
 * The devices controlling this one, each with Disconnect. Shown on every
 * page while any is connected, so they can be cut off at any time.
 */
export const ControllersBar = () => {
	const sessions = useRemoteSessions();
	const connected = sessions.filter((s) => s.connected);
	if (connected.length === 0) return null;
	return (
		<div
			role="region"
			aria-label="Devices controlling this one"
			className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-border bg-primary/10 text-sm"
		>
			<MonitorSmartphone className="h-4 w-4 text-primary shrink-0" aria-hidden />
			<span className="font-medium">Controlled from</span>
			{connected.map((s) => (
				<span key={s.sessionId} className="flex items-center gap-1">
					<span>{s.name}</span>
					<button
						type="button"
						className={`${BUTTON} hover:bg-accent`}
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
	if (link && (link.phase.phase === "connected" || link.phase.phase === "reconnecting")) {
		return (
			<div
				role="region"
				aria-label="Remote control"
				className="flex items-center gap-3 px-4 py-2 border-b border-border bg-primary/10 text-sm"
			>
				<MonitorSmartphone className="h-4 w-4 text-primary shrink-0" aria-hidden />
				<span className="font-medium shrink-0">
					{link.phase.phase === "reconnecting"
						? `Reconnecting to ${link.name}…`
						: `Playing on ${link.name}`}
				</span>
				<NowPlaying destination={link.destination} />
				<button
					type="button"
					className={`${BUTTON} ml-auto shrink-0 hover:bg-accent`}
					onClick={() => void leave()}
				>
					Return to independent playback
				</button>
			</div>
		);
	}
	const text = ended && ended !== dismissed ? endedText(ended.name, ended.reason) : null;
	if (!text) return null;
	return <Notice message={text} onDismiss={() => setDismissed(ended)} />;
};
