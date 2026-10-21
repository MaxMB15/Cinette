// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ConfirmDialog } from "@/components/downloads/ConfirmDialog";
import { useRemoteSessions } from "@/hooks/useRemoteTarget";
import { shortId } from "@/lib/device-picker";
import { deviceTypeName, discoveryLimit, fitName } from "@/lib/remote-devices";
import {
	remoteDisconnect,
	remoteGetSettings,
	remoteResetIdentity,
	remoteSetSettings,
	type RemoteControlMode,
	type RemoteSettings,
} from "@/lib/tauri";

/** What shows when the settings couldn't be saved. The device keeps
 *  them until Cinette quits, which the card then shows. */
export const SAVE_FAILED =
	"Couldn't save the remote control settings, so this lasts only until Cinette quits. Try again.";
/** What shows when a new identity couldn't be made. */
export const RESET_FAILED = "Couldn't reset the device identity. Try again.";
/** What shows once a new identity was made. */
export const RESET_DONE = "This device has a new identity. Other devices see it as new.";
/** What the card says when the remote control service didn't start. */
export const NOT_STARTED = "Remote control didn't start on this device.";
/** What the backend answers where remote control doesn't run at all. */
const UNAVAILABLE = "Remote control isn't available on this device yet.";

const MODES: { value: RemoteControlMode; label: string }[] = [
	{ value: "always", label: "Always allow" },
	{ value: "ask", label: "Only when allowed" },
	{ value: "never", label: "Never allow" },
];

/** What each choice means, all shown before one is made. */
export const MODE_TEXT: Record<RemoteControlMode, string> = {
	always: "Any device on this network can control playback here and browse what this device can play, with no dialog and no code to compare.",
	ask: "This device asks each time another one wants to control it, and shows a code to compare.",
	never: "No device can control this one, and choosing it ends every session.",
};

/** The warning Always allow is confirmed with. */
export const ALWAYS_WARNING = `${MODE_TEXT.always} Only choose this on a network you trust.`;

type Saveable = Pick<RemoteSettings, "discoverable" | "remoteControl" | "deviceName">;

const saveable = (s: Saveable): Saveable => ({
	discoverable: s.discoverable,
	remoteControl: s.remoteControl,
	deviceName: s.deviceName,
});

/**
 * Remote control between Cinette devices: whether others can find this
 * one, who may control it, its name, the devices controlling it now, and
 * a new identity. Shows nothing where remote control doesn't run.
 */
export const RemoteControlSettings = () => {
	// The settings shown, a change included before its save is back, and
	// the name as typed so far.
	const [form, setForm] = useState<{ settings: RemoteSettings; name: string } | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<"reset" | "always" | null>(null);
	const sessions = useRemoteSessions();
	// What the device runs, as its last answer said. Each save builds on
	// it when its turn comes, so a change that failed isn't sent again.
	const confirmedRef = useRef<RemoteSettings | null>(null);
	// Saves go one after another; only the newest one's answer shows.
	const queueRef = useRef<Promise<unknown>>(Promise.resolve());
	const latestRef = useRef({});

	useEffect(
		() => {
			let current = true;
			remoteGetSettings()
				.then((loaded) => {
					if (!current) return;
					confirmedRef.current = loaded;
					setForm({ settings: loaded, name: loaded.deviceName ?? "" });
				})
				.catch((e: unknown) => {
					if (current && e !== UNAVAILABLE) setLoadError(NOT_STARTED);
				});
			return () => {
				current = false;
			};
		},
		// Stryker disable next-line ArrayDeclaration: any list that never changes runs the effect once, as this one does.
		[]
	);

	if (loadError) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Remote control</CardTitle>
				</CardHeader>
				<CardContent>
					<p role="alert" className="text-xs text-red-500">
						{loadError}
					</p>
				</CardContent>
			</Card>
		);
	}
	if (!form) return null;
	const { settings, name } = form;
	const setName = (typed: string) => setForm({ settings, name: fitName(typed) });

	/** `running`, from the device, shown. The name field keeps what the
	 *  user typed since `typed` went out. */
	const show = (running: RemoteSettings, typed: string) => {
		confirmedRef.current = running;
		// The form is there: this runs only after it loaded.
		setForm((now) => ({
			settings: running,
			name: now!.name !== typed ? now!.name : (running.deviceName ?? ""),
		}));
	};

	const save = (change: Partial<Saveable>) => {
		setError(null);
		setDone(null);
		// It shows at once, so a second click builds on the first.
		setForm({ settings: { ...settings, ...change }, name });
		const typed = name;
		const mine = {};
		latestRef.current = mine;
		queueRef.current = queueRef.current
			.then(() =>
				// The form shows only once the settings loaded and set this.
				remoteSetSettings({ ...saveable(confirmedRef.current!), ...change })
			)
			.then((saved) => {
				confirmedRef.current = saved;
				if (mine === latestRef.current) show(saved, typed);
			})
			.catch(() =>
				// The device may run the change anyway, as Never allow does,
				// so the card shows what it runs.
				remoteGetSettings()
					.then((running) => {
						confirmedRef.current = running;
						if (mine === latestRef.current) show(running, typed);
					})
					.catch(() => {
						// With no answer either, it goes back to the last one.
						if (mine === latestRef.current) show(confirmedRef.current!, typed);
					})
					.finally(() => {
						if (mine === latestRef.current) setError(SAVE_FAILED);
					})
			);
	};

	const saveName = () => {
		const typed = name.trim();
		if (typed === (settings.deviceName ?? "")) return;
		save({ deviceName: typed === "" ? null : typed });
	};

	const chooseMode = (mode: RemoteControlMode) => {
		if (mode === settings.remoteControl) return;
		if (mode === "always") setConfirm("always");
		else save({ remoteControl: mode });
	};

	// When other devices can find this one, where that depends on the app.
	const limit = discoveryLimit();

	// Two devices with one name show the start of their ids.
	const named = new Map<string, number>();
	for (const s of sessions) named.set(s.name, (named.get(s.name) ?? 0) + 1);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Remote control</CardTitle>
			</CardHeader>
			<CardContent className="space-y-5">
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm font-medium">Discoverable on this network</p>
						<p className="text-xs text-muted-foreground">
							Lets other Cinette devices on this network find this one. Turning this
							off stops new connections. Devices already connected stay connected
							until you disconnect them.
							{limit && ` ${limit}`}
						</p>
					</div>
					<Button
						variant={settings.discoverable ? undefined : "secondary"}
						size="sm"
						aria-label="Discoverable on this network"
						aria-pressed={settings.discoverable}
						onClick={() => save({ discoverable: !settings.discoverable })}
					>
						{settings.discoverable ? "On" : "Off"}
					</Button>
				</div>

				<div>
					<p className="text-sm font-medium mb-2">Remote control</p>
					<SegmentedControl
						aria-label="Remote control"
						value={settings.remoteControl}
						onChange={chooseMode}
						options={MODES}
					/>
					<dl className="text-xs text-muted-foreground mt-2 space-y-1">
						{MODES.map(({ value, label }) => (
							<div key={value}>
								<dt className="inline font-medium text-foreground">{label}: </dt>
								<dd className="inline">{MODE_TEXT[value]}</dd>
							</div>
						))}
					</dl>
				</div>

				<div>
					<label htmlFor="remote-device-name" className="text-sm font-medium">
						Device name
					</label>
					<p className="text-xs text-muted-foreground mb-2">
						What other devices call this one.
					</p>
					<Input
						id="remote-device-name"
						value={name}
						placeholder={settings.defaultName}
						onChange={(e) => setName(e.target.value)}
						onBlur={saveName}
						onKeyDown={(e) => {
							if (e.key === "Enter") saveName();
						}}
					/>
				</div>

				<div>
					<p className="text-sm font-medium mb-2">Connected devices</p>
					{sessions.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No device is controlling this one.
						</p>
					) : (
						<ul className="space-y-2">
							{sessions.map((s) => {
								const tag =
									named.get(s.name)! > 1 ? ` · ${shortId(s.deviceId)}` : "";
								return (
									<li
										key={s.sessionId}
										className="flex items-center justify-between gap-3"
									>
										<span className="text-sm min-w-0 break-words">
											<bdi className="font-medium">{s.name}</bdi>
											<span className="text-xs text-muted-foreground">
												{" "}
												· {deviceTypeName(s.deviceType)}
												{tag}
												{s.connected ? "" : " · reconnecting"}
											</span>
										</span>
										<Button
											variant="secondary"
											size="sm"
											className="shrink-0"
											aria-label={`Disconnect ${s.name}${tag}`}
											onClick={() =>
												void remoteDisconnect(s.sessionId).catch(() => {})
											}
										>
											Disconnect
										</Button>
									</li>
								);
							})}
						</ul>
					)}
				</div>

				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm font-medium">Reset device identity</p>
						<p className="text-xs text-muted-foreground">
							Other devices see this one as new, and every session ends.
						</p>
					</div>
					<Button variant="secondary" size="sm" onClick={() => setConfirm("reset")}>
						Reset
					</Button>
				</div>

				{error && (
					<p role="alert" className="text-xs text-red-500">
						{error}
					</p>
				)}
				{done && (
					<p role="status" className="text-xs text-muted-foreground">
						{done}
					</p>
				)}
			</CardContent>
			<ConfirmDialog
				open={confirm === "reset"}
				title="Reset device identity?"
				message="Every device controlling this one is disconnected, and other devices see this one as new."
				confirmLabel="Reset"
				onCancel={() => setConfirm(null)}
				onConfirm={() => {
					setConfirm(null);
					setError(null);
					setDone(null);
					remoteResetIdentity()
						.then(({ deviceId, defaultName }) => {
							// A reset changes only who this device is. A save
							// still on its way says what it runs.
							confirmedRef.current = {
								...confirmedRef.current!,
								deviceId,
								defaultName,
							};
							setForm((now) => ({
								settings: { ...now!.settings, deviceId, defaultName },
								name: now!.name,
							}));
							setDone(RESET_DONE);
						})
						.catch(() => setError(RESET_FAILED));
				}}
			/>
			<ConfirmDialog
				open={confirm === "always"}
				title="Always allow remote control?"
				message={ALWAYS_WARNING}
				confirmLabel="Always allow"
				onCancel={() => setConfirm(null)}
				onConfirm={() => {
					setConfirm(null);
					save({ remoteControl: "always" });
				}}
			/>
		</Card>
	);
};
