// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ConfirmDialog } from "@/components/downloads/ConfirmDialog";
import { useRemoteSessions } from "@/hooks/useRemoteTarget";
import { deviceTypeName } from "@/lib/remote-devices";
import {
	remoteDisconnect,
	remoteGetSettings,
	remoteResetIdentity,
	remoteSetSettings,
	type RemoteControlMode,
	type RemoteSettings,
} from "@/lib/tauri";

const MODES: { value: RemoteControlMode; label: string }[] = [
	{ value: "always", label: "Always allow" },
	{ value: "ask", label: "Only when allowed" },
	{ value: "never", label: "Never allow" },
];

const MODE_TEXT: Record<RemoteControlMode, string> = {
	always: "Any device on this network can control playback here, with no dialog and no code to compare. Only choose this on a network you trust.",
	ask: "This device asks each time another one wants to control it, and shows a code to compare.",
	never: "No device can control this one. Choosing this ends every session now.",
};

/**
 * Remote control between Cinette devices: whether others can find this
 * one, who may control it, its name, the devices controlling it now, and
 * a new identity. Shows nothing where remote control doesn't run.
 */
export const RemoteControlSettings = () => {
	// The saved settings, and the name as typed so far.
	const [form, setForm] = useState<{ settings: RemoteSettings; name: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmReset, setConfirmReset] = useState(false);
	const sessions = useRemoteSessions();

	const show = (settings: RemoteSettings) =>
		setForm({ settings, name: settings.deviceName ?? "" });

	useEffect(
		() => {
			let current = true;
			remoteGetSettings()
				.then((loaded) => {
					if (current) show(loaded);
				})
				.catch(() => {});
			return () => {
				current = false;
			};
		},
		// Stryker disable next-line ArrayDeclaration: any list that never changes runs the effect once, as this one does.
		[]
	);

	if (!form) return null;
	const { settings, name } = form;
	const setName = (typed: string) => setForm({ settings, name: typed });

	const save = (
		change: Partial<Pick<RemoteSettings, "discoverable" | "remoteControl" | "deviceName">>
	) => {
		setError(null);
		remoteSetSettings({
			discoverable: settings.discoverable,
			remoteControl: settings.remoteControl,
			deviceName: settings.deviceName,
			...change,
		})
			.then(show)
			.catch((e: unknown) => setError(`Couldn't save: ${String(e)}`));
	};

	const saveName = () => {
		const typed = name.trim();
		if (typed === (settings.deviceName ?? "")) return;
		save({ deviceName: typed === "" ? null : typed });
	};

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
						value={settings.remoteControl}
						onChange={(mode) => save({ remoteControl: mode })}
						options={MODES}
					/>
					<p className="text-xs text-muted-foreground mt-2">
						{MODE_TEXT[settings.remoteControl]}
					</p>
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
						maxLength={63}
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
							{sessions.map((s) => (
								<li
									key={s.sessionId}
									className="flex items-center justify-between gap-3"
								>
									<span className="text-sm">
										{s.name}
										<span className="text-xs text-muted-foreground">
											{" "}
											· {deviceTypeName(s.deviceType)}
											{s.connected ? "" : " · reconnecting"}
										</span>
									</span>
									<Button
										variant="secondary"
										size="sm"
										aria-label={`Disconnect ${s.name}`}
										onClick={() =>
											void remoteDisconnect(s.sessionId).catch(() => {})
										}
									>
										Disconnect
									</Button>
								</li>
							))}
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
					<Button variant="secondary" size="sm" onClick={() => setConfirmReset(true)}>
						Reset
					</Button>
				</div>

				{error && (
					<p role="alert" className="text-xs text-red-500">
						{error}
					</p>
				)}
			</CardContent>
			<ConfirmDialog
				open={confirmReset}
				title="Reset device identity?"
				message="Every device controlling this one is disconnected, and other devices see this one as new."
				confirmLabel="Reset"
				onCancel={() => setConfirmReset(false)}
				onConfirm={() => {
					setConfirmReset(false);
					remoteResetIdentity()
						.then(show)
						.catch((e: unknown) => setError(`Couldn't reset: ${String(e)}`));
				}}
			/>
		</Card>
	);
};
