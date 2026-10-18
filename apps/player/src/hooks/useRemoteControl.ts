// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
	createRemoteControl,
	type RemoteControl,
	type RemoteControlState,
} from "@/lib/remote-control";
import { remoteCommand, remoteConnect, remoteDevices, remoteLeave } from "@/lib/tauri";

/** The app's one remote control, made on first use. */
let shared: RemoteControl | null = null;
/** How many components use it, so it follows events only while they do. */
let users = 0;
let stopping: Promise<() => void> | null = null;

export const remoteControl = (): RemoteControl => {
	shared ??= createRemoteControl({
		devices: remoteDevices,
		connect: remoteConnect,
		leave: remoteLeave,
		command: remoteCommand,
		listen: (event, handler) => listen(event, ({ payload }) => handler(payload as never)),
		now: performance.now.bind(performance),
	});
	return shared;
};

/**
 * The other Cinette devices and the one this device controls, kept up to
 * date while any component uses it.
 */
export const useRemoteControl = (): RemoteControlState & {
	connect: RemoteControl["connect"];
	leave: RemoteControl["leave"];
} => {
	const control = remoteControl();
	const state = useSyncExternalStore(control.subscribe, control.getState);
	useEffect(
		() => {
			users += 1;
			if (users === 1) stopping = control.start().catch(() => () => {});
			return () => {
				users -= 1;
				if (users === 0 && stopping) {
					const done = stopping;
					stopping = null;
					void done.then((stop) => stop());
				}
			};
		},
		// Stryker disable next-line ArrayDeclaration: control is the app's one store, so the effect runs once whatever the list holds.
		[control]
	);
	return { ...state, connect: control.connect, leave: control.leave };
};
