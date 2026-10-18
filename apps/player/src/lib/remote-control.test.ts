// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import { createRemoteControl, type RemoteControlBackend } from "./remote-control";
import type { RemoteSnapshot } from "./cinette-destination";
import type { RemoteDevice } from "./tauri";

const tv: RemoteDevice = {
	deviceId: "tv1",
	name: "Living Room",
	deviceType: "fire-tv",
	controlAllowed: true,
	available: true,
};

const den: RemoteDevice = { ...tv, deviceId: "den1", name: "Den" };

const snapshot: RemoteSnapshot = {
	status: "playing",
	item: { id: "live-7", name: "News", contentType: "live", group: "UK" },
	position: 30,
	duration: 0,
	volume: 55,
	subtitles: [],
	subtitleId: null,
	audio: [],
	audioId: null,
	capabilities: {
		pause: true,
		seek: false,
		volume: true,
		subtitles: false,
		audioTracks: false,
		resumeAt: false,
	},
	error: null,
};

const backend = () => {
	const handlers = new Map<string, (payload: unknown) => void>();
	const stops: ReturnType<typeof vi.fn>[] = [];
	const b = {
		devices: vi.fn(() => Promise.resolve([tv])),
		connect: vi.fn<(deviceId: string) => Promise<void>>(() => Promise.resolve()),
		leave: vi.fn(() => Promise.resolve()),
		command: vi.fn(() => Promise.resolve(1)),
		listen: vi.fn(<T>(event: string, handler: (payload: T) => void) => {
			handlers.set(event, handler as (payload: unknown) => void);
			const stop = vi.fn();
			stops.push(stop);
			return Promise.resolve(stop);
		}),
		now: vi.fn(() => 5_000),
	};
	const emit = (event: string, payload: unknown) => handlers.get(event)?.(payload);
	return { b: b as RemoteControlBackend & typeof b, emit, stops };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createRemoteControl", () => {
	it("lists the devices the backend knows and follows the events", async () => {
		const { b, emit, stops } = backend();
		const rc = createRemoteControl(b);
		expect(rc.getState()).toStrictEqual({ devices: [], link: null, ended: null });
		const changes = vi.fn();
		rc.subscribe(changes);
		const stop = await rc.start();
		await flush();
		expect(rc.getState().devices).toStrictEqual([tv]);
		emit("remote://devices", [tv, den]);
		expect(rc.getState().devices).toStrictEqual([tv, den]);
		expect(changes).toHaveBeenCalledTimes(2);
		stop();
		expect(stops).toHaveLength(3);
		for (const s of stops) expect(s).toHaveBeenCalledTimes(1);
	});

	it("takes anything but a list from the backend as no devices", async () => {
		const { b } = backend();
		b.devices.mockResolvedValueOnce(undefined as never);
		const rc = createRemoteControl(b);
		await rc.start();
		await flush();
		expect(rc.getState().devices).toStrictEqual([]);
	});

	it("keeps the list from events when the first fetch fails", async () => {
		const { b, emit } = backend();
		b.devices.mockRejectedValueOnce("unavailable");
		const rc = createRemoteControl(b);
		await rc.start();
		emit("remote://devices", [den]);
		await flush();
		expect(rc.getState().devices).toStrictEqual([den]);
	});

	it("connects, follows the phases and feeds the destination", async () => {
		const { b, emit } = backend();
		const rc = createRemoteControl(b);
		await rc.start();
		await rc.connect(tv);
		expect(b.connect).toHaveBeenCalledWith("tv1");
		const link = rc.getState().link!;
		expect(link.deviceId).toBe("tv1");
		expect(link.name).toBe("Living Room");
		expect(link.phase).toStrictEqual({ phase: "connecting" });
		expect(link.destination.id).toBe("cinette:tv1");

		expect(link.code).toBeNull();
		emit("remote://controller", { deviceId: "tv1", phase: "verifying", code: "123456" });
		expect(rc.getState().link!.phase).toStrictEqual({ phase: "verifying", code: "123456" });
		emit("remote://controller", { deviceId: "tv1", phase: "pending", expiresInMs: 30_000 });
		expect(rc.getState().link!.code, "the code outlives the phase").toBe("123456");
		emit("remote://controller", { deviceId: "tv1", phase: "connected" });
		expect(link.destination.getState().connection).toBe("connected");

		emit("remote://state", {
			deviceId: "tv1",
			state: { epoch: "e", version: 3, state: snapshot },
		});
		expect(link.destination.getState()).toMatchObject({
			status: "playing",
			item: { ref: "live-7" },
			positionAt: 5_000,
		});

		await link.destination.pause();
		expect(b.command).toHaveBeenCalledWith({ action: "pause", itemId: "live-7" });
	});

	it("ignores events about other devices", async () => {
		const { b, emit } = backend();
		const rc = createRemoteControl(b);
		await rc.start();
		emit("remote://controller", { deviceId: "tv1", phase: "connected" });
		emit("remote://state", {
			deviceId: "tv1",
			state: { epoch: "e", version: 1, state: snapshot },
		});
		expect(rc.getState().link).toBeNull();
		await rc.connect(tv);
		emit("remote://controller", { deviceId: "den1", phase: "closed", reason: "lost" });
		emit("remote://state", {
			deviceId: "den1",
			state: { epoch: "e", version: 1, state: snapshot },
		});
		const link = rc.getState().link!;
		expect(link.phase).toStrictEqual({ phase: "connecting" });
		expect(link.destination.getState().status).toBe("idle");
	});

	it("drops the link and says why when it ends", async () => {
		const { b, emit } = backend();
		const rc = createRemoteControl(b);
		await rc.start();
		await rc.connect(tv);
		const destination = rc.getState().link!.destination;
		emit("remote://controller", {
			deviceId: "tv1",
			phase: "closed",
			reason: { target: "revoked" },
		});
		expect(rc.getState().link).toBeNull();
		expect(rc.getState().ended).toStrictEqual({
			name: "Living Room",
			reason: { target: "revoked" },
		});
		expect(destination.getState().connection).toBe("lost");
		await rc.connect(den);
		expect(rc.getState().ended, "a new link clears it").toBeNull();
	});

	it("drops the link when connecting fails", async () => {
		const { b } = backend();
		b.connect.mockRejectedValueOnce("That device isn't on the network now.");
		const rc = createRemoteControl(b);
		await expect(rc.connect(tv)).rejects.toBe("That device isn't on the network now.");
		expect(rc.getState().link).toBeNull();
	});

	it("leaves a newer link alone when an older connect fails", async () => {
		const { b } = backend();
		let fail: (e: unknown) => void = () => {};
		b.connect.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
		const rc = createRemoteControl(b);
		const first = rc.connect(tv);
		await rc.connect(den);
		fail("gone");
		await expect(first).rejects.toBe("gone");
		expect(rc.getState().link?.deviceId).toBe("den1");
	});

	it("passes on a failed connect's error after leaving meanwhile", async () => {
		const { b } = backend();
		let fail: (e: unknown) => void = () => {};
		b.connect.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
		const rc = createRemoteControl(b);
		const pending = rc.connect(tv);
		await rc.leave();
		fail("gone");
		await expect(pending).rejects.toBe("gone");
		expect(rc.getState().link).toBeNull();
	});

	it("leaving drops the link at once and tells the backend", async () => {
		const { b } = backend();
		const rc = createRemoteControl(b);
		await rc.connect(tv);
		const changes = vi.fn();
		rc.subscribe(changes);
		await rc.leave();
		expect(rc.getState().link).toBeNull();
		expect(rc.getState().ended).toBeNull();
		expect(b.leave).toHaveBeenCalledTimes(1);
		expect(changes).toHaveBeenCalledTimes(1);
	});

	it("stops telling a subscriber that left", async () => {
		const { b, emit } = backend();
		const rc = createRemoteControl(b);
		await rc.start();
		const changes = vi.fn();
		const stop = rc.subscribe(changes);
		stop();
		emit("remote://devices", []);
		expect(changes).not.toHaveBeenCalled();
	});
});
