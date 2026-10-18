// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! A controller on the other end of a loopback connection, for tests: the
//! core's own `Controller` driving a real TCP socket.

use mvp_core::remote::channel::FrameReader;
use mvp_core::remote::controller::{Controller, Event};
use mvp_core::remote::identity::{DeviceId, DeviceKey};
use mvp_core::remote::message::{
    CloseReason, Command, DeviceType, ErrorCode, Feature, Hello, PROTOCOL_VERSION,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

/// How long a test waits for anything.
pub const WAIT: Duration = Duration::from_secs(5);

/// Connects to the target with id `target` on this machine's `port`, as a
/// phone with key `key`, and sends the first handshake frame.
pub async fn connect(
    port: u16,
    target: DeviceId,
    key: DeviceKey,
    name: &str,
    resume: Option<String>,
) -> Client {
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let hello = Hello {
        id: key.device_id(),
        name: name.into(),
        device_type: DeviceType::Iphone,
        versions: vec![PROTOCOL_VERSION],
        features: vec![Feature::Control, Feature::Catalog],
    };
    let (controller, first) =
        Controller::connect(&key, hello, target, resume, std::time::Instant::now()).unwrap();
    let mut client = Client {
        stream,
        controller,
        reader: FrameReader::new(),
        events: Vec::new(),
        key,
    };
    client.write(&first).await;
    client
}

pub struct Client {
    pub stream: tokio::net::TcpStream,
    pub controller: Controller,
    pub reader: FrameReader,
    pub events: Vec<Event>,
    pub key: DeviceKey,
}

impl Client {
    pub async fn write(&mut self, bytes: &[u8]) {
        self.stream.write_all(bytes).await.unwrap();
    }

    /// Reads until `pick` finds an event, answering the handshake on the way.
    /// `None` when the connection closed first.
    pub async fn wait_for<T>(&mut self, mut pick: impl FnMut(&Event) -> Option<T>) -> Option<T> {
        let mut buf = vec![0u8; 16 * 1024];
        let mut checked = 0;
        loop {
            while checked < self.events.len() {
                let event = &self.events[checked];
                checked += 1;
                if let Some(found) = pick(event) {
                    return Some(found);
                }
            }
            let n = timeout(WAIT, self.stream.read(&mut buf))
                .await
                .expect("the target sent nothing")
                .unwrap_or(0);
            if n == 0 {
                return None;
            }
            self.reader.push(&buf[..n]);
            while let Some(frame) = self.reader.next_frame().unwrap() {
                let output = self.controller.receive(&frame);
                for bytes in output.send {
                    self.write(&bytes).await;
                }
                self.events.extend(output.events);
            }
        }
    }

    pub async fn code(&mut self) -> String {
        self.wait_for(|e| match e {
            Event::Verified { code, .. } => Some(code.to_string()),
            _ => None,
        })
        .await
        .expect("verified")
    }

    /// Drives the handshake until the target says it's asking its user.
    pub async fn pending(&mut self) {
        self.wait_for(|e| matches!(e, Event::Pending { .. }).then_some(()))
            .await
            .expect("pending");
    }

    pub async fn connected(&mut self) -> String {
        self.wait_for(|e| match e {
            Event::Connected { session_id, .. } => Some(session_id.clone()),
            _ => None,
        })
        .await
        .expect("connected")
    }

    pub async fn closed(&mut self) -> Option<CloseReason> {
        self.wait_for(|e| match e {
            Event::Closed(reason) => Some(*reason),
            _ => None,
        })
        .await
    }

    pub async fn command(&mut self, command: Command) -> Result<u64, ErrorCode> {
        let (id, bytes) = self.controller.command(command).unwrap();
        self.write(&bytes).await;
        self.wait_for(|e| match e {
            Event::Reply { request, result } if *request == id => Some(*result),
            _ => None,
        })
        .await
        .expect("a reply")
    }
}
