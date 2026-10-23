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
		connect: vi.fn<(deviceId: string, link: number) => Promise<void>>(() => Promise.resolve()),
		current: vi.fn<() => Promise<number | null>>(() => Promise.resolve(null)),
		leave: vi.fn<(link: number) => Promise<void>>(() => Promise.resolve()),
		// No version, so a load always shows the item opening.
		command: vi.fn<(link: number, command: unknown) => Promise<unknown>>(() =>
			Promise.resolve(undefined)
		),
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
		expect(stops).toHaveLength(4);
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
		const link = rc.getState().link!;
		expect(b.connect).toHaveBeenCalledWith("tv1", link.id);
		expect(link.id).toBeGreaterThan(Date.now() - 60_000);
		expect(link.deviceId).toBe("tv1");
		expect(link.name).toBe("Living Room");
		expect(link.phase).toStrictEqual({ phase: "connecting" });
		expect(link.destination.id).toBe("cinette:tv1");

		expect(link.code).toBeNull();
		const id = link.id;
		emit("remote://controller", {
			deviceId: "tv1",
			link: id,
			phase: "verifying",
			code: "123456",
			name: "Lounge TV",
		});
		expect(rc.getState().link!.phase).toStrictEqual({
			phase: "verifying",
			code: "123456",
			name: "Lounge TV",
		});
		expect(rc.getState().link!.name, "the name its key vouches for").toBe("Lounge TV");
		expect(link.features, "nothing offered before the handshake").toStrictEqual([]);
		expect(rc.getState().link!.features, "an older device says nothing").toStrictEqual([]);
		emit("remote://controller", {
			deviceId: "tv1",
			link: id,
			phase: "verifying",
			code: "123456",
			name: "Lounge TV",
			features: ["control", "providers"],
		});
		expect(rc.getState().link!.features).toStrictEqual(["control", "providers"]);
		emit("remote://controller", {
			deviceId: "tv1",
			link: id,
			phase: "pending",
			expiresInMs: 30_000,
		});
		expect(rc.getState().link!.code, "the code outlives the phase").toBe("123456");
		emit("remote://controller", { deviceId: "tv1", link: id, phase: "connected" });
		expect(link.destination.getState().connection).toBe("connected");
		expect(rc.getState().link!.phase).toStrictEqual({ phase: "connected" });
		expect(rc.getState().link!.name).toBe("Lounge TV");

		emit("remote://state", {
			deviceId: "tv1",
			link: id,
			state: { epoch: "e", version: 3, state: snapshot },
		});
		expect(link.destination.getState()).toMatchObject({
			status: "playing",
			item: { ref: "live-7" },
			positionAt: 5_000,
		});

		await link.destination.pause();
		expect(b.command).toHaveBeenCalledWith(id, { action: "pause", itemId: "live-7" });
	});

	it("ignores events about other devices and other links", async () => {
		const { b, emit } = backend();
		const rc = createRemoteControl(b);
		await rc.start();
		emit("remote://controller", { deviceId: "tv1", link: 1, phase: "connected" });
		emit("remote://state", {
			deviceId: "tv1",
			link: 1,
			state: { epoch: "e", version: 1, state: snapshot },
		});
		emit("remote://renamed", { deviceId: "tv1", link: 1, name: "Attic" });
		expect(rc.getState().link).toBeNull();
		await rc.connect(tv);
		const id = rc.getState().link!.id;
		emit("remote://controller", {
			deviceId: "den1",
			link: id,
			phase: "closed",
			reason: "lost",
		});
		emit("remote://state", {
			deviceId: "den1",
			link: id,
			state: { epoch: "e", version: 1, state: snapshot },
		});
		// An earlier link to the same device, ending late.
		emit("remote://controller", {
			deviceId: "tv1",
			link: id - 1,
			phase: "closed",
			reason: "left",
		});
		emit("remote://state", {
			deviceId: "tv1",
			link: id - 1,
			state: { epoch: "e", version: 1, state: snapshot },
		});
		const link = rc.getState().link!;
		expect(link.phase).toStrictEqual({ phase: "connecting" });
		expect(link.destination.getState().status).toBe("idle");
	});

	it("follows a name the device takes during the session", async () => {
		const { b, emit } = backend();
		const rc = createRemoteControl(b);
		await rc.start();
		await rc.connect(tv);
		const { id } = rc.getState().link!;
		const changes = vi.fn();
		rc.subscribe(changes);
		// Another device, and an earlier link to this one, change nothing.
		emit("remote://renamed", { deviceId: "den1", link: id, name: "Attic" });
		emit("remote://renamed", { deviceId: "tv1", link: id - 1, name: "Attic" });
		expect(changes).not.toHaveBeenCalled();
		emit("remote://renamed", { deviceId: "tv1", link: id, name: "Kitchen" });
		expect(rc.getState().link!.name).toBe("Kitchen");
		expect(rc.getState().link!.phase).toStrictEqual({ phase: "connecting" });
		// It's the name the ended notice gives too.
		emit("remote://controller", { deviceId: "tv1", link: id, phase: "closed", reason: "lost" });
		expect(rc.getState().ended).toStrictEqual({ name: "Kitchen", reason: "lost" });
	});

	it("drops the link and says why when it ends", async () => {
		const { b, emit } = backend();
		const rc = createRemoteControl(b);
		await rc.start();
		await rc.connect(tv);
		const { destination, id } = rc.getState().link!;
		emit("remote://controller", {
			deviceId: "tv1",
			link: id,
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
		const replaced = rc.getState().link!.destination;
		await rc.connect(den);
		expect(replaced.getState().connection, "the old one hears it ended").toBe("lost");
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
		const { destination: left, id } = rc.getState().link!;
		const changes = vi.fn();
		rc.subscribe(changes);
		await rc.leave();
		expect(left.getState().connection).toBe("lost");
		expect(rc.getState().link).toBeNull();
		expect(rc.getState().ended).toBeNull();
		expect(b.leave).toHaveBeenCalledTimes(1);
		expect(b.leave).toHaveBeenCalledWith(id);
		expect(changes).toHaveBeenCalledTimes(1);
		// With nothing to leave, the backend hears nothing.
		await rc.leave();
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

	it("leaves a link the backend holds that this page doesn't know", async () => {
		const { b } = backend();
		b.current.mockResolvedValueOnce(12);
		const rc = createRemoteControl(b);
		await rc.start();
		await flush();
		expect(b.leave).toHaveBeenCalledTimes(1);
		expect(b.leave).toHaveBeenCalledWith(12);
	});

	it("keeps the backend's link when it's this page's own", async () => {
		const { b } = backend();
		const rc = createRemoteControl(b);
		await rc.connect(tv);
		b.current.mockResolvedValueOnce(rc.getState().link!.id);
		await rc.start();
		await flush();
		expect(b.leave).not.toHaveBeenCalled();
		b.current.mockRejectedValueOnce("unavailable");
		await rc.start();
		await flush();
		expect(b.leave).not.toHaveBeenCalled();
	});

	it("gives each link its own number", async () => {
		const { b } = backend();
		const rc = createRemoteControl(b);
		await rc.connect(tv);
		const first = rc.getState().link!.id;
		await rc.connect(den);
		expect(rc.getState().link!.id).toBe(first + 1);
	});
});
