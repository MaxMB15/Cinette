// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The JSON messages of the four namespaces Cinette uses. Only the fields it
//! reads are listed. Unknown fields and unknown message types are ignored, so
//! a newer receiver doesn't break anything.

use std::fmt;

use serde::Deserialize;
use serde_json::{json, Value};

pub const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
pub const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
pub const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
pub const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";

/// The receiver itself, as opposed to an app running on it.
pub const PLATFORM: &str = "receiver-0";
/// Google's Default Media Receiver.
pub const DEFAULT_MEDIA_RECEIVER: &str = "CC1AD845";

/// `supportedMediaCommands` bits.
pub const COMMAND_PAUSE: u64 = 1;
pub const COMMAND_SEEK: u64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamType {
    /// A file with a length.
    Buffered,
    Live,
}

/// A subtitle file the receiver fetches at load.
#[derive(Clone, PartialEq)]
pub struct TextTrack {
    pub id: i64,
    pub url: String,
    /// `text/vtt`.
    pub content_type: String,
    pub name: String,
    pub language: Option<String>,
}

/// What to play. `url` and the track URLs carry logins or this device's
/// private paths, so `Debug` leaves them out.
#[derive(Clone, PartialEq)]
pub struct LoadRequest {
    pub url: String,
    pub content_type: String,
    pub stream_type: StreamType,
    /// HLS whose segments are MPEG-TS, as Xtream's `.m3u8` is. The receiver
    /// expects fMP4 segments unless told.
    pub hls_ts_segments: bool,
    pub title: String,
    /// A logo that passed the logo rule, or nothing.
    pub image: Option<String>,
    /// Where to start, in seconds. Only for a file with a length.
    pub start_at: Option<f64>,
    pub text_tracks: Vec<TextTrack>,
    pub active_track_ids: Vec<i64>,
}

impl fmt::Debug for LoadRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoadRequest")
            .field("content_type", &self.content_type)
            .field("stream_type", &self.stream_type)
            .field("title", &self.title)
            .field("start_at", &self.start_at)
            .field("text_tracks", &self.text_tracks.len())
            .finish_non_exhaustive()
    }
}

impl LoadRequest {
    pub(crate) fn to_json(&self, request_id: u64) -> Value {
        let mut metadata = json!({ "metadataType": 0, "title": self.title });
        if let Some(image) = &self.image {
            metadata["images"] = json!([{ "url": image }]);
        }
        let mut media = json!({
            "contentId": self.url,
            "contentUrl": self.url,
            "contentType": self.content_type,
            "streamType": match self.stream_type {
                StreamType::Buffered => "BUFFERED",
                StreamType::Live => "LIVE",
            },
            "metadata": metadata,
        });
        if self.hls_ts_segments {
            media["hlsSegmentFormat"] = json!("ts");
            media["hlsVideoSegmentFormat"] = json!("mpeg2_ts");
        }
        if !self.text_tracks.is_empty() {
            media["tracks"] = self
                .text_tracks
                .iter()
                .map(|t| {
                    let mut track = json!({
                        "trackId": t.id,
                        "type": "TEXT",
                        "subtype": "SUBTITLES",
                        "trackContentId": t.url,
                        "trackContentType": t.content_type,
                        "name": t.name,
                    });
                    if let Some(language) = &t.language {
                        track["language"] = json!(language);
                    }
                    track
                })
                .collect();
        }
        let mut load = json!({
            "type": "LOAD",
            "requestId": request_id,
            "autoplay": true,
            "activeTrackIds": self.active_track_ids,
            "media": media,
        });
        if let (StreamType::Buffered, Some(at)) = (self.stream_type, self.start_at) {
            load["currentTime"] = json!(at);
        }
        load
    }
}

/// A running app, from `RECEIVER_STATUS`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub app_id: String,
    pub session_id: String,
    pub transport_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverVolume {
    pub level: Option<f64>,
    pub muted: Option<bool>,
    /// `fixed` when the TV sets the volume, as some do over HDMI-CEC.
    pub control_type: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverStatus {
    /// The apps that read as one. An entry missing a field, as some apps'
    /// are, is skipped, so it can't hide the rest of the status.
    #[serde(default, deserialize_with = "readable_apps")]
    pub applications: Vec<Application>,
    pub volume: Option<ReceiverVolume>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTrack {
    pub track_id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: Option<String>,
    pub language: Option<String>,
}

/// `media` inside a media status. The receiver often leaves it out when it
/// hasn't changed.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: Option<f64>,
    pub stream_type: Option<String>,
    #[serde(default)]
    pub tracks: Vec<MediaTrack>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatusEntry {
    pub media_session_id: i64,
    pub player_state: String,
    pub idle_reason: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub current_time: f64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub supported_media_commands: u64,
    pub active_track_ids: Option<Vec<i64>>,
    pub media: Option<MediaInfo>,
}

/// A message from the receiver that Cinette acts on.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Ping,
    /// The virtual connection to the sender ended.
    Close,
    ReceiverStatus(ReceiverStatus),
    LaunchError {
        reason: Option<String>,
    },
    MediaStatus {
        /// The request it answers, 0 for a change the receiver reports itself.
        request_id: u64,
        entries: Vec<MediaStatusEntry>,
    },
    LoadFailed {
        request_id: u64,
        detailed_error_code: Option<i64>,
    },
    LoadCancelled {
        request_id: u64,
    },
    /// `INVALID_REQUEST` or `INVALID_PLAYER_STATE`.
    Rejected {
        request_id: u64,
        reason: Option<String>,
    },
    /// `ERROR`, which a receiver sends when playback fails, or with a
    /// request id when it can't carry out that request.
    Error {
        request_id: u64,
        detailed_error_code: Option<i64>,
    },
    /// Anything else, ignored.
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, deserialize_with = "null_as_default")]
    request_id: u64,
    reason: Option<String>,
    detailed_error_code: Option<i64>,
    status: Option<Value>,
}

/// A field that some receivers send as `null`, read as its default instead
/// of failing the whole message.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn readable_apps<'de, D>(deserializer: D) -> Result<Vec<Application>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Option::<Vec<Value>>::deserialize(deserializer)?.unwrap_or_default();
    Ok(entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect())
}

/// Reads a text payload from `namespace`. `None` means it isn't valid JSON
/// with a `type`, or its content doesn't read as that type, and the session
/// ignores it.
pub fn parse(namespace: &str, text: &str) -> Option<Incoming> {
    let envelope: Envelope = serde_json::from_str(text).ok()?;
    let kind = envelope.kind.as_str();
    Some(match (namespace, kind) {
        (NS_HEARTBEAT, "PING") => Incoming::Ping,
        (NS_CONNECTION, "CLOSE") => Incoming::Close,
        (NS_RECEIVER, "RECEIVER_STATUS") => {
            Incoming::ReceiverStatus(serde_json::from_value(envelope.status?).ok()?)
        }
        (NS_RECEIVER, "LAUNCH_ERROR") => Incoming::LaunchError {
            reason: envelope.reason,
        },
        (NS_MEDIA, "MEDIA_STATUS") => Incoming::MediaStatus {
            request_id: envelope.request_id,
            entries: serde_json::from_value(envelope.status?).ok()?,
        },
        (NS_MEDIA, "LOAD_FAILED") => Incoming::LoadFailed {
            request_id: envelope.request_id,
            detailed_error_code: envelope.detailed_error_code,
        },
        (NS_MEDIA, "LOAD_CANCELLED") => Incoming::LoadCancelled {
            request_id: envelope.request_id,
        },
        (NS_MEDIA, "INVALID_REQUEST" | "INVALID_PLAYER_STATE") => Incoming::Rejected {
            request_id: envelope.request_id,
            reason: envelope.reason,
        },
        (NS_MEDIA, "ERROR") => Incoming::Error {
            request_id: envelope.request_id,
            detailed_error_code: envelope.detailed_error_code,
        },
        _ => Incoming::Other,
    })
}
