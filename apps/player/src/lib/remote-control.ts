// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * This device as a controller: the other Cinette devices on the network,
 * and the one it controls, if any, as a {@link CinetteDestination}.
 *
 * One device is controlled at a time. Choosing "This device" again is
 * leaving, which ends the session; the other device keeps playing.
 */

import {
	createCinetteDestination,
	type CinetteDestination,
	type LinkEnded,
	type LinkPhase,
	type RemoteSnapshot,
} from "@/lib/cinette-destination";
import type { RemoteCommand } from "@/lib/remote-target";
import type { RemoteDevice } from "@/lib/tauri";

/** The device this one controls, and how the connection stands. */
export interface Link {
	deviceId: string;
	name: string;
	phase: LinkPhase;
	destination: CinetteDestination;
}

export interface RemoteControlState {
	devices: RemoteDevice[];
	link: Link | null;
	/** The last link that ended, and why, until another starts. */
	ended: { name: string; reason: LinkEnded } | null;
}

/** What the store needs from the backend. */
export interface RemoteControlBackend {
	devices(): Promise<RemoteDevice[]>;
	connect(deviceId: string): Promise<void>;
	leave(): Promise<void>;
	command(command: RemoteCommand): Promise<unknown>;
	listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
	/** `performance.now()`. */
	now(): number;
}

export interface RemoteControl {
	getState(): RemoteControlState;
	subscribe(listener: () => void): () => void;
	/** Starts following the backend's events. Returns how to stop. */
	start(): Promise<() => void>;
	/** Asks `device` for control, leaving any device controlled now. */
	connect(device: RemoteDevice): Promise<void>;
	/** Ends the session, or stops asking. */
	leave(): Promise<void>;
}

type ControllerEvent = { deviceId: string } & LinkPhase;
type StateEvent = {
	deviceId: string;
	state: { epoch: string; version: number; state: RemoteSnapshot };
};

export const createRemoteControl = (backend: RemoteControlBackend): RemoteControl => {
	let state: RemoteControlState = { devices: [], link: null, ended: null };
	const listeners = new Set<() => void>();
	const set = (next: Partial<RemoteControlState>) => {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};

	const onPhase = ({ deviceId, ...phase }: ControllerEvent) => {
		const link = state.link;
		if (link?.deviceId !== deviceId) return;
		link.destination.setPhase(phase);
		if (phase.phase === "closed") {
			set({ link: null, ended: { name: link.name, reason: phase.reason } });
		} else {
			set({ link: { ...link, phase } });
		}
	};

	const onState = ({ deviceId, state: versioned }: StateEvent) => {
		const link = state.link;
		if (link?.deviceId !== deviceId) return;
		link.destination.receive(versioned.state, backend.now());
	};

	return {
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		start: async () => {
			const stops = await Promise.all([
				backend.listen<RemoteDevice[]>("remote://devices", (devices) => set({ devices })),
				backend.listen<ControllerEvent>("remote://controller", onPhase),
				backend.listen<StateEvent>("remote://state", onState),
			]);
			// Events that came before listening started are in this list.
			backend
				.devices()
				.then((devices) => set({ devices }))
				.catch(() => {});
			return () => {
				for (const stop of stops) stop();
			};
		},
		connect: async (device) => {
			const destination = createCinetteDestination(device.deviceId, device.name, (c) =>
				backend.command(c)
			);
			set({
				link: {
					deviceId: device.deviceId,
					name: device.name,
					phase: { phase: "connecting" },
					destination,
				},
				ended: null,
			});
			try {
				await backend.connect(device.deviceId);
			} catch (e) {
				if (state.link?.destination === destination) set({ link: null });
				throw e;
			}
		},
		leave: async () => {
			set({ link: null });
			await backend.leave();
		},
	};
};
