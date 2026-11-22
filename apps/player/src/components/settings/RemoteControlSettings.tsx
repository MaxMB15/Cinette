// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ConfirmDialog } from "@/components/downloads/ConfirmDialog";
import { TOUCH } from "@/components/remote/RemoteControls";
import {
	ALWAYS_WARNING,
	MODE_TEXT,
	REMOTE_MODES,
	useRemoteControlSettings,
	type RemoteDeviceRow,
} from "@/hooks/useRemoteControlSettings";
import { getPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { localNetworkDenied } from "@/lib/remote-devices";

export {
	ALWAYS_WARNING,
	MODE_TEXT,
	NOT_STARTED,
	RESET_DONE,
	RESET_FAILED,
	SAVE_FAILED,
	UNBLOCK_FAILED,
} from "@/hooks/useRemoteControlSettings";

/**
 * Remote control between Cinette devices: whether others can find this
 * one, who may control it, its name, the devices controlling it now, and
 * a new identity. Shows nothing where remote control doesn't run.
 */
export const RemoteControlSettings = () => {
	const {
		form,
		loadError,
		error,
		done,
		denied,
		confirm,
		setConfirm,
		setName,
		save,
		saveName,
		chooseMode,
		allowAlways,
		resetIdentity,
		sessionRows,
		blockedRows,
		limit,
	} = useRemoteControlSettings();

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
						{denied && (
							<p role="status" className="text-xs text-amber-500 mt-1">
								{localNetworkDenied(getPlatform())}
							</p>
						)}
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
						options={REMOTE_MODES}
					/>
					<dl className="text-xs text-muted-foreground mt-2 space-y-1">
						{REMOTE_MODES.map(({ value, label }) => (
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
						onBlur={() => saveName()}
						onKeyDown={(e) => {
							if (e.key === "Enter") saveName();
						}}
					/>
				</div>

				<DeviceList
					title="Connected devices"
					empty="No device is controlling this one."
					action="Disconnect"
					rows={sessionRows}
				/>

				<DeviceList
					title="Blocked devices"
					empty="No device is blocked. Denying a request to control this device blocks the device that asked."
					action="Unblock"
					rows={blockedRows}
				/>

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
				onConfirm={resetIdentity}
			/>
			<ConfirmDialog
				open={confirm === "always"}
				title="Always allow remote control?"
				message={ALWAYS_WARNING}
				confirmLabel="Always allow"
				onCancel={() => setConfirm(null)}
				onConfirm={allowAlways}
			/>
		</Card>
	);
};

/**
 * Other devices, each with one action, or `empty` when there are none.
 * Once an action takes its row away, focus goes to the row now in its
 * place, or to the heading, so a keyboard or TV remote isn't left on
 * nothing.
 */
const DeviceList = ({
	title,
	empty,
	action,
	rows,
}: {
	title: string;
	empty: string;
	action: string;
	rows: RemoteDeviceRow[];
}) => {
	const headingRef = useRef<HTMLParagraphElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	// The row whose action was used last, and where it was, until it goes.
	// An effect of an earlier render that runs after the press, while the
	// row is still there, leaves it alone.
	const acted = useRef<{ at: number; key: string } | null>(null);
	useEffect(() => {
		const pressed = acted.current;
		if (pressed === null || rows.some((row) => row.key === pressed.key)) return;
		acted.current = null;
		if (document.activeElement !== document.body) return;
		const buttons = listRef.current?.querySelectorAll("button") ?? [];
		// Stryker disable next-line OptionalChaining: the heading renders with the list, so it's never null here.
		(buttons[Math.min(pressed.at, buttons.length - 1)] ?? headingRef.current)?.focus();
	}, [rows]);
	return (
		<div>
			<p ref={headingRef} tabIndex={-1} className="text-sm font-medium mb-2 outline-hidden">
				{title}
			</p>
			{rows.length === 0 ? (
				<p className="text-xs text-muted-foreground">{empty}</p>
			) : (
				<ul ref={listRef} className="space-y-2">
					{rows.map((row, i) => (
						<li key={row.key} className="flex items-center justify-between gap-3">
							<span className="text-sm min-w-0 break-words">
								<bdi className="font-medium">{row.name}</bdi>
								<span className="text-xs text-muted-foreground">{row.detail}</span>
							</span>
							<Button
								variant="secondary"
								size="sm"
								className={cn("shrink-0", TOUCH)}
								aria-label={`${action} ${row.name}${row.tag}`}
								onClick={() => {
									acted.current = { at: i, key: row.key };
									row.act();
								}}
							>
								{action}
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
};
