// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! One TCP connection: a task that reads frames and a task that writes them.

use mvp_core::remote::channel::FrameReader;
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

/// Queues bytes for the writer. Dropping it closes the connection once
/// everything queued is written.
pub type Writer = mpsc::UnboundedSender<Vec<u8>>;

/// Starts the reader and writer for `stream`. Each read goes to `on_read`
/// with `id`, ending with one [`Read::Gone`].
pub fn spawn<T: Send + Copy + 'static>(
    stream: TcpStream,
    id: T,
    on_read: mpsc::UnboundedSender<(T, Read)>,
) -> Writer {
    // Frames are small and someone is waiting on each.
    let _ = stream.set_nodelay(true);
    let (mut read_half, mut write_half) = stream.into_split();
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
    let (writer, mut queue) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(bytes) = queue.recv().await {
            if write_half.write_all(&bytes).await.is_err() {
                // The reader sees the broken connection too, and says Gone.
                return;
            }
        }
        // The queue was dropped: this side closed the connection.
        let _ = write_half.shutdown().await;
        // The other side may never close its end. Nothing it sends now
        // matters, so stop reading.
        reader.abort();
    });
    writer
}
