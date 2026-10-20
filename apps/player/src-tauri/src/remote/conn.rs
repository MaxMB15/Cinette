// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! One TCP connection: a task that reads frames and a task that writes them.

use mvp_core::remote::channel::FrameReader;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// What a connection's reader reports.
#[derive(Debug)]
pub enum Read {
    /// One whole frame's contents.
    Frame(Vec<u8>),
    /// The connection ended, or sent something that isn't a frame.
    Gone,
}

/// How many frames may wait for a slow reader before the connection is
/// given up on.
const MAX_QUEUED: usize = 64;
/// How long one write may take before the connection is given up on.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Queues bytes for the writer. Dropping it closes the connection once
/// everything queued is written.
#[derive(Debug)]
pub struct Writer(mpsc::Sender<Vec<u8>>);

/// The other side reads too slowly, or the connection is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backlogged;

impl Writer {
    pub fn send(&self, bytes: Vec<u8>) -> Result<(), Backlogged> {
        self.0.try_send(bytes).map_err(|_| Backlogged)
    }
}

/// Starts the reader and writer for `stream`. Each read goes to `on_read`
/// with `id`, ending with a [`Read::Gone`]. A write that fails or takes
/// longer than [`WRITE_TIMEOUT`] ends both.
pub fn spawn<T: Send + Copy + 'static>(
    stream: TcpStream,
    id: T,
    on_read: mpsc::UnboundedSender<(T, Read)>,
) -> Writer {
    // Frames are small and someone is waiting on each.
    let _ = stream.set_nodelay(true);
    let (mut read_half, mut write_half) = stream.into_split();
    let gone = on_read.clone();
    let reader = tokio::spawn(async move {
        let mut frames = FrameReader::new();
        let mut buf = vec![0u8; 16 * 1024];
        'read: loop {
            match read_half.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => frames.push(&buf[..n]),
            }
            loop {
                match frames.next_frame() {
                    Ok(Some(frame)) => {
                        if on_read.send((id, Read::Frame(frame))).is_err() {
                            return;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break 'read,
                }
            }
        }
        let _ = on_read.send((id, Read::Gone));
    });
    let (writer, mut queue) = mpsc::channel::<Vec<u8>>(MAX_QUEUED);
    tokio::spawn(async move {
        while let Some(bytes) = queue.recv().await {
            let written = tokio::time::timeout(WRITE_TIMEOUT, write_half.write_all(&bytes)).await;
            if !matches!(written, Ok(Ok(()))) {
                // A reader waiting on a peer that sends nothing would wait
                // for good, so this side says Gone.
                reader.abort();
                let _ = gone.send((id, Read::Gone));
                return;
            }
        }
        // The queue was dropped: this side closed the connection. The
        // goodbye gets the same time as any write.
        let _ = tokio::time::timeout(WRITE_TIMEOUT, write_half.shutdown()).await;
        // The other side may never close its end. Nothing it sends now
        // matters, so stop reading.
        reader.abort();
    });
    Writer(writer)
}
