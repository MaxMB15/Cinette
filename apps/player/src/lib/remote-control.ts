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
	type VersionedSnapshot,
} from "@/lib/cinette-destination";
import type { RemoteCommand } from "@/lib/remote-target";
import type { RemoteDevice } from "@/lib/tauri";

/** The device this one controls, and how the connection stands. */
export interface Link {
	/** The number its events carry, and its commands name. */
	id: number;
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
	connect(deviceId: string, link: number): Promise<void>;
	/** The link the backend holds, which a reloaded page may not know. */
	current(): Promise<number | null>;
	/** Ends link `link`, and no other that took its place. */
	leave(link: number): Promise<void>;
	command(link: number, command: RemoteCommand): Promise<unknown>;
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

type ControllerEvent = { deviceId: string; link: number } & LinkPhase;
type StateEvent = {
	deviceId: string;
	link: number;
	state: VersionedSnapshot;
};

/** Link numbers, starting from the time so a reloaded page picks new ones. */
let lastLink = Date.now();

export const createRemoteControl = (backend: RemoteControlBackend): RemoteControl => {
	let state: RemoteControlState = { devices: [], link: null, ended: null };
	const listeners = new Set<() => void>();
	const set = (next: Partial<RemoteControlState>) => {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};

	const onPhase = ({ deviceId, link: id, ...phase }: ControllerEvent) => {
		const link = state.link;
		if (link?.id !== id || link.deviceId !== deviceId) return;
		link.destination.setPhase(phase);
		if (phase.phase === "closed") {
			set({ link: null, ended: { name: link.name, reason: phase.reason } });
		} else if (phase.phase === "verifying") {
			// The name the device gave once its key was checked.
			set({ link: { ...link, name: phase.name, phase } });
		} else {
			set({ link: { ...link, phase } });
		}
	};

	const onState = ({ deviceId, link: id, state: versioned }: StateEvent) => {
		const link = state.link;
		if (link?.id !== id || link.deviceId !== deviceId) return;
		link.destination.receive(versioned, backend.now());
	};

	/** Ends `link` here: its destination hears it closed. */
	const drop = (link: Link | null) => {
		// Stryker disable next-line StringLiteral: a destination reads only that the phase is closed, not why.
		link?.destination.setPhase({ phase: "closed", reason: "left" });
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
			// A link from before the page reloaded has no one to show it.
			backend
				.current()
				.then((held) => {
					if (held !== null && held !== state.link?.id) void backend.leave(held);
				})
				.catch(() => {});
			return () => {
				for (const stop of stops) stop();
			};
		},
		connect: async (device) => {
			lastLink += 1;
			const id = lastLink;
			const destination = createCinetteDestination(device.deviceId, device.name, (c) =>
				backend.command(id, c)
			);
			drop(state.link);
			set({
				link: {
					id,
					deviceId: device.deviceId,
					name: device.name,
					phase: { phase: "connecting" },
					destination,
				},
				ended: null,
			});
			try {
				await backend.connect(device.deviceId, id);
			} catch (e) {
				if (state.link?.destination === destination) set({ link: null });
				throw e;
			}
		},
		leave: async () => {
			const link = state.link;
			if (!link) return;
			drop(link);
			set({ link: null });
			await backend.leave(link.id);
		},
	};
};
