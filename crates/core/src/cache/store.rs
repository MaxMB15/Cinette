// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use crate::iptv::m3u::parse_series_name;
use crate::iptv::mdblist::MdbListData;
use crate::iptv::omdb::OmdbData;
use crate::iptv::opensubtitles::SubtitleSearchResult;
use crate::iptv::skip_segments::SourceTimes;
use crate::iptv::whatson::WhatsonData;
use crate::iptv::xtream;
use crate::models::channel::Channel;
use crate::models::playlist::{Provider, ProviderType};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Result as SqlResult};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CacheError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct WatchHistoryEntry {
    pub channel_id: String,
    pub channel_name: String,
    pub channel_logo: Option<String>,
    pub content_type: String,
    pub first_watched_at: i64,
    pub last_watched_at: i64,
    pub total_duration_seconds: i64,
    pub play_count: i64,
    /// The show a series entry belongs to, from [`history_series_title`].
    /// `None` for live channels and movies.
    pub series_title: Option<String>,
}

/// The show a series history entry belongs to. The cached channel's title
/// wins, then the title parsed from the episode name, then the whole name, so
/// every episode lands in exactly one show. Grouping and deleting by show both
/// use this, which keeps the Recently Played row and the database in step.
fn history_series_title(cached: Option<String>, channel_name: &str) -> String {
    cached
        .or_else(|| parse_series_name(channel_name).map(|(title, _, _)| title))
        .unwrap_or_else(|| channel_name.to_string())
}

#[derive(Debug, Clone)]
pub struct StoredEpgProgram {
    pub channel_id: String,
    pub title: String,
    pub description: Option<String>,
    pub start_time: i64,
    pub end_time: i64,
    pub category: Option<String>,
    pub provider_id: String,
    pub fetched_at: i64,
}

#[derive(Debug, Clone)]
pub struct StoredEpgProgramWithChannel {
    pub channel_id: String,
    pub title: String,
    pub description: Option<String>,
    pub start_time: i64,
    pub end_time: i64,
    pub channel_name: String,
    pub channel_logo: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupHierarchyEntry {
    pub provider_id: String,
    pub content_type: String,
    pub group_name: String,
    pub super_category: Option<String>,
    pub sort_order: i64,
    pub is_user_override: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedGroup {
    pub provider_id: String,
    pub content_type: String,
    pub group_name: String,
    pub sort_order: i64,
}

/// Last known playback position for a movie or episode, keyed by a content key
/// the frontend builds, so it survives refreshes that change channel ids and
/// switches between sources.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPosition {
    pub content_key: String,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub updated_at: i64,
    /// Watched to the end. The row stays, so the item counts as watched
    /// and a history transfer can carry that.
    #[serde(default)]
    pub finished: bool,
}

/// A cache table that keeps one JSON value per key, with the time it was saved.
#[derive(Clone, Copy)]
struct JsonCache {
    table: &'static str,
    /// The name of the key column.
    key: &'static str,
}

const OMDB_CACHE: JsonCache = JsonCache { table: "omdb_cache", key: "channel_id" };
const MDBLIST_CACHE: JsonCache = JsonCache { table: "mdblist_cache", key: "imdb_id" };
const WHATSON_CACHE: JsonCache = JsonCache { table: "whatson_cache", key: "imdb_id" };
const OPENSUBTITLES_CACHE: JsonCache = JsonCache { table: "opensubtitles_search_cache", key: "cache_key" };
const SKIP_SEGMENTS_CACHE: JsonCache = JsonCache { table: "skip_segments_cache", key: "cache_key" };

const JSON_CACHES: [JsonCache; 5] = [OMDB_CACHE, MDBLIST_CACHE, WHATSON_CACHE, OPENSUBTITLES_CACHE, SKIP_SEGMENTS_CACHE];

pub struct CacheStore {
    conn: Connection,
}

/// A step that rewrites saved rows after a change in what they mean.
type Migration = fn(&CacheStore) -> Result<(), CacheError>;

/// Every [`Migration`], in the order they were added. A new step goes at the
/// end, since the database stores how many have run.
const MIGRATIONS: &[Migration] = &[CacheStore::move_xtream_position_ids];

/// The columns that hold a channel id with nothing saved beside it to check
/// the id against, as table and column. When a channel moves to a new id,
/// these rows follow the channel row their old id names. The moves that can
/// check a row run first, so only the rows they couldn't place are left.
const UNCHECKED_CHANNEL_ID_COLUMNS: &[(&str, &str)] = &[("downloads", "series_channel_id")];

/// A saved Xtream channel that moves from its old position id.
struct MovedChannel {
    new_id: String,
    provider_id: String,
    /// `live`, `movie` or `series`, as the new id starts.
    kind: String,
    /// The channel's name, as [`name_key`] compares names.
    name: String,
}

/// Where rows saved under the old Xtream position ids go.
#[derive(Default)]
struct ChannelMoves {
    by_old_id: HashMap<String, MovedChannel>,
    /// The new id of the saved channel of each provider, kind and name, or
    /// None when channels with different ids share the name, since a row's
    /// name can't tell them apart.
    by_name: HashMap<(String, String, String), Option<String>>,
}

impl ChannelMoves {
    fn add(&mut self, old_id: &str, provider_id: &str, new_id: String, kind: &str, name: &str) {
        let name = name_key(name);
        self.by_name
            .entry((provider_id.to_string(), kind.to_string(), name.clone()))
            .and_modify(|id| {
                if id.as_deref() != Some(new_id.as_str()) {
                    *id = None;
                }
            })
            .or_insert_with(|| Some(new_id.clone()));
        let moved = MovedChannel {
            new_id,
            provider_id: provider_id.to_string(),
            kind: kind.to_string(),
            name,
        };
        self.by_old_id.insert(old_id.to_string(), moved);
    }

    /// The new id for a row saved under `old_id` with the channel's `name`.
    /// A position id passed to whichever channel took that place, so the
    /// channel saved under `old_id` now may not be the one the row was saved
    /// for. The row follows it only when the names agree, and otherwise goes
    /// to the channel of the same provider and kind with the row's name.
    /// Returns None when no channel of that name is saved, or when channels
    /// with different ids have it, since the row can't say which one it was
    /// saved for.
    fn for_name(&self, old_id: &str, name: &str) -> Option<&str> {
        let moved = self.by_old_id.get(old_id)?;
        let name = name_key(name);
        if name == moved.name {
            return Some(&moved.new_id);
        }
        self.by_name
            .get(&(moved.provider_id.clone(), moved.kind.clone(), name))
            .and_then(Option::as_deref)
    }

    /// The new id of the series `episode_id` belongs to, for a row saved
    /// under the series' old id `old_id`. Episode ids hold the panel's own
    /// series id, which never depended on the order of the lists, so it
    /// names the right series even where `old_id` now names another one.
    fn for_episode(&self, old_id: &str, episode_id: &str) -> Option<String> {
        let moved = self.by_old_id.get(old_id)?;
        let series = episode_id
            .strip_prefix(moved.provider_id.as_str())?
            .strip_prefix('-')
            .and_then(xtream::series_id_for_episode_id)?;
        Some(format!("{}-{series}", moved.provider_id))
    }

    /// The new id of the channel row `old_id` names, for a row with nothing
    /// to check it against.
    fn by_position(&self, old_id: &str) -> Option<&str> {
        self.by_old_id.get(old_id).map(|moved| moved.new_id.as_str())
    }
}

/// A name as the move compares it. Case and surrounding spaces don't count,
/// so a panel that tidied its names doesn't cost a channel its rows.
fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

impl CacheStore {
    pub fn open(db_path: &Path) -> Result<Self, CacheError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        let store = Self { conn };
        store.init_tables()?;
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, CacheError> {
        let conn = Connection::open_in_memory()?;
        let store = Self { conn };
        store.init_tables()?;
        store.migrate()?;
        Ok(store)
    }

    fn init_tables(&self) -> Result<(), CacheError> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS providers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                url TEXT NOT NULL,
                username TEXT,
                password TEXT,
                last_updated TEXT,
                channel_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                logo_url TEXT,
                group_title TEXT NOT NULL DEFAULT '',
                tvg_id TEXT,
                tvg_name TEXT,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                content_type TEXT NOT NULL DEFAULT 'live',
                sources TEXT NOT NULL DEFAULT '[]',
                FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS epg_cache (
                channel_id TEXT NOT NULL,
                data_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (channel_id, fetched_at)
            );

            CREATE INDEX IF NOT EXISTS idx_channels_provider ON channels(provider_id);
            CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_title);
            CREATE INDEX IF NOT EXISTS idx_channels_favorite ON channels(is_favorite);",
        )?;
        // Migrate: add content_type if it doesn't exist yet (SQLite ignores duplicate columns error)
        let _ = self.conn.execute_batch(
            "ALTER TABLE channels ADD COLUMN content_type TEXT NOT NULL DEFAULT 'live';"
        );
        let _ = self.conn.execute_batch(
            "ALTER TABLE channels ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';"
        );
        let _ = self.conn.execute_batch(
            "ALTER TABLE channels ADD COLUMN series_title TEXT;"
        );
        let _ = self.conn.execute_batch(
            "ALTER TABLE channels ADD COLUMN season INTEGER;"
        );
        let _ = self.conn.execute_batch(
            "ALTER TABLE channels ADD COLUMN episode INTEGER;"
        );
        let _ = self.conn.execute_batch("ALTER TABLE providers ADD COLUMN epg_url TEXT;");
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS epg_programmes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id  TEXT NOT NULL,
                title       TEXT NOT NULL,
                description TEXT,
                start_time  INTEGER NOT NULL,
                end_time    INTEGER NOT NULL,
                category    TEXT,
                provider_id TEXT NOT NULL,
                fetched_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_epg_channel_time
                ON epg_programmes(channel_id, start_time);"
        )?;
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS watch_history (
                id                     INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id             TEXT NOT NULL UNIQUE,
                channel_name           TEXT NOT NULL,
                channel_logo           TEXT,
                content_type           TEXT NOT NULL,
                first_watched_at       INTEGER NOT NULL,
                last_watched_at        INTEGER NOT NULL,
                total_duration_seconds INTEGER NOT NULL DEFAULT 0,
                play_count             INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_history_last_watched
                ON watch_history(last_watched_at DESC);"
        )?;
        for cache in JSON_CACHES {
            self.conn.execute_batch(&format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    {}          TEXT PRIMARY KEY,
                    data_json   TEXT NOT NULL,
                    fetched_at  INTEGER NOT NULL
                );",
                cache.table, cache.key
            ))?;
        }
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS group_hierarchy (
                provider_id TEXT NOT NULL,
                content_type TEXT NOT NULL,
                group_name TEXT NOT NULL,
                super_category TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_user_override INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (provider_id, content_type, group_name)
            );"
        )?;
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS playback_positions (
                content_key      TEXT PRIMARY KEY,
                position_seconds REAL NOT NULL,
                duration_seconds REAL NOT NULL,
                updated_at       INTEGER NOT NULL
            );"
        )?;
        self.add_column("playback_positions", "finished INTEGER NOT NULL DEFAULT 0")?;
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pinned_groups (
                provider_id TEXT NOT NULL,
                content_type TEXT NOT NULL,
                group_name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (provider_id, content_type, group_name)
            );"
        )?;
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS downloads (
                id                 TEXT PRIMARY KEY,
                channel_id         TEXT NOT NULL,
                title              TEXT NOT NULL,
                kind               TEXT NOT NULL,
                series_channel_id  TEXT,
                status             TEXT NOT NULL,
                dest_path          TEXT NOT NULL,
                total_bytes        INTEGER,
                downloaded_bytes   INTEGER NOT NULL DEFAULT 0,
                avg_rate_bps       INTEGER,
                error              TEXT,
                created_at         INTEGER NOT NULL,
                finished_at        INTEGER,
                keep               INTEGER NOT NULL DEFAULT 0,
                last_played_at     INTEGER,
                source_channel_id  TEXT,
                start_at           INTEGER,
                end_at             INTEGER,
                program_title      TEXT,
                program_start      INTEGER,
                program_end        INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_downloads_channel ON downloads(channel_id);
            CREATE INDEX IF NOT EXISTS idx_downloads_series ON downloads(series_channel_id);
            CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);",
        )?;
        // Columns added after the table first shipped.
        self.add_column("downloads", "keep INTEGER NOT NULL DEFAULT 0")?;
        self.add_column("downloads", "last_played_at INTEGER")?;
        // Recordings. Added in the order of the CREATE TABLE above, so
        // `row_to_download` reads them at the same place in either table.
        for column in [
            "source_channel_id TEXT",
            "start_at INTEGER",
            "end_at INTEGER",
            "program_title TEXT",
            "program_start INTEGER",
            "program_end INTEGER",
        ] {
            self.add_column("downloads", column)?;
        }
        // Full episode list per series, cached so the season/episode selector
        // works offline once any episode of the series has been downloaded.
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS series_episode_cache (
                series_channel_id  TEXT PRIMARY KEY,
                episodes_json      TEXT NOT NULL,
                updated_at         INTEGER NOT NULL
            );",
        )?;
        Ok(())
    }

    /// Runs each step in [`MIGRATIONS`] that hasn't run on this database yet.
    /// SQLite's `user_version` holds how many have run. Each step commits
    /// together with the new count, so a step that fails runs again on the
    /// next open.
    fn migrate(&self) -> Result<(), CacheError> {
        let done: usize = self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        for (step, migration) in MIGRATIONS.iter().enumerate().skip(done) {
            let tx = self.conn.unchecked_transaction()?;
            migration(self)?;
            tx.pragma_update(None, "user_version", step + 1)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Moves Xtream channels saved under the old list position ids, such as
    /// `vod-3`, to ids made from the panel's own ids, such as `movie-812`, and
    /// takes their favorites, history, downloads, recordings and saved
    /// episode lists along. The panel's id comes from each saved URL, so
    /// every saved channel moves at once, without waiting for a refresh that
    /// might miss one of the lists.
    ///
    /// A position id may have passed to another channel before this runs, so
    /// history, downloads and recordings, which keep the channel's name, move
    /// only to a channel with that name, and otherwise stay where they are.
    fn move_xtream_position_ids(&self) -> Result<(), CacheError> {
        let saved: Vec<(String, String, String, String)> = self.rows_of(
            "SELECT c.id, c.provider_id, c.url, c.name FROM channels c
             JOIN providers p ON p.id = c.provider_id
             WHERE p.provider_type = 'xtream'
             ORDER BY c.rowid",
        )?;

        self.conn.execute_batch(
            "CREATE TEMP TABLE channel_id_moves (
                old_id    TEXT PRIMARY KEY,
                new_id    TEXT NOT NULL,
                keeps_row INTEGER NOT NULL
            );",
        )?;
        let mut moves = ChannelMoves::default();
        {
            let mut insert = self.conn.prepare(
                "INSERT INTO channel_id_moves (old_id, new_id, keeps_row) VALUES (?1, ?2, ?3)",
            )?;
            let mut taken: HashSet<String> = saved.iter().map(|(id, ..)| id.clone()).collect();
            for (old_id, provider_id, url, name) in &saved {
                // Saved ids are the provider id, a dash, then the channel's own id.
                let Some(id) = old_id
                    .strip_prefix(provider_id.as_str())
                    .and_then(|rest| rest.strip_prefix('-'))
                    .and_then(|position_id| xtream::id_for_position_id(position_id, url))
                else {
                    continue;
                };
                let kind = id.split_once('-').map_or("", |(kind, _)| kind);
                let new_id = format!("{provider_id}-{id}");
                // A panel that listed a stream twice gave it two position ids
                // but it has one stream id. The first listing's row takes the
                // new id and the others join it.
                let keeps_row = taken.insert(new_id.clone());
                insert.execute(params![old_id, new_id, keeps_row])?;
                moves.add(old_id, provider_id, new_id, kind, name);
            }
        }

        self.conn.execute_batch(
            "UPDATE OR IGNORE channels
                SET id = (SELECT new_id FROM channel_id_moves WHERE old_id = channels.id)
              WHERE id IN (SELECT old_id FROM channel_id_moves WHERE keeps_row = 1);
             UPDATE channels SET is_favorite = 1
              WHERE id IN (SELECT m.new_id FROM channel_id_moves m
                           JOIN channels c ON c.id = m.old_id
                           WHERE m.keeps_row = 0 AND c.is_favorite = 1);
             DELETE FROM channels
              WHERE id IN (SELECT old_id FROM channel_id_moves WHERE keeps_row = 0);",
        )?;
        self.move_watch_history(&moves)?;
        self.move_downloads(&moves)?;
        self.move_recordings(&moves)?;
        self.move_series_links(&moves)?;
        // OMDb details are looked up by title, and nothing saved with them
        // says which channel they were for, so they can't be checked. The
        // app fetches them again when the channel next opens, and they only
        // last 30 days anyway, so dropping them beats showing another
        // movie's plot.
        self.conn.execute(
            "DELETE FROM omdb_cache WHERE channel_id IN (SELECT old_id FROM channel_id_moves)",
            [],
        )?;
        // A unique column keeps a row already saved for the new id, and the
        // moved row stays behind under the old one.
        for (table, column) in UNCHECKED_CHANNEL_ID_COLUMNS {
            self.conn.execute(
                &format!(
                    "UPDATE OR IGNORE {table}
                        SET {column} = (SELECT new_id FROM channel_id_moves WHERE old_id = {column})
                      WHERE {column} IN (SELECT old_id FROM channel_id_moves)"
                ),
                [],
            )?;
        }
        self.conn
            .execute_batch("DROP TABLE temp.channel_id_moves;")?;
        Ok(())
    }

    /// Moves watch history to the channels it was saved for. A channel has
    /// one history row, so a row that lands on a channel that has one already,
    /// as when two listings of one stream were both watched, is added to it.
    /// Rows move in the order they were saved, so when two were last watched
    /// at the same time, the older row's name and logo stay.
    fn move_watch_history(&self, moves: &ChannelMoves) -> Result<(), CacheError> {
        let rows: Vec<(i64, String, String)> = self.rows_of(
            "SELECT id, channel_id, channel_name FROM watch_history
             WHERE channel_id IN (SELECT old_id FROM channel_id_moves)
             ORDER BY id",
        )?;
        for (id, old_id, name) in rows {
            let Some(new_id) = moves.for_name(&old_id, &name) else {
                continue;
            };
            let merged = self.conn.execute(
                "UPDATE watch_history AS t SET
                    total_duration_seconds = t.total_duration_seconds + s.total_duration_seconds,
                    play_count       = t.play_count + s.play_count,
                    first_watched_at = min(t.first_watched_at, s.first_watched_at),
                    last_watched_at  = max(t.last_watched_at, s.last_watched_at),
                    channel_name     = CASE WHEN s.last_watched_at > t.last_watched_at
                                            THEN s.channel_name ELSE t.channel_name END,
                    channel_logo     = CASE WHEN s.last_watched_at > t.last_watched_at
                                            THEN coalesce(s.channel_logo, t.channel_logo)
                                            ELSE coalesce(t.channel_logo, s.channel_logo) END
                 FROM watch_history AS s
                 WHERE s.id = ?1 AND t.channel_id = ?2",
                params![id, new_id],
            )?;
            if merged > 0 {
                self.conn
                    .execute("DELETE FROM watch_history WHERE id = ?1", params![id])?;
            } else {
                self.conn.execute(
                    "UPDATE watch_history SET channel_id = ?2 WHERE id = ?1",
                    params![id, new_id],
                )?;
            }
        }
        Ok(())
    }

    /// Moves movie downloads to the channels they were saved for. The cleanup
    /// at launch keeps one download per channel and drops the other records
    /// but not their files, so a download never joins a channel that has a
    /// finished one. It stays under its old id with its file instead.
    /// Finished downloads move first, so they get their channel ahead of
    /// one that hasn't finished.
    fn move_downloads(&self, moves: &ChannelMoves) -> Result<(), CacheError> {
        let rows: Vec<(String, String, String)> = self.rows_of(
            "SELECT id, channel_id, title FROM downloads
             WHERE channel_id IN (SELECT old_id FROM channel_id_moves)
             ORDER BY (status = 'completed') DESC, created_at DESC",
        )?;
        for (id, old_id, title) in rows {
            let Some(new_id) = moves.for_name(&old_id, &title) else {
                continue;
            };
            self.conn.execute(
                "UPDATE downloads SET channel_id = ?2
                  WHERE id = ?1 AND NOT EXISTS (
                      SELECT 1 FROM downloads WHERE channel_id = ?2 AND status = 'completed')",
                params![id, new_id],
            )?;
        }
        Ok(())
    }

    /// Moves each recording's link to the live channel it records. A
    /// recording keeps its channel's name as its title, so the link moves
    /// only to a channel with that name. One that stays is found by name
    /// when the recording starts.
    fn move_recordings(&self, moves: &ChannelMoves) -> Result<(), CacheError> {
        let rows: Vec<(String, String, String)> = self.rows_of(
            "SELECT id, source_channel_id, title FROM downloads
             WHERE source_channel_id IN (SELECT old_id FROM channel_id_moves)",
        )?;
        for (id, old_id, title) in rows {
            if let Some(new_id) = moves.for_name(&old_id, &title) {
                self.conn.execute(
                    "UPDATE downloads SET source_channel_id = ?2 WHERE id = ?1",
                    params![id, new_id],
                )?;
            }
        }
        Ok(())
    }

    /// Moves the series links of episode downloads and the saved episode
    /// lists. Neither keeps the series' name, but the episode ids in them
    /// hold the panel's id for the series.
    fn move_series_links(&self, moves: &ChannelMoves) -> Result<(), CacheError> {
        let episodes: Vec<(String, String, String)> = self.rows_of(
            "SELECT id, channel_id, series_channel_id FROM downloads
             WHERE series_channel_id IN (SELECT old_id FROM channel_id_moves)",
        )?;
        // An episode id without a series id in it is left for
        // UNCHECKED_CHANNEL_ID_COLUMNS, which moves it by position as before,
        // since the download keeps nothing else that names its series.
        for (id, episode_id, old_id) in episodes {
            if let Some(new_id) = moves.for_episode(&old_id, &episode_id) {
                self.conn.execute(
                    "UPDATE downloads SET series_channel_id = ?2 WHERE id = ?1",
                    params![id, new_id],
                )?;
            }
        }

        let lists: Vec<(String, String)> = self.rows_of(
            "SELECT series_channel_id, episodes_json FROM series_episode_cache
             WHERE series_channel_id IN (SELECT old_id FROM channel_id_moves)
             ORDER BY updated_at DESC",
        )?;
        for (old_id, json) in lists {
            let first_episode = serde_json::from_str::<Vec<Channel>>(&json)
                .ok()
                .and_then(|episodes| episodes.into_iter().next());
            // The app saves a list only when an episode is downloaded, and
            // can't fetch it again offline, which is what the list is for.
            // So a list with no episode to check moves by position, as before,
            // rather than being dropped.
            let new_id = first_episode
                .and_then(|episode| moves.for_episode(&old_id, &episode.id))
                .or_else(|| moves.by_position(&old_id).map(str::to_string));
            if let Some(new_id) = new_id {
                // A series has one saved list, and newer lists move first,
                // so a series keeps the newest list that names it. The others
                // stay under their old ids.
                self.conn.execute(
                    "UPDATE OR IGNORE series_episode_cache SET series_channel_id = ?2
                      WHERE series_channel_id = ?1",
                    params![old_id, new_id],
                )?;
            }
        }
        Ok(())
    }

    /// Every row `sql` returns, each as a tuple of its columns.
    fn rows_of<T>(&self, sql: &str) -> Result<Vec<T>, CacheError>
    where
        T: for<'a> TryFrom<&'a rusqlite::Row<'a>, Error = rusqlite::Error>,
    {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map([], |row| T::try_from(row))?;
        Ok(rows.collect::<SqlResult<_>>()?)
    }

    /// Add the column `definition` to `table`. A table that has the column
    /// already is left as it is. Any other error is returned, since queries
    /// that use the column would fail without it.
    fn add_column(&self, table: &str, definition: &str) -> Result<(), CacheError> {
        let sql = format!("ALTER TABLE {table} ADD COLUMN {definition};");
        match self.conn.execute_batch(&sql) {
            Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
                if msg.starts_with("duplicate column name") =>
            {
                Ok(())
            }
            result => Ok(result?),
        }
    }

    // --- Providers ---

    pub fn upsert_provider(&self, provider: &Provider) -> Result<(), CacheError> {
        let ptype = match provider.provider_type {
            ProviderType::M3u => "m3u",
            ProviderType::Xtream => "xtream",
        };
        // Use INSERT ... ON CONFLICT DO UPDATE (not INSERT OR REPLACE) so the existing
        // row is updated in-place rather than deleted + re-inserted.  DELETE + INSERT
        // would trigger ON DELETE CASCADE and wipe all channels for the provider.
        self.conn.execute(
            "INSERT INTO providers (id, name, provider_type, url, username, password, last_updated, channel_count, epg_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               name          = excluded.name,
               provider_type = excluded.provider_type,
               url           = excluded.url,
               username      = excluded.username,
               password      = excluded.password,
               last_updated  = excluded.last_updated,
               channel_count = excluded.channel_count,
               epg_url       = excluded.epg_url",
            params![
                provider.id,
                provider.name,
                ptype,
                provider.url,
                provider.username,
                provider.password,
                provider.last_updated,
                provider.channel_count as i64,
                provider.epg_url,
            ],
        )?;
        Ok(())
    }

    pub fn update_provider_credentials(
        &self,
        id: &str,
        name: &str,
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "UPDATE providers SET name = ?1, url = ?2, username = ?3, password = ?4 WHERE id = ?5",
            params![name, url, username, password, id],
        )?;
        Ok(())
    }

    pub fn get_providers(&self) -> Result<Vec<Provider>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, provider_type, url, username, password, last_updated, channel_count, epg_url FROM providers"
        )?;
        let providers = stmt.query_map([], |row| {
            let ptype: String = row.get(2)?;
            Ok(Provider {
                id: row.get(0)?,
                name: row.get(1)?,
                provider_type: if ptype == "xtream" {
                    ProviderType::Xtream
                } else {
                    ProviderType::M3u
                },
                url: row.get(3)?,
                username: row.get(4)?,
                password: row.get(5)?,
                last_updated: row.get(6)?,
                channel_count: row.get::<_, i64>(7)? as usize,
                epg_url: row.get(8)?,
            })
        })?.collect::<SqlResult<Vec<_>>>()?;
        Ok(providers)
    }

    pub fn get_provider(&self, id: &str) -> Result<Option<Provider>, CacheError> {
        let result = self.conn.query_row(
            "SELECT id, name, provider_type, url, username, password, last_updated, channel_count, epg_url FROM providers WHERE id = ?1",
            params![id],
            |row| {
                let ptype: String = row.get(2)?;
                Ok(Provider {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider_type: if ptype == "xtream" { ProviderType::Xtream } else { ProviderType::M3u },
                    url: row.get(3)?,
                    username: row.get(4)?,
                    password: row.get(5)?,
                    last_updated: row.get(6)?,
                    channel_count: row.get::<_, i64>(7)? as usize,
                    epg_url: row.get(8)?,
                })
            },
        );
        match result {
            Ok(p) => Ok(Some(p)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
    }

    /// Delete a provider and everything stored for it in one transaction: its
    /// channels and login, guide data, category layout and pins, and the watch
    /// history, metadata and episode lists of its channels. Saved positions go
    /// too, unless another provider has the same title. Download records stay,
    /// along with the files they point to.
    pub fn remove_provider(&self, id: &str) -> Result<(), CacheError> {
        self.conn.execute_batch("BEGIN")?;
        match self.remove_provider_inner(id) {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(())
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    fn remove_provider_inner(&self, id: &str) -> Result<(), CacheError> {
        // The load commands give every channel and episode an id that starts
        // with the provider's id and a dash, so rows keyed by channel id match
        // on that. Episodes have no row in `channels`, so this also catches
        // their history.
        let prefix = format!("{id}-");

        // Positions are keyed by title, so another provider can share one.
        let mut keys = self.position_keys(id, &prefix, true)?;
        for key in self.position_keys(id, &prefix, false)? {
            keys.remove(&key);
        }
        {
            let mut stmt = self
                .conn
                .prepare("DELETE FROM playback_positions WHERE content_key = ?1")?;
            for key in &keys {
                stmt.execute(params![key])?;
            }
        }

        for (table, column) in [
            ("watch_history", "channel_id"),
            ("omdb_cache", "channel_id"),
            ("epg_cache", "channel_id"),
            ("series_episode_cache", "series_channel_id"),
        ] {
            self.conn.execute(
                &format!("DELETE FROM {table} WHERE substr({column}, 1, length(?1)) = ?1"),
                params![prefix],
            )?;
        }
        for table in [
            "epg_programmes",
            "group_hierarchy",
            "pinned_groups",
            "channels",
        ] {
            self.conn.execute(
                &format!("DELETE FROM {table} WHERE provider_id = ?1"),
                params![id],
            )?;
        }
        self.conn.execute("DELETE FROM providers WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// The position keys of the provider's movies and episodes, or with `own`
    /// false, of every other provider's. Episodes come from the watch history,
    /// since only the episodes of a playlist are in `channels`.
    fn position_keys(
        &self,
        provider_id: &str,
        prefix: &str,
        own: bool,
    ) -> Result<std::collections::HashSet<String>, CacheError> {
        let mut keys = std::collections::HashSet::new();

        let mut stmt = self.conn.prepare(
            "SELECT name, content_type, series_title, season, episode FROM channels
             WHERE content_type != 'live' AND (provider_id = ?1) = ?2",
        )?;
        let rows = stmt.query_map(params![provider_id, own], |row| {
            Ok(playback_key(
                &row.get::<_, String>(0)?,
                &row.get::<_, String>(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?;
        for key in rows {
            keys.extend(key?);
        }

        let mut stmt = self.conn.prepare(
            "SELECT channel_name, content_type FROM watch_history
             WHERE (substr(channel_id, 1, length(?1)) = ?1) = ?2",
        )?;
        let rows = stmt.query_map(params![prefix, own], |row| {
            Ok(playback_key(
                &row.get::<_, String>(0)?,
                &row.get::<_, String>(1)?,
                None,
                None,
                None,
            ))
        })?;
        for key in rows {
            keys.extend(key?);
        }
        Ok(keys)
    }

    // --- Channels ---

    pub fn save_channels(&self, provider_id: &str, channels: &[Channel]) -> Result<(), CacheError> {
        self.save_channels_keeping(provider_id, channels, &[])
            .map(|_| ())
    }

    /// Replaces a provider's saved channels with `channels`, but leaves the
    /// saved channels of each content type in `kept` as they are. A refresh
    /// passes the content types whose list didn't load, so a panel that fails
    /// to answer for its movies doesn't empty them. Returns how many channels
    /// the provider has saved now.
    pub fn save_channels_keeping(
        &self,
        provider_id: &str,
        channels: &[Channel],
        kept: &[&str],
    ) -> Result<usize, CacheError> {
        let tx = self.conn.unchecked_transaction()?;
        let count = self.save_channels_inner(provider_id, channels, kept)?;
        tx.commit()?;
        Ok(count)
    }

    fn save_channels_inner(
        &self,
        provider_id: &str,
        channels: &[Channel],
        kept: &[&str],
    ) -> Result<usize, CacheError> {
        // Preserve favorites: collect IDs that were favorited before the wipe.
        let mut fav_stmt = self
            .conn
            .prepare("SELECT id FROM channels WHERE provider_id = ?1 AND is_favorite = 1")?;
        let favorites: HashSet<String> = fav_stmt
            .query_map(params![provider_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        // SQLite takes an empty list here, which keeps nothing.
        let placeholders = vec!["?"; kept.len()].join(", ");
        self.conn.execute(
            &format!(
                "DELETE FROM channels WHERE provider_id = ? AND content_type NOT IN ({placeholders})"
            ),
            params_from_iter(std::iter::once(provider_id).chain(kept.iter().copied())),
        )?;

        let mut stmt = self.conn.prepare(
            "INSERT INTO channels (id, provider_id, name, url, logo_url, group_title, tvg_id, tvg_name, is_favorite, content_type, sources, series_title, season, episode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
        )?;

        for ch in channels {
            let sources_json = serde_json::to_string(&ch.sources)
                .unwrap_or_else(|_| "[]".to_string());
            // Restore is_favorite for channels that were favorited before the refresh.
            let is_fav = favorites.contains(&ch.id) || ch.is_favorite;
            stmt.execute(params![
                ch.id,
                provider_id,
                ch.name,
                ch.url,
                ch.logo_url,
                ch.group_title,
                ch.tvg_id,
                ch.tvg_name,
                is_fav as i32,
                &ch.content_type,
                sources_json,
                ch.series_title,
                ch.season.map(|s| s as i64),
                ch.episode.map(|e| e as i64),
            ])?;
        }

        let count: usize = self.conn.query_row(
            "SELECT COUNT(*) FROM channels WHERE provider_id = ?1",
            params![provider_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    pub fn get_channels(&self, provider_id: &str) -> Result<Vec<Channel>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, url, logo_url, group_title, tvg_id, tvg_name, is_favorite, content_type, sources, series_title, season, episode
             FROM channels WHERE provider_id = ?1 ORDER BY name"
        )?;
        let mut channels = stmt.query_map(params![provider_id], |row| {
            let sources_json: String = row.get(9).unwrap_or_else(|_| "[]".to_string());
            let sources: Vec<String> = serde_json::from_str(&sources_json).unwrap_or_default();
            Ok(Channel {
                id: row.get(0)?,
                name: row.get(1)?,
                url: row.get(2)?,
                logo_url: row.get(3)?,
                group_title: row.get(4)?,
                tvg_id: row.get(5)?,
                tvg_name: row.get(6)?,
                is_favorite: row.get::<_, i32>(7)? != 0,
                content_type: row.get(8)?,
                sources,
                series_title: row.get(10)?,
                season: row.get::<_, Option<i64>>(11)?.map(|s| s as u32),
                episode: row.get::<_, Option<i64>>(12)?.map(|e| e as u32),
            })
        })?.collect::<SqlResult<Vec<_>>>()?;
        enrich_stale_series(&mut channels);
        Ok(channels)
    }

    pub fn get_all_channels(&self) -> Result<Vec<Channel>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, url, logo_url, group_title, tvg_id, tvg_name, is_favorite, content_type, sources, series_title, season, episode
             FROM channels ORDER BY name"
        )?;
        let mut channels = stmt.query_map([], |row| {
            let sources_json: String = row.get(9).unwrap_or_else(|_| "[]".to_string());
            let sources: Vec<String> = serde_json::from_str(&sources_json).unwrap_or_default();
            Ok(Channel {
                id: row.get(0)?,
                name: row.get(1)?,
                url: row.get(2)?,
                logo_url: row.get(3)?,
                group_title: row.get(4)?,
                tvg_id: row.get(5)?,
                tvg_name: row.get(6)?,
                is_favorite: row.get::<_, i32>(7)? != 0,
                content_type: row.get(8)?,
                sources,
                series_title: row.get(10)?,
                season: row.get::<_, Option<i64>>(11)?.map(|s| s as u32),
                episode: row.get::<_, Option<i64>>(12)?.map(|e| e as u32),
            })
        })?.collect::<SqlResult<Vec<_>>>()?;
        enrich_stale_series(&mut channels);
        Ok(channels)
    }

    /// Look up a single channel by its ID. Used to resolve Xtream series metadata.
    pub fn get_channel_by_id(&self, channel_id: &str) -> Result<Option<Channel>, CacheError> {
        let result = self.conn.query_row(
            "SELECT id, name, url, logo_url, group_title, tvg_id, tvg_name, is_favorite, content_type, sources, series_title, season, episode
             FROM channels WHERE id = ?1",
            params![channel_id],
            |row| {
                let sources_json: String = row.get(9).unwrap_or_else(|_| "[]".to_string());
                let sources: Vec<String> = serde_json::from_str(&sources_json).unwrap_or_default();
                Ok(Channel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    url: row.get(2)?,
                    logo_url: row.get(3)?,
                    group_title: row.get(4)?,
                    tvg_id: row.get(5)?,
                    tvg_name: row.get(6)?,
                    is_favorite: row.get::<_, i32>(7)? != 0,
                    content_type: row.get(8)?,
                    sources,
                    series_title: row.get(10)?,
                    season: row.get::<_, Option<i64>>(11)?.map(|s| s as u32),
                    episode: row.get::<_, Option<i64>>(12)?.map(|e| e as u32),
                })
            },
        );
        match result {
            Ok(ch) => Ok(Some(ch)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
    }

    /// Find the provider that owns a given channel (JOIN query).
    pub fn get_provider_for_channel(&self, channel_id: &str) -> Result<Option<Provider>, CacheError> {
        let result = self.conn.query_row(
            "SELECT p.id, p.name, p.provider_type, p.url, p.username, p.password, p.last_updated, p.channel_count, p.epg_url
             FROM providers p JOIN channels c ON c.provider_id = p.id WHERE c.id = ?1",
            params![channel_id],
            |row| {
                let ptype: String = row.get(2)?;
                Ok(Provider {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider_type: if ptype == "xtream" { ProviderType::Xtream } else { ProviderType::M3u },
                    url: row.get(3)?,
                    username: row.get(4)?,
                    password: row.get(5)?,
                    last_updated: row.get(6)?,
                    channel_count: row.get::<_, i64>(7)? as usize,
                    epg_url: row.get(8)?,
                })
            },
        );
        match result {
            Ok(p) => Ok(Some(p)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
    }

    pub fn toggle_favorite(&self, channel_id: &str) -> Result<bool, CacheError> {
        let current: i32 = self.conn.query_row(
            "SELECT is_favorite FROM channels WHERE id = ?1",
            params![channel_id],
            |row| row.get(0),
        )?;
        let new_val = if current == 0 { 1 } else { 0 };
        self.conn.execute(
            "UPDATE channels SET is_favorite = ?1 WHERE id = ?2",
            params![new_val, channel_id],
        )?;
        Ok(new_val == 1)
    }

    /// Insert or update a single channel row, keyed on `channel.id`.
    /// On conflict, mutable fields are updated but `is_favorite` and `provider_id` are preserved.
    /// Ensures the `provider_id` row exists in the `providers` table (idempotent INSERT OR IGNORE).
    pub fn upsert_channel(&self, provider_id: &str, ch: &Channel) -> Result<(), CacheError> {
        // Satisfy the FK constraint: ensure the provider row exists.
        self.conn.execute(
            "INSERT OR IGNORE INTO providers (id, name, provider_type, url, channel_count) VALUES (?1, ?2, 'sentinel', '', 0)",
            params![provider_id, provider_id],
        )?;

        let sources_json = serde_json::to_string(&ch.sources).unwrap_or_else(|_| "[]".to_string());
        self.conn.execute(
            "INSERT INTO channels (id, provider_id, name, url, logo_url, group_title, tvg_id, tvg_name, is_favorite, content_type, sources, series_title, season, episode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
               name         = excluded.name,
               url          = excluded.url,
               logo_url     = excluded.logo_url,
               group_title  = excluded.group_title,
               tvg_id       = excluded.tvg_id,
               tvg_name     = excluded.tvg_name,
               content_type = excluded.content_type,
               sources      = excluded.sources,
               series_title = excluded.series_title,
               season       = excluded.season,
               episode      = excluded.episode",
            params![
                ch.id,
                provider_id,
                ch.name,
                ch.url,
                ch.logo_url,
                ch.group_title,
                ch.tvg_id,
                ch.tvg_name,
                ch.is_favorite as i32,
                &ch.content_type,
                sources_json,
                ch.series_title,
                ch.season.map(|s| s as i64),
                ch.episode.map(|e| e as i64),
            ],
        )?;
        Ok(())
    }

    // --- EPG Cache ---

    pub fn save_epg_data(&self, channel_id: &str, json: &str) -> Result<(), CacheError> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT OR REPLACE INTO epg_cache (channel_id, data_json, fetched_at) VALUES (?1, ?2, ?3)",
            params![channel_id, json, now],
        )?;
        Ok(())
    }

    pub fn get_epg_data(&self, channel_id: &str) -> Result<Option<String>, CacheError> {
        let result = self.conn.query_row(
            "SELECT data_json FROM epg_cache WHERE channel_id = ?1 ORDER BY fetched_at DESC LIMIT 1",
            params![channel_id],
            |row| row.get(0),
        );
        match result {
            Ok(json) => Ok(Some(json)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
    }

    // --- EPG Programmes ---

    pub fn save_epg_programmes(
        &self,
        provider_id: &str,
        programmes: &[StoredEpgProgram],
    ) -> Result<(), CacheError> {
        self.conn.execute_batch("BEGIN")?;
        match self.save_epg_programmes_inner(provider_id, programmes) {
            Ok(()) => { self.conn.execute_batch("COMMIT")?; Ok(()) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    fn save_epg_programmes_inner(
        &self,
        provider_id: &str,
        programmes: &[StoredEpgProgram],
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "DELETE FROM epg_programmes WHERE provider_id = ?1",
            params![provider_id],
        )?;
        for prog in programmes {
            self.conn.execute(
                "INSERT INTO epg_programmes
                 (channel_id, title, description, start_time, end_time, category, provider_id, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    prog.channel_id, prog.title, prog.description,
                    prog.start_time, prog.end_time, prog.category,
                    prog.provider_id, prog.fetched_at,
                ],
            )?;
        }
        Ok(())
    }

    pub fn get_epg_programmes(
        &self,
        channel_id: &str,
        range_start: i64,
        range_end: i64,
    ) -> Result<Vec<StoredEpgProgram>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT channel_id, title, description, start_time, end_time, category, provider_id, fetched_at
             FROM epg_programmes
             WHERE channel_id = ?1 AND start_time < ?3 AND end_time > ?2
             ORDER BY start_time ASC",
        )?;
        let rows = stmt.query_map(
            params![channel_id, range_start, range_end],
            Self::row_to_epg_programme,
        )?;
        rows.collect::<SqlResult<Vec<_>>>().map_err(CacheError::Db)
    }

    /// Fetch all EPG programmes across all channels within a time range.
    /// Used to bulk-load the 3-hour window for the live channel list.
    pub fn get_epg_all_channels(
        &self,
        range_start: i64,
        range_end: i64,
    ) -> Result<Vec<StoredEpgProgram>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT channel_id, title, description, start_time, end_time, category, provider_id, fetched_at
             FROM epg_programmes
             WHERE start_time < ?2 AND end_time > ?1
             ORDER BY channel_id ASC, start_time ASC",
        )?;
        let rows = stmt.query_map(params![range_start, range_end], Self::row_to_epg_programme)?;
        rows.collect::<SqlResult<Vec<_>>>().map_err(CacheError::Db)
    }

    /// The EPG programmes of the channels with these guide ids within a time
    /// range, in the same order as `get_epg_all_channels`. The Favorites tab
    /// loads its own channels' programmes this way.
    pub fn get_epg_for_channels(
        &self,
        channel_ids: &[String],
        range_start: i64,
        range_end: i64,
    ) -> Result<Vec<StoredEpgProgram>, CacheError> {
        // The ids go in as one JSON array, so any number of them fits in a
        // single parameter.
        let ids = serde_json::to_string(channel_ids)?;
        let mut stmt = self.conn.prepare(
            "SELECT channel_id, title, description, start_time, end_time, category, provider_id, fetched_at
             FROM epg_programmes
             WHERE channel_id IN (SELECT value FROM json_each(?3))
               AND start_time < ?2 AND end_time > ?1
             ORDER BY channel_id ASC, start_time ASC",
        )?;
        let rows = stmt.query_map(
            params![range_start, range_end, ids],
            Self::row_to_epg_programme,
        )?;
        rows.collect::<SqlResult<Vec<_>>>().map_err(CacheError::Db)
    }

    /// Reads a row whose columns are those of `StoredEpgProgram`, in order.
    fn row_to_epg_programme(row: &rusqlite::Row) -> SqlResult<StoredEpgProgram> {
        Ok(StoredEpgProgram {
            channel_id: row.get(0)?,
            title: row.get(1)?,
            description: row.get(2)?,
            start_time: row.get(3)?,
            end_time: row.get(4)?,
            category: row.get(5)?,
            provider_id: row.get(6)?,
            fetched_at: row.get(7)?,
        })
    }

    /// Search EPG programmes by title/description, joining with channels for display info.
    /// Only returns current and future programmes (end_time > range_start).
    pub fn search_epg_programmes(
        &self,
        query: &str,
        range_start: i64,
    ) -> Result<Vec<StoredEpgProgramWithChannel>, CacheError> {
        let pattern = format!("%{query}%");
        let mut stmt = self.conn.prepare(
            "SELECT e.channel_id, e.title, e.description, e.start_time, e.end_time,
                    COALESCE(c.name, e.channel_id) AS channel_name,
                    c.logo_url AS channel_logo
             FROM (
                 SELECT channel_id, MIN(start_time) AS min_start
                 FROM epg_programmes
                 WHERE (LOWER(title) LIKE LOWER(?1) OR LOWER(description) LIKE LOWER(?1))
                   AND end_time > ?2
                 GROUP BY channel_id
             ) best
             JOIN epg_programmes e ON e.channel_id = best.channel_id
                                   AND e.start_time = best.min_start
             LEFT JOIN channels c ON c.tvg_id = e.channel_id
             ORDER BY e.start_time ASC
             LIMIT 50",
        )?;
        let rows = stmt.query_map(params![pattern, range_start], |row| {
            Ok(StoredEpgProgramWithChannel {
                channel_id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                start_time: row.get(3)?,
                end_time: row.get(4)?,
                channel_name: row.get(5)?,
                channel_logo: row.get(6)?,
            })
        })?;
        rows.collect::<SqlResult<Vec<_>>>().map_err(CacheError::Db)
    }

    pub fn set_provider_epg_url(
        &self,
        provider_id: &str,
        epg_url: Option<&str>,
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "UPDATE providers SET epg_url = ?1 WHERE id = ?2",
            params![epg_url, provider_id],
        )?;
        Ok(())
    }

    // --- Metadata caches ---

    /// Saves `data` as the cached value for `key`, replacing any older one.
    fn save_json<T: Serialize + ?Sized>(&self, cache: JsonCache, key: &str, data: &T) -> Result<(), CacheError> {
        let data_json = serde_json::to_string(data)?;
        let now = chrono::Utc::now().timestamp();
        self.conn.execute(
            &format!(
                "INSERT OR REPLACE INTO {} ({}, data_json, fetched_at) VALUES (?1, ?2, ?3)",
                cache.table, cache.key
            ),
            params![key, data_json, now],
        )?;
        Ok(())
    }

    /// The cached value for `key`, or `None` when there is none or it was saved
    /// more than `ttl_seconds` ago.
    fn get_json<T: DeserializeOwned>(
        &self,
        cache: JsonCache,
        key: &str,
        ttl_seconds: i64,
    ) -> Result<Option<T>, CacheError> {
        let row = self
            .conn
            .query_row(
                &format!("SELECT data_json, fetched_at FROM {} WHERE {} = ?1", cache.table, cache.key),
                params![key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        match row {
            Some((data_json, fetched_at)) if chrono::Utc::now().timestamp() - fetched_at <= ttl_seconds => {
                Ok(Some(serde_json::from_str(&data_json)?))
            }
            _ => Ok(None),
        }
    }

    /// Store OMDB data for a channel. Overwrites any existing cached entry.
    pub fn save_omdb_cache(&self, channel_id: &str, data: &OmdbData) -> Result<(), CacheError> {
        self.save_json(OMDB_CACHE, channel_id, data)
    }

    /// Retrieve cached OMDB data for a channel. Returns `None` if not cached or if the
    /// cached entry is older than `ttl_seconds`.
    pub fn get_omdb_cache(&self, channel_id: &str, ttl_seconds: i64) -> Result<Option<OmdbData>, CacheError> {
        self.get_json(OMDB_CACHE, channel_id, ttl_seconds)
    }

    /// Store MDBList data for an IMDB ID. Overwrites any existing cached entry.
    pub fn save_mdblist_cache(&self, imdb_id: &str, data: &MdbListData) -> Result<(), CacheError> {
        self.save_json(MDBLIST_CACHE, imdb_id, data)
    }

    /// Retrieve cached MDBList data for an IMDB ID. Returns `None` if not cached or stale.
    pub fn get_mdblist_cache(&self, imdb_id: &str, ttl_seconds: i64) -> Result<Option<MdbListData>, CacheError> {
        self.get_json(MDBLIST_CACHE, imdb_id, ttl_seconds)
    }

    /// Store whatson-api data for an IMDB ID. Overwrites any existing cached entry.
    pub fn save_whatson_cache(&self, imdb_id: &str, data: &WhatsonData) -> Result<(), CacheError> {
        self.save_json(WHATSON_CACHE, imdb_id, data)
    }

    /// Retrieve cached whatson-api data for an IMDB ID. Returns `None` if not cached or stale.
    pub fn get_whatson_cache(&self, imdb_id: &str, ttl_seconds: i64) -> Result<Option<WhatsonData>, CacheError> {
        self.get_json(WHATSON_CACHE, imdb_id, ttl_seconds)
    }

    fn opensubtitles_cache_key(imdb_id: &str, season: Option<u32>, episode: Option<u32>) -> String {
        match (season, episode) {
            (Some(s), Some(e)) => format!("{imdb_id}:{s}:{e}"),
            _ => imdb_id.to_string(),
        }
    }

    /// Store OpenSubtitles search results. Overwrites any existing cached entry.
    pub fn save_opensubtitles_search_cache(
        &self,
        imdb_id: &str,
        season: Option<u32>,
        episode: Option<u32>,
        data: &SubtitleSearchResult,
    ) -> Result<(), CacheError> {
        self.save_json(OPENSUBTITLES_CACHE, &Self::opensubtitles_cache_key(imdb_id, season, episode), data)
    }

    /// Retrieve cached OpenSubtitles search results. Returns `None` if not cached or stale.
    pub fn get_opensubtitles_search_cache(
        &self,
        imdb_id: &str,
        season: Option<u32>,
        episode: Option<u32>,
        ttl_seconds: i64,
    ) -> Result<Option<SubtitleSearchResult>, CacheError> {
        self.get_json(OPENSUBTITLES_CACHE, &Self::opensubtitles_cache_key(imdb_id, season, episode), ttl_seconds)
    }

    /// Store what one database had for a video under `SkipQuery::cache_key`.
    /// An empty answer is cached too, so a video with none isn't looked up
    /// again until it expires.
    pub fn save_skip_segments_cache(&self, key: &str, times: &SourceTimes) -> Result<(), CacheError> {
        self.save_json(SKIP_SEGMENTS_CACHE, key, times)
    }

    /// Retrieve what one database had for a video. Returns `None` if not cached or stale.
    pub fn get_skip_segments_cache(&self, key: &str, ttl_seconds: i64) -> Result<Option<SourceTimes>, CacheError> {
        self.get_json(SKIP_SEGMENTS_CACHE, key, ttl_seconds)
    }

    // --- Watch History ---

    /// Upsert a watch history entry. If the channel has been watched before, increments
    /// `play_count` and updates `last_watched_at`. On first watch, inserts with `play_count=1`.
    pub fn record_play_start(
        &self,
        channel_id: &str,
        channel_name: &str,
        channel_logo: Option<&str>,
        content_type: &str,
    ) -> Result<(), CacheError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            "INSERT INTO watch_history
                (channel_id, channel_name, channel_logo, content_type, first_watched_at, last_watched_at, total_duration_seconds, play_count)
             VALUES
                (?1, ?2, ?3, ?4, ?5, ?5, 0, 1)
             ON CONFLICT(channel_id) DO UPDATE SET
                channel_name    = excluded.channel_name,
                channel_logo    = excluded.channel_logo,
                last_watched_at = excluded.last_watched_at,
                play_count      = play_count + 1",
            params![channel_id, channel_name, channel_logo, content_type, now],
        )?;
        Ok(())
    }

    /// Add elapsed seconds to `total_duration_seconds` for the given channel.
    /// Noop if the channel is not found in history, or if `duration_seconds` is non-positive.
    pub fn record_play_end(&self, channel_id: &str, duration_seconds: i64) -> Result<(), CacheError> {
        if duration_seconds <= 0 {
            return Ok(());
        }
        self.conn.execute(
            "UPDATE watch_history
             SET total_duration_seconds = total_duration_seconds + ?1
             WHERE channel_id = ?2",
            params![duration_seconds, channel_id],
        )?;
        Ok(())
    }

    /// Return watch history entries ordered by `last_watched_at DESC`, limited to `limit`.
    pub fn get_watch_history(&self, limit: usize) -> Result<Vec<WatchHistoryEntry>, CacheError> {
        self.query_watch_history(limit, None)
    }

    /// Like [`Self::get_watch_history`], but only entries of one content type,
    /// so a busy type can't push the others out of the limit.
    pub fn get_watch_history_of_type(
        &self,
        content_type: &str,
        limit: usize,
    ) -> Result<Vec<WatchHistoryEntry>, CacheError> {
        self.query_watch_history(limit, Some(content_type))
    }

    fn query_watch_history(
        &self,
        limit: usize,
        content_type: Option<&str>,
    ) -> Result<Vec<WatchHistoryEntry>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT wh.channel_id, wh.channel_name, wh.channel_logo, wh.content_type,
                    wh.first_watched_at, wh.last_watched_at, wh.total_duration_seconds,
                    wh.play_count, c.series_title
             FROM watch_history wh
             LEFT JOIN channels c ON c.id = wh.channel_id
             WHERE ?2 IS NULL OR wh.content_type = ?2
             ORDER BY wh.last_watched_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64, content_type], |row| {
            let channel_name: String = row.get(1)?;
            let content_type: String = row.get(3)?;
            let cached: Option<String> = row.get(8)?;
            let series_title =
                (content_type == "series").then(|| history_series_title(cached, &channel_name));
            Ok(WatchHistoryEntry {
                channel_id: row.get(0)?,
                channel_name,
                channel_logo: row.get(2)?,
                content_type,
                first_watched_at: row.get(4)?,
                last_watched_at: row.get(5)?,
                total_duration_seconds: row.get(6)?,
                play_count: row.get(7)?,
                series_title,
            })
        })?;
        rows.collect::<SqlResult<Vec<_>>>().map_err(CacheError::Db)
    }

    /// Delete a single watch history entry by channel ID.
    pub fn delete_history_entry(&self, channel_id: &str) -> Result<(), CacheError> {
        self.conn.execute(
            "DELETE FROM watch_history WHERE channel_id = ?1",
            params![channel_id],
        )?;
        Ok(())
    }

    /// Delete the history of every episode of one show, matched the way
    /// [`history_series_title`] groups them. This reaches entries older than
    /// any page the UI has loaded. Returns how many entries were removed.
    pub fn delete_history_series(&self, series_title: &str) -> Result<usize, CacheError> {
        let tx = self.conn.unchecked_transaction()?;
        let mut stmt = tx.prepare(
            "SELECT wh.channel_id, wh.channel_name, c.series_title
             FROM watch_history wh
             LEFT JOIN channels c ON c.id = wh.channel_id
             WHERE wh.content_type = 'series'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut ids = Vec::new();
        for row in rows {
            let (channel_id, channel_name, cached) = row?;
            if history_series_title(cached, &channel_name) == series_title {
                ids.push(channel_id);
            }
        }
        drop(stmt);
        let mut delete = tx.prepare("DELETE FROM watch_history WHERE channel_id = ?1")?;
        for channel_id in &ids {
            delete.execute(params![channel_id])?;
        }
        drop(delete);
        tx.commit()?;
        Ok(ids.len())
    }

    /// Delete every history entry of one content type. Resume positions are
    /// kept, as they are when a single entry is deleted.
    pub fn clear_watch_history_of_type(&self, content_type: &str) -> Result<(), CacheError> {
        self.conn.execute(
            "DELETE FROM watch_history WHERE content_type = ?1",
            params![content_type],
        )?;
        Ok(())
    }

    /// Delete all watch history entries, including saved resume positions.
    pub fn clear_watch_history(&self) -> Result<(), CacheError> {
        self.conn.execute("DELETE FROM watch_history", [])?;
        self.conn.execute("DELETE FROM playback_positions", [])?;
        Ok(())
    }

    // --- Playback Positions ---

    /// Insert or overwrite the saved position for `content_key`.
    pub fn save_playback_position(
        &self,
        content_key: &str,
        position_seconds: f64,
        duration_seconds: f64,
    ) -> Result<(), CacheError> {
        self.write_position(content_key, position_seconds, duration_seconds, false)
    }

    /// Saves that `content_key` was watched to the end, with the position at
    /// the end. The player doesn't offer to resume it.
    pub fn mark_position_finished(
        &self,
        content_key: &str,
        duration_seconds: f64,
    ) -> Result<(), CacheError> {
        self.write_position(content_key, duration_seconds, duration_seconds, true)
    }

    fn write_position(
        &self,
        content_key: &str,
        position_seconds: f64,
        duration_seconds: f64,
        finished: bool,
    ) -> Result<(), CacheError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            "INSERT INTO playback_positions (content_key, position_seconds, duration_seconds, updated_at, finished)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(content_key) DO UPDATE SET
                position_seconds = excluded.position_seconds,
                duration_seconds = excluded.duration_seconds,
                updated_at       = excluded.updated_at,
                finished         = excluded.finished",
            params![content_key, position_seconds, duration_seconds, now, finished],
        )?;
        Ok(())
    }

    pub fn get_playback_position(
        &self,
        content_key: &str,
    ) -> Result<Option<PlaybackPosition>, CacheError> {
        let result = self.conn.query_row(
            "SELECT content_key, position_seconds, duration_seconds, updated_at, finished
             FROM playback_positions WHERE content_key = ?1",
            params![content_key],
            |row| {
                Ok(PlaybackPosition {
                    content_key: row.get(0)?,
                    position_seconds: row.get(1)?,
                    duration_seconds: row.get(2)?,
                    updated_at: row.get(3)?,
                    finished: row.get(4)?,
                })
            },
        );
        match result {
            Ok(pos) => Ok(Some(pos)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
    }

    pub fn delete_playback_position(&self, content_key: &str) -> Result<(), CacheError> {
        self.conn.execute(
            "DELETE FROM playback_positions WHERE content_key = ?1",
            params![content_key],
        )?;
        Ok(())
    }

    /// Clear downloaded metadata, guide data and episode lists. Providers,
    /// channels, favorites, history and positions stay.
    pub fn clear_all_caches(&self) -> Result<(), CacheError> {
        for cache in JSON_CACHES {
            self.conn.execute(&format!("DELETE FROM {}", cache.table), [])?;
        }
        self.conn.execute("DELETE FROM epg_programmes", [])?;
        self.conn.execute("DELETE FROM epg_cache", [])?;
        self.conn.execute("DELETE FROM series_episode_cache", [])?;
        Ok(())
    }

    // --- Group Hierarchy ---

    pub fn update_group_sort_order(
        &self,
        provider_id: &str,
        content_type: &str,
        group_name: &str,
        sort_order: i64,
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "UPDATE group_hierarchy SET sort_order = ?1
             WHERE provider_id = ?2 AND content_type = ?3 AND group_name = ?4",
            params![sort_order, provider_id, content_type, group_name],
        )?;
        Ok(())
    }

    pub fn save_group_hierarchy(
        &self,
        provider_id: &str,
        content_type: &str,
        group_name: &str,
        super_category: Option<&str>,
        sort_order: i64,
        is_user_override: bool,
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO group_hierarchy (provider_id, content_type, group_name, super_category, sort_order, is_user_override)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![provider_id, content_type, group_name, super_category, sort_order, is_user_override as i32],
        )?;
        Ok(())
    }

    pub fn get_group_hierarchy(
        &self,
        provider_id: &str,
        content_type: &str,
    ) -> Result<Vec<GroupHierarchyEntry>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT provider_id, content_type, group_name, super_category, sort_order, is_user_override
             FROM group_hierarchy
             WHERE provider_id = ?1 AND content_type = ?2
             ORDER BY sort_order ASC"
        )?;
        let entries = stmt.query_map(params![provider_id, content_type], |row| {
            Ok(GroupHierarchyEntry {
                provider_id: row.get(0)?,
                content_type: row.get(1)?,
                group_name: row.get(2)?,
                super_category: row.get(3)?,
                sort_order: row.get(4)?,
                is_user_override: row.get::<_, i32>(5)? != 0,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn replace_group_hierarchy(
        &self,
        provider_id: &str,
        content_type: &str,
        new_entries: &[(&str, Option<&str>, i64)],
    ) -> Result<(), CacheError> {
        // unchecked_transaction because &self (not &mut self) — matches codebase pattern
        let tx = self.conn.unchecked_transaction()?;

        let mut stmt = tx.prepare(
            "SELECT group_name, super_category, sort_order FROM group_hierarchy
             WHERE provider_id = ?1 AND content_type = ?2 AND is_user_override = 1"
        )?;
        let overrides: Vec<(String, Option<String>, i64)> = stmt.query_map(
            params![provider_id, content_type],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?.collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        tx.execute(
            "DELETE FROM group_hierarchy WHERE provider_id = ?1 AND content_type = ?2",
            params![provider_id, content_type],
        )?;

        let new_group_names: std::collections::HashSet<&str> =
            new_entries.iter().map(|(name, _, _)| *name).collect();
        for (group_name, super_category, sort_order) in new_entries {
            tx.execute(
                "INSERT INTO group_hierarchy (provider_id, content_type, group_name, super_category, sort_order, is_user_override)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![provider_id, content_type, group_name, super_category, sort_order],
            )?;
        }

        for (group_name, super_cat, sort_order) in &overrides {
            if new_group_names.contains(group_name.as_str()) {
                tx.execute(
                    "UPDATE group_hierarchy SET super_category = ?1, sort_order = ?2, is_user_override = 1
                     WHERE provider_id = ?3 AND content_type = ?4 AND group_name = ?5",
                    params![super_cat, sort_order, provider_id, content_type, group_name],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn rename_super_category(
        &self,
        provider_id: &str,
        content_type: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "UPDATE group_hierarchy SET super_category = ?1
             WHERE provider_id = ?2 AND content_type = ?3 AND super_category = ?4",
            params![new_name, provider_id, content_type, old_name],
        )?;
        Ok(())
    }

    pub fn delete_super_category(
        &self,
        provider_id: &str,
        content_type: &str,
        category_name: &str,
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "UPDATE group_hierarchy SET super_category = NULL
             WHERE provider_id = ?1 AND content_type = ?2 AND super_category = ?3",
            params![provider_id, content_type, category_name],
        )?;
        Ok(())
    }

    // --- Pinned Groups ---

    pub fn pin_group(&self, provider_id: &str, content_type: &str, group_name: &str, sort_order: i64) -> Result<(), CacheError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO pinned_groups (provider_id, content_type, group_name, sort_order) VALUES (?1, ?2, ?3, ?4)",
            params![provider_id, content_type, group_name, sort_order],
        )?;
        Ok(())
    }

    pub fn unpin_group(&self, provider_id: &str, content_type: &str, group_name: &str) -> Result<(), CacheError> {
        self.conn.execute(
            "DELETE FROM pinned_groups WHERE provider_id = ?1 AND content_type = ?2 AND group_name = ?3",
            params![provider_id, content_type, group_name],
        )?;
        Ok(())
    }

    pub fn get_pinned_groups(&self, provider_id: &str, content_type: &str) -> Result<Vec<PinnedGroup>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT provider_id, content_type, group_name, sort_order FROM pinned_groups
             WHERE provider_id = ?1 AND content_type = ?2 ORDER BY sort_order ASC"
        )?;
        let pins = stmt.query_map(params![provider_id, content_type], |row| {
            Ok(PinnedGroup {
                provider_id: row.get(0)?,
                content_type: row.get(1)?,
                group_name: row.get(2)?,
                sort_order: row.get(3)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(pins)
    }

    // --- Downloads ---

    /// Insert a download, or update its progress if the id exists. An update
    /// leaves `keep` and `last_played_at` alone, since a download task holding
    /// an older copy of the record would otherwise undo a change the user made
    /// meanwhile. `set_download_keep` and `mark_download_played` change those.
    /// A recording's times, source channel and program title do update, since
    /// a recording that starts late or takes in the next program changes them.
    pub fn upsert_download(&self, rec: &DownloadRecord) -> Result<(), CacheError> {
        let kind = match rec.kind {
            DownloadKind::Movie => "movie",
            DownloadKind::Episode => "episode",
            DownloadKind::Recording => "recording",
        };
        self.conn.execute(
            "INSERT INTO downloads
                (id, channel_id, title, kind, series_channel_id, status, dest_path,
                 total_bytes, downloaded_bytes, avg_rate_bps, error, created_at, finished_at,
                 keep, last_played_at, source_channel_id, start_at, end_at, program_title,
                 program_start, program_end)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
             ON CONFLICT(id) DO UPDATE SET
                status=excluded.status,
                dest_path=excluded.dest_path,
                total_bytes=excluded.total_bytes,
                downloaded_bytes=excluded.downloaded_bytes,
                avg_rate_bps=excluded.avg_rate_bps,
                error=excluded.error,
                finished_at=excluded.finished_at,
                source_channel_id=excluded.source_channel_id,
                start_at=excluded.start_at,
                end_at=excluded.end_at,
                program_title=excluded.program_title,
                program_start=excluded.program_start,
                program_end=excluded.program_end",
            params![
                rec.id, rec.channel_id, rec.title, kind, rec.series_channel_id,
                rec.status.as_str(), rec.dest_path, rec.total_bytes, rec.downloaded_bytes,
                rec.avg_rate_bps, rec.error, rec.created_at, rec.finished_at,
                rec.keep, rec.last_played_at, rec.source_channel_id, rec.start_at,
                rec.end_at, rec.program_title, rec.program_start, rec.program_end,
            ],
        )?;
        Ok(())
    }

    /// Set whether the retention setting skips this download. Returns
    /// whether there was a download `id` to set it on.
    pub fn set_download_keep(&self, id: &str, keep: bool) -> Result<bool, CacheError> {
        let changed = self.conn.execute(
            "UPDATE downloads SET keep = ?2 WHERE id = ?1",
            params![id, keep],
        )?;
        Ok(changed > 0)
    }

    /// Record that the downloaded file started playing at `at`.
    pub fn mark_download_played(&self, id: &str, at: i64) -> Result<(), CacheError> {
        self.conn.execute(
            "UPDATE downloads SET last_played_at = ?2 WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    }

    // Column order in SELECT * matches CREATE TABLE:
    // 0=id, 1=channel_id, 2=title, 3=kind, 4=series_channel_id, 5=status,
    // 6=dest_path, 7=total_bytes, 8=downloaded_bytes, 9=avg_rate_bps,
    // 10=error, 11=created_at, 12=finished_at, 13=keep, 14=last_played_at,
    // 15=source_channel_id, 16=start_at, 17=end_at, 18=program_title,
    // 19=program_start, 20=program_end
    fn row_to_download(row: &rusqlite::Row) -> SqlResult<DownloadRecord> {
        let kind_str: String = row.get(3)?;
        let status_str: String = row.get(5)?;
        Ok(DownloadRecord {
            id: row.get(0)?,
            channel_id: row.get(1)?,
            title: row.get(2)?,
            kind: match kind_str.as_str() {
                "episode" => DownloadKind::Episode,
                "recording" => DownloadKind::Recording,
                _ => DownloadKind::Movie,
            },
            series_channel_id: row.get(4)?,
            status: DownloadStatus::parse(&status_str).unwrap_or(DownloadStatus::Failed),
            dest_path: row.get(6)?,
            total_bytes: row.get(7)?,
            downloaded_bytes: row.get(8)?,
            avg_rate_bps: row.get(9)?,
            error: row.get(10)?,
            created_at: row.get(11)?,
            finished_at: row.get(12)?,
            keep: row.get(13)?,
            last_played_at: row.get(14)?,
            source_channel_id: row.get(15)?,
            start_at: row.get(16)?,
            end_at: row.get(17)?,
            program_title: row.get(18)?,
            program_start: row.get(19)?,
            program_end: row.get(20)?,
        })
    }

    pub fn get_download(&self, id: &str) -> Result<Option<DownloadRecord>, CacheError> {
        let mut stmt = self.conn.prepare("SELECT * FROM downloads WHERE id = ?1")?;
        let mut rows = stmt.query_map(params![id], Self::row_to_download)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn list_downloads(&self) -> Result<Vec<DownloadRecord>, CacheError> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM downloads ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], Self::row_to_download)?;
        Ok(rows.collect::<SqlResult<Vec<_>>>()?)
    }

    /// The file path of every download, for finding a path no other download
    /// uses.
    pub fn list_download_paths(&self) -> Result<Vec<String>, CacheError> {
        let mut stmt = self.conn.prepare("SELECT dest_path FROM downloads")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<SqlResult<Vec<_>>>()?)
    }

    /// Points every download path inside the folder `from` at the same place
    /// inside `to`, after `from` was renamed to `to`. A path outside `from`,
    /// or one that `to` would turn into something other than UTF-8, stays as
    /// it is. Returns how many paths changed.
    pub fn move_download_paths(&self, from: &Path, to: &Path) -> Result<usize, CacheError> {
        let rows: Vec<(String, String)> = {
            let mut stmt = self.conn.prepare("SELECT id, dest_path FROM downloads")?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };
        let tx = self.conn.unchecked_transaction()?;
        let mut changed = 0;
        {
            let mut stmt = tx.prepare("UPDATE downloads SET dest_path = ?2 WHERE id = ?1")?;
            for (id, path) in &rows {
                let Ok(rest) = Path::new(path).strip_prefix(from) else {
                    continue;
                };
                if let Some(moved) = to.join(rest).to_str() {
                    changed += stmt.execute(params![id, moved])?;
                }
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn delete_download(&self, id: &str) -> Result<(), CacheError> {
        self.conn
            .execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete the downloads `ids` together, so an error leaves every one of
    /// them in place.
    pub fn delete_downloads(&self, ids: &[String]) -> Result<(), CacheError> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare("DELETE FROM downloads WHERE id = ?1")?;
            for id in ids {
                stmt.execute(params![id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Drop any prior failed/cancelled records for a channel before a fresh
    /// enqueue, so a successful retry doesn't leave a stale error behind.
    /// (Active records are left untouched.)
    pub fn delete_terminal_downloads_for_channel(
        &self,
        channel_id: &str,
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "DELETE FROM downloads WHERE channel_id = ?1 AND status IN ('failed','cancelled')",
            params![channel_id],
        )?;
        Ok(())
    }

    /// Collapse the history to a single record per channel: a completed record
    /// always wins, otherwise the most recent attempt is kept. Removes stale
    /// duplicates left over from older builds (e.g. a failed attempt sitting
    /// next to a later successful one). Returns the deleted ids.
    pub fn prune_redundant_downloads(&self) -> Result<Vec<String>, CacheError> {
        let ids: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT id FROM downloads WHERE id NOT IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY channel_id
                            ORDER BY (status = 'completed') DESC, created_at DESC
                        ) AS rn
                        FROM downloads
                    ) WHERE rn = 1
                )",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };
        for id in &ids {
            self.conn
                .execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
        }
        Ok(ids)
    }

    pub fn list_downloads_for_series(
        &self,
        series_channel_id: &str,
    ) -> Result<Vec<DownloadRecord>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM downloads WHERE series_channel_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![series_channel_id], Self::row_to_download)?;
        Ok(rows.collect::<SqlResult<Vec<_>>>()?)
    }

    /// Queued or actively downloading items, oldest first (FIFO scheduling).
    pub fn list_active_downloads(&self) -> Result<Vec<DownloadRecord>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM downloads WHERE status IN ('queued','downloading') ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_download)?;
        Ok(rows.collect::<SqlResult<Vec<_>>>()?)
    }

    /// Put downloads that were running when the app last quit back in the
    /// queue. No ffmpeg is running for them after a restart, but the scheduler
    /// would still count each one against the concurrency limit. ffmpeg starts
    /// over and overwrites the partial file, so the progress resets too.
    /// Returns how many were requeued.
    pub fn requeue_interrupted_downloads(&self) -> Result<usize, CacheError> {
        let n = self.conn.execute(
            "UPDATE downloads SET status = 'queued', downloaded_bytes = 0, avg_rate_bps = NULL
             WHERE status = 'downloading'",
            [],
        )?;
        Ok(n)
    }

    /// Every recording, whatever its status, oldest start first.
    pub fn list_recordings(&self) -> Result<Vec<DownloadRecord>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM downloads WHERE kind = 'recording' ORDER BY start_at ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_download)?;
        Ok(rows.collect::<SqlResult<Vec<_>>>()?)
    }

    /// Whether a completed download already exists for a given channel id.
    pub fn completed_download_for_channel(
        &self,
        channel_id: &str,
    ) -> Result<Option<DownloadRecord>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM downloads WHERE channel_id = ?1 AND status = 'completed' LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![channel_id], Self::row_to_download)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    // --- Series episode cache (for offline season/episode selector) ---

    /// Persist the full episode list for a series so its selector works offline.
    pub fn save_series_episodes(
        &self,
        series_channel_id: &str,
        episodes: &[Channel],
    ) -> Result<(), CacheError> {
        let json = serde_json::to_string(episodes).unwrap_or_else(|_| "[]".to_string());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "INSERT INTO series_episode_cache (series_channel_id, episodes_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(series_channel_id) DO UPDATE SET
               episodes_json = excluded.episodes_json,
               updated_at    = excluded.updated_at",
            params![series_channel_id, json, now],
        )?;
        Ok(())
    }

    /// The series whose cached episodes include `episode_id`, if one does.
    pub fn series_of_episode(&self, episode_id: &str) -> Result<Option<String>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT series_channel_id, episodes_json FROM series_episode_cache
             WHERE instr(episodes_json, ?1) > 0 ORDER BY series_channel_id",
        )?;
        let rows = stmt.query_map(params![episode_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (series, json) = row?;
            // The text match only narrows it down; the id has to be an
            // episode's own.
            let episodes: Vec<Channel> = serde_json::from_str(&json).unwrap_or_default();
            if episodes.iter().any(|e| e.id == episode_id) {
                return Ok(Some(series));
            }
        }
        Ok(None)
    }

    /// Read the cached episode list for a series (empty if nothing cached).
    pub fn get_series_episodes(
        &self,
        series_channel_id: &str,
    ) -> Result<Vec<Channel>, CacheError> {
        let json: Result<String, rusqlite::Error> = self.conn.query_row(
            "SELECT episodes_json FROM series_episode_cache WHERE series_channel_id = ?1",
            params![series_channel_id],
            |row| row.get(0),
        );
        match json {
            Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }
}

/// The key that `playbackKey` in the frontend's `lib/playback.ts` saves a
/// position under. Keep the two in step. Series without a season and episode
/// are parsed from the name, as `enrich_stale_series` does before the frontend
/// sees them. None for live channels, which have no position.
pub(crate) fn playback_key(
    name: &str,
    content_type: &str,
    series_title: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
) -> Option<String> {
    if content_type == "live" {
        return None;
    }
    if content_type == "series" {
        let parsed = match (series_title, season, episode) {
            (Some(title), Some(season), Some(episode)) => Some((title, season, episode)),
            _ => parse_series_name(name),
        };
        if let Some((title, season, episode)) = parsed {
            return Some(format!(
                "series:{}:s{season}e{episode}",
                normalize_title(&title)
            ));
        }
    }
    Some(format!("{content_type}:{}", normalize_title(name)))
}

/// Trim, lowercase and collapse runs of whitespace, like `normalize` in
/// `lib/playback.ts`.
fn normalize_title(title: &str) -> String {
    crate::remote::transfer::refs::normalize_title(title)
}

/// For series channels loaded from an older cache that has NULL series_title/season/episode,
/// re-parse the channel name in memory so the frontend always gets enriched metadata.
/// Does not modify the database — the next playlist refresh will persist the correct values.
fn enrich_stale_series(channels: &mut [Channel]) {
    for ch in channels.iter_mut() {
        if ch.content_type != "series" {
            continue;
        }
        if (ch.series_title.is_none() || ch.season.is_none() || ch.episode.is_none())
            && let Some((title, season, episode)) = parse_series_name(&ch.name)
        {
            ch.series_title = Some(title);
            ch.season = Some(season);
            ch.episode = Some(episode);
        }
    }
}

mod transfer;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_crud() {
        let store = CacheStore::open_in_memory().unwrap();
        let provider = Provider {
            id: "p1".into(),
            name: "Test".into(),
            provider_type: ProviderType::M3u,
            url: "http://example.com/playlist.m3u".into(),
            username: None,
            password: None,
            last_updated: None,
            channel_count: 0,
            epg_url: None,
        };
        store.upsert_provider(&provider).unwrap();
        let providers = store.get_providers().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].name, "Test");

        store.remove_provider("p1").unwrap();
        let providers = store.get_providers().unwrap();
        assert!(providers.is_empty());
    }

    fn make_provider(id: &str, name: &str) -> Provider {
        Provider {
            id: id.into(),
            name: name.into(),
            provider_type: ProviderType::M3u,
            url: format!("http://example.com/{id}.m3u"),
            username: None,
            password: None,
            last_updated: None,
            channel_count: 0,
            epg_url: None,
        }
    }

    fn make_channel(id: &str, name: &str, group: &str) -> Channel {
        Channel {
            id: id.into(),
            name: name.into(),
            url: format!("http://stream.example.com/{id}"),
            logo_url: None,
            group_title: group.into(),
            tvg_id: None,
            tvg_name: None,
            is_favorite: false,
            content_type: "live".into(),
            sources: Vec::new(),
            series_title: None,
            season: None,
            episode: None,
        }
    }

    #[test]
    fn test_channel_storage() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "Test")).unwrap();

        let channels = vec![
            make_channel("ch1", "News", "News"),
            make_channel("ch2", "Sports", "Sports"),
        ];
        store.save_channels("p1", &channels).unwrap();
        let loaded = store.get_channels("p1").unwrap();
        assert_eq!(loaded.len(), 2);
    }

    // --- Edge cases ---

    #[test]
    fn test_upsert_provider_updates_existing() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "Original")).unwrap();

        let updated = Provider {
            name: "Updated".into(),
            channel_count: 42,
            ..make_provider("p1", "Updated")
        };
        store.upsert_provider(&updated).unwrap();

        let providers = store.get_providers().unwrap();
        assert_eq!(providers.len(), 1, "upsert must not duplicate");
        assert_eq!(providers[0].name, "Updated");
        assert_eq!(providers[0].channel_count, 42);
    }

    #[test]
    fn test_save_channels_replaces_previous_batch() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P")).unwrap();

        store.save_channels("p1", &[make_channel("ch1", "Old", "G")]).unwrap();
        // Second save should wipe ch1 and only keep the new channels
        store
            .save_channels("p1", &[make_channel("ch2", "New A", "G"), make_channel("ch3", "New B", "G")])
            .unwrap();

        let loaded = store.get_channels("p1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(!loaded.iter().any(|c| c.id == "ch1"), "old channel must be gone");
        assert!(loaded.iter().any(|c| c.id == "ch2"));
        assert!(loaded.iter().any(|c| c.id == "ch3"));
    }

    #[test]
    fn test_remove_provider_cascades_channels() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P")).unwrap();
        store
            .save_channels("p1", &[make_channel("ch1", "Ch", "G"), make_channel("ch2", "Ch2", "G")])
            .unwrap();

        store.remove_provider("p1").unwrap();

        assert!(store.get_providers().unwrap().is_empty());
        assert!(store.get_all_channels().unwrap().is_empty(), "cascade delete must remove channels");
    }

    #[test]
    fn test_toggle_favorite_roundtrip() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P")).unwrap();
        store.save_channels("p1", &[make_channel("ch1", "Ch", "G")]).unwrap();

        let was_fav = store.toggle_favorite("ch1").unwrap();
        assert!(was_fav, "first toggle → favorite");

        let back = store.toggle_favorite("ch1").unwrap();
        assert!(!back, "second toggle → not favorite");

        let ch = &store.get_channels("p1").unwrap()[0];
        assert!(!ch.is_favorite, "persisted state must match");
    }

    #[test]
    fn test_get_all_channels_across_providers() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "Provider 1")).unwrap();
        store.upsert_provider(&make_provider("p2", "Provider 2")).unwrap();
        store.save_channels("p1", &[make_channel("ch1", "A", "G"), make_channel("ch2", "B", "G")]).unwrap();
        store.save_channels("p2", &[make_channel("ch3", "C", "G")]).unwrap();

        let all = store.get_all_channels().unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn get_all_channels_marks_favorites() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P")).unwrap();
        store.save_channels("p1", &[make_channel("ch1", "A", "G"), make_channel("ch2", "B", "G")]).unwrap();
        store.toggle_favorite("ch1").unwrap();

        let favorites: Vec<(String, bool)> =
            store.get_all_channels().unwrap().into_iter().map(|c| (c.id, c.is_favorite)).collect();
        assert_eq!(favorites, [("ch1".to_string(), true), ("ch2".to_string(), false)]);
    }

    #[test]
    fn test_get_channels_only_returns_own_provider() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P1")).unwrap();
        store.upsert_provider(&make_provider("p2", "P2")).unwrap();
        store.save_channels("p1", &[make_channel("ch1", "P1 Ch", "G")]).unwrap();
        store.save_channels("p2", &[make_channel("ch2", "P2 Ch", "G")]).unwrap();

        let p1_channels = store.get_channels("p1").unwrap();
        assert_eq!(p1_channels.len(), 1);
        assert_eq!(p1_channels[0].id, "ch1");
    }

    #[test]
    fn test_epg_save_and_retrieve() {
        let store = CacheStore::open_in_memory().unwrap();
        let json = r#"{"title":"Morning News"}"#;
        store.save_epg_data("ch1", json).unwrap();
        let result = store.get_epg_data("ch1").unwrap();
        assert_eq!(result.as_deref(), Some(json));
    }

    #[test]
    fn test_epg_returns_none_for_unknown_channel() {
        let store = CacheStore::open_in_memory().unwrap();
        let result = store.get_epg_data("nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_epg_programmes_stored_and_retrieved() {
        let store = CacheStore::open_in_memory().unwrap();
        let prog = StoredEpgProgram {
            channel_id: "ch1".into(),
            title: "Morning News".into(),
            description: Some("Daily news".into()),
            start_time: 1700000000,
            end_time: 1700003600,
            category: Some("News".into()),
            provider_id: "p1".into(),
            fetched_at: 1700000000,
        };
        store
            .save_epg_programmes("p1", std::slice::from_ref(&prog))
            .unwrap();
        let result = store.get_epg_programmes("ch1", 1699999000, 1700010000).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].title, "Morning News");
    }

    #[test]
    fn test_epg_programmes_cleared_on_refresh() {
        let store = CacheStore::open_in_memory().unwrap();
        let prog = StoredEpgProgram {
            channel_id: "ch1".into(),
            title: "Old Show".into(),
            description: None,
            start_time: 1700000000,
            end_time: 1700003600,
            category: None,
            provider_id: "p1".into(),
            fetched_at: 1699000000,
        };
        store.save_epg_programmes("p1", &[prog]).unwrap();
        let new_prog = StoredEpgProgram {
            channel_id: "ch1".into(),
            title: "New Show".into(),
            description: None,
            start_time: 1700000000,
            end_time: 1700003600,
            category: None,
            provider_id: "p1".into(),
            fetched_at: 1700000001,
        };
        store.save_epg_programmes("p1", &[new_prog]).unwrap();
        let result = store.get_epg_programmes("ch1", 1699999000, 1700010000).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].title, "New Show");
    }

    #[test]
    fn test_provider_epg_url_saved_and_retrieved() {
        let store = CacheStore::open_in_memory().unwrap();
        let provider = Provider {
            id: "p1".into(),
            name: "Test".into(),
            provider_type: crate::models::playlist::ProviderType::M3u,
            url: "http://example.com/playlist.m3u".into(),
            username: None,
            password: None,
            last_updated: None,
            channel_count: 0,
            epg_url: Some("http://example.com/epg.xml".into()),
        };
        store.upsert_provider(&provider).unwrap();
        let providers = store.get_providers().unwrap();
        assert_eq!(providers[0].epg_url.as_deref(), Some("http://example.com/epg.xml"));
    }

    #[test]
    fn test_stale_series_enriched_on_read() {
        // Simulate a channel stored with content_type="series" but NULL series_title/season/episode
        // (as would happen with data cached before those columns were added).
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P")).unwrap();

        let stale = Channel {
            id: "ch1".into(),
            name: "Suits LA S01E10".into(),
            url: "http://example.com/series/x/y/ep.mp4".into(),
            logo_url: None,
            group_title: "Server 2".into(),
            tvg_id: None,
            tvg_name: None,
            is_favorite: false,
            content_type: "series".into(),
            sources: Vec::new(),
            series_title: None,   // stale — not yet parsed
            season: None,
            episode: None,
        };
        store.save_channels("p1", &[stale]).unwrap();

        let channels = store.get_channels("p1").unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].series_title.as_deref(), Some("Suits LA"));
        assert_eq!(channels[0].season, Some(1));
        assert_eq!(channels[0].episode, Some(10));
    }

    #[test]
    fn test_stale_series_enriched_in_get_all() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P")).unwrap();

        let stale = Channel {
            id: "ch2".into(),
            name: "Breaking Bad S03E07".into(),
            url: "http://example.com/series/bb/S03E07.ts".into(),
            logo_url: None,
            group_title: "Drama".into(),
            tvg_id: None,
            tvg_name: None,
            is_favorite: false,
            content_type: "series".into(),
            sources: Vec::new(),
            series_title: None,
            season: None,
            episode: None,
        };
        store.save_channels("p1", &[stale]).unwrap();

        let channels = store.get_all_channels().unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].series_title.as_deref(), Some("Breaking Bad"));
        assert_eq!(channels[0].season, Some(3));
        assert_eq!(channels[0].episode, Some(7));
    }

    #[test]
    fn a_series_missing_any_one_value_is_parsed_again() {
        let partial = [
            (None, Some(9), Some(9)),
            (Some("Old Title"), None, Some(9)),
            (Some("Old Title"), Some(9), None),
        ];
        for (title, season, episode) in partial {
            let mut channels = [Channel {
                content_type: "series".into(),
                series_title: title.map(String::from),
                season,
                episode,
                ..make_channel("ep1", "Example Show S03E04", "Shows")
            }];
            enrich_stale_series(&mut channels);
            let ch = &channels[0];
            assert_eq!(
                (ch.series_title.as_deref(), ch.season, ch.episode),
                (Some("Example Show"), Some(3), Some(4)),
                "{title:?} {season:?} {episode:?}"
            );
        }
    }

    fn make_omdb_data(title: &str) -> OmdbData {
        OmdbData {
            title: title.into(),
            year: Some("2008".into()),
            rated: Some("PG-13".into()),
            runtime: Some("152 min".into()),
            genre: Some("Action".into()),
            director: Some("Christopher Nolan".into()),
            actors: Some("Christian Bale".into()),
            plot: Some("A movie plot.".into()),
            poster_url: Some("https://example.com/poster.jpg".into()),
            imdb_rating: Some("9.0".into()),
            rotten_tomatoes: Some("94%".into()),
            imdb_id: Some("tt0468569".into()),
            imdb_votes: Some("2,844,668".into()),
        }
    }

    #[test]
    fn test_save_and_retrieve_omdb_cache() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = make_omdb_data("The Dark Knight");

        store.save_omdb_cache("ch1", &data).unwrap();

        // TTL of 30 days in seconds; fresh data should be returned
        let ttl = 30 * 24 * 60 * 60;
        let result = store.get_omdb_cache("ch1", ttl).unwrap();
        assert!(result.is_some());
        let cached = result.unwrap();
        assert_eq!(cached.title, "The Dark Knight");
        assert_eq!(cached.imdb_rating.as_deref(), Some("9.0"));
        assert_eq!(cached.rotten_tomatoes.as_deref(), Some("94%"));
        assert_eq!(cached.imdb_id.as_deref(), Some("tt0468569"));
        assert_eq!(cached.imdb_votes.as_deref(), Some("2,844,668"));
    }

    #[test]
    fn test_get_omdb_cache_returns_none_for_unknown_channel() {
        let store = CacheStore::open_in_memory().unwrap();
        let result = store.get_omdb_cache("nonexistent", 30 * 24 * 60 * 60).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_omdb_cache_respects_ttl() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = make_omdb_data("Old Movie");

        store.save_omdb_cache("ch1", &data).unwrap();

        // Use TTL of -1 so the entry is always considered stale
        let result = store.get_omdb_cache("ch1", -1).unwrap();
        assert!(result.is_none(), "stale cache entry should return None");
    }

    #[test]
    fn a_cache_entry_is_used_until_it_is_older_than_the_ttl() {
        let store = CacheStore::open_in_memory().unwrap();
        store.save_omdb_cache("ch1", &make_omdb_data("Example Film")).unwrap();
        // Move the fetch two hours into the past.
        store.conn.execute("UPDATE omdb_cache SET fetched_at = fetched_at - 7200", []).unwrap();

        assert!(store.get_omdb_cache("ch1", 3 * 3600).unwrap().is_some());
        assert!(store.get_omdb_cache("ch1", 3600).unwrap().is_none());
    }

    #[test]
    fn test_save_omdb_cache_overwrites_existing() {
        let store = CacheStore::open_in_memory().unwrap();

        let first = make_omdb_data("First Movie");
        store.save_omdb_cache("ch1", &first).unwrap();

        let second = OmdbData {
            title: "Second Movie".into(),
            year: None,
            rated: None,
            runtime: None,
            genre: None,
            director: None,
            actors: None,
            plot: None,
            poster_url: None,
            imdb_rating: None,
            rotten_tomatoes: None,
            imdb_id: None,
            imdb_votes: None,
        };
        store.save_omdb_cache("ch1", &second).unwrap();

        let ttl = 30 * 24 * 60 * 60;
        let result = store.get_omdb_cache("ch1", ttl).unwrap().unwrap();
        assert_eq!(result.title, "Second Movie", "second save must overwrite first");
    }

    #[test]
    fn test_omdb_cache_preserves_none_fields() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = OmdbData {
            title: "Minimal Movie".into(),
            year: None,
            rated: None,
            runtime: None,
            genre: None,
            director: None,
            actors: None,
            plot: None,
            poster_url: None,
            imdb_rating: None,
            rotten_tomatoes: None,
            imdb_id: None,
            imdb_votes: None,
        };
        store.save_omdb_cache("ch2", &data).unwrap();

        let ttl = 30 * 24 * 60 * 60;
        let result = store.get_omdb_cache("ch2", ttl).unwrap().unwrap();
        assert_eq!(result.title, "Minimal Movie");
        assert!(result.year.is_none());
        assert!(result.rotten_tomatoes.is_none());
    }

    // --- Watch History Tests ---

    #[test]
    fn test_record_play_start_creates_entry() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .record_play_start("ch1", "BBC News", Some("http://logo.example.com/bbc.png"), "live")
            .unwrap();

        let history = store.get_watch_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].channel_id, "ch1");
        assert_eq!(history[0].channel_name, "BBC News");
        assert_eq!(history[0].play_count, 1);
        assert_eq!(history[0].total_duration_seconds, 0);
    }

    #[test]
    fn test_record_play_start_increments_play_count() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .record_play_start("ch1", "BBC News", None, "live")
            .unwrap();
        let first_entry = store.get_watch_history(10).unwrap();
        let first_watched_at = first_entry[0].first_watched_at;

        // Second call should increment play_count but not change first_watched_at
        store
            .record_play_start("ch1", "BBC News", None, "live")
            .unwrap();

        let history = store.get_watch_history(10).unwrap();
        assert_eq!(history.len(), 1, "must not create duplicate row");
        assert_eq!(history[0].play_count, 2);
        assert_eq!(
            history[0].first_watched_at, first_watched_at,
            "first_watched_at must not change on upsert"
        );
    }

    #[test]
    fn test_record_play_end_accumulates_duration() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .record_play_start("ch1", "Movie Channel", None, "movie")
            .unwrap();
        store.record_play_end("ch1", 30).unwrap();
        store.record_play_end("ch1", 45).unwrap();

        let history = store.get_watch_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].total_duration_seconds, 75);
    }

    #[test]
    fn test_delete_history_entry() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .record_play_start("ch1", "Channel 1", None, "live")
            .unwrap();
        store
            .record_play_start("ch2", "Channel 2", None, "live")
            .unwrap();

        store.delete_history_entry("ch1").unwrap();

        let history = store.get_watch_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].channel_id, "ch2");
    }

    #[test]
    fn test_clear_watch_history() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .record_play_start("ch1", "Channel 1", None, "live")
            .unwrap();
        store
            .record_play_start("ch2", "Channel 2", None, "live")
            .unwrap();
        store
            .record_play_start("ch3", "Channel 3", None, "movie")
            .unwrap();

        store.clear_watch_history().unwrap();

        let history = store.get_watch_history(10).unwrap();
        assert!(history.is_empty(), "history must be empty after clear");
    }

    /// A series episode with an explicit show title.
    fn make_episode(id: &str, name: &str, series_title: &str) -> Channel {
        Channel {
            content_type: "series".into(),
            series_title: Some(series_title.into()),
            ..make_channel(id, name, "Series")
        }
    }

    #[test]
    fn test_watch_history_series_title() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "Test")).unwrap();
        // The cached title wins even when the name says something else.
        store
            .save_channels("p1", &[make_episode("ep1", "GS 1x01 Pilot", "Great Show")])
            .unwrap();
        store
            .record_play_start("ep1", "GS 1x01 Pilot", None, "series")
            .unwrap();
        // Not cached, as with Xtream episodes, so the name is parsed.
        store
            .record_play_start(
                "xt-ep-9-s1-2",
                "Breaking Bad S01E02 Cat's in the Bag",
                None,
                "series",
            )
            .unwrap();
        // Nothing to parse, so the whole name is the show.
        store
            .record_play_start("odd", "Odd Special", None, "series")
            .unwrap();
        store
            .record_play_start("ch1", "BBC News", None, "live")
            .unwrap();

        let history = store.get_watch_history(10).unwrap();
        let title_of = |id: &str| {
            history
                .iter()
                .find(|e| e.channel_id == id)
                .unwrap()
                .series_title
                .clone()
        };
        assert_eq!(title_of("ep1").as_deref(), Some("Great Show"));
        assert_eq!(title_of("xt-ep-9-s1-2").as_deref(), Some("Breaking Bad"));
        assert_eq!(title_of("odd").as_deref(), Some("Odd Special"));
        assert_eq!(title_of("ch1"), None);
    }

    #[test]
    fn test_get_watch_history_of_type() {
        let store = CacheStore::open_in_memory().unwrap();
        for i in 0..5 {
            store
                .record_play_start(&format!("live{i}"), "Live", None, "live")
                .unwrap();
        }
        store
            .record_play_start("m1", "Movie One", None, "movie")
            .unwrap();
        store
            .record_play_start("m2", "Movie Two", None, "movie")
            .unwrap();

        // The live entries would fill a shared limit of 5 on their own.
        let movies = store.get_watch_history_of_type("movie", 5).unwrap();
        let mut ids: Vec<_> = movies.iter().map(|e| e.channel_id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["m1", "m2"]);
        assert_eq!(store.get_watch_history_of_type("live", 3).unwrap().len(), 3);
    }

    #[test]
    fn test_delete_history_series_reaches_every_episode() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "Test")).unwrap();
        store
            .save_channels("p1", &[make_episode("ep1", "GS 1x01 Pilot", "Great Show")])
            .unwrap();
        store
            .record_play_start("ep1", "GS 1x01 Pilot", None, "series")
            .unwrap();
        // More episodes than the Recently Played row ever loads.
        for n in 1..=60 {
            store
                .record_play_start(
                    &format!("gs{n}"),
                    &format!("Great Show S01E{n:02}"),
                    None,
                    "series",
                )
                .unwrap();
        }
        store
            .record_play_start("bb1", "Breaking Bad S01E01", None, "series")
            .unwrap();
        // A live channel named like the show is not an episode of it.
        store
            .record_play_start("ch1", "Great Show S01E01", None, "live")
            .unwrap();

        assert_eq!(store.delete_history_series("Great Show").unwrap(), 61);

        let mut left: Vec<_> = store
            .get_watch_history(100)
            .unwrap()
            .into_iter()
            .map(|e| e.channel_id)
            .collect();
        left.sort_unstable();
        assert_eq!(left, ["bb1", "ch1"]);
        assert_eq!(store.delete_history_series("Great Show").unwrap(), 0);
    }

    #[test]
    fn test_clear_watch_history_of_type() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .record_play_start("m1", "Movie One", None, "movie")
            .unwrap();
        store
            .record_play_start("ch1", "BBC News", None, "live")
            .unwrap();
        store.save_playback_position("m1", 120.0, 5400.0).unwrap();

        store.clear_watch_history_of_type("movie").unwrap();

        let history = store.get_watch_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].channel_id, "ch1");
        assert!(store.get_playback_position("m1").unwrap().is_some());
    }

    #[test]
    fn test_record_play_end_noop_for_missing_channel() {
        let store = CacheStore::open_in_memory().unwrap();
        // Should succeed silently even though channel does not exist
        let result = store.record_play_end("nonexistent", 60);
        assert!(result.is_ok());
    }

    #[test]
    fn test_record_play_end_ignores_non_positive_duration() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .record_play_start("ch1", "Channel 1", None, "live")
            .unwrap();
        store.record_play_end("ch1", 30).unwrap();
        store.record_play_end("ch1", 0).unwrap();
        store.record_play_end("ch1", -5).unwrap();
        let history = store.get_watch_history(10).unwrap();
        assert_eq!(history[0].total_duration_seconds, 30); // only 30 accumulated
    }

    // --- MDBList Cache Tests ---

    #[test]
    fn test_save_and_retrieve_mdblist_cache() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = MdbListData {
            imdb_id: Some("tt0468569".into()),
            description: Some("When the menace known as the Joker...".into()),
            tomatometer: Some(94),
            imdb_rating: Some(9.0),
            imdb_votes: Some(2_844_668),
            ..Default::default()
        };
        store.save_mdblist_cache("tt0468569", &data).unwrap();
        let cached = store.get_mdblist_cache("tt0468569", 7 * 24 * 60 * 60).unwrap().unwrap();
        assert_eq!(cached.imdb_id.as_deref(), Some("tt0468569"));
        assert_eq!(cached.tomatometer, Some(94));
        assert_eq!(cached.imdb_rating, Some(9.0));
    }

    #[test]
    fn test_mdblist_cache_returns_none_on_stale() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = MdbListData { imdb_id: Some("tt1234567".into()), ..Default::default() };
        store.save_mdblist_cache("tt1234567", &data).unwrap();
        // TTL of -1 seconds means everything is stale (negative TTL always stale)
        let result = store.get_mdblist_cache("tt1234567", -1).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_mdblist_cache_returns_none_for_missing() {
        let store = CacheStore::open_in_memory().unwrap();
        let result = store.get_mdblist_cache("tt9999999", 3600).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_save_mdblist_cache_overwrites_existing() {
        let store = CacheStore::open_in_memory().unwrap();
        let data1 = MdbListData { imdb_id: Some("tt0468569".into()), tomatometer: Some(94), ..Default::default() };
        let data2 = MdbListData { imdb_id: Some("tt0468569".into()), tomatometer: Some(80), ..Default::default() };
        store.save_mdblist_cache("tt0468569", &data1).unwrap();
        store.save_mdblist_cache("tt0468569", &data2).unwrap();
        let cached = store.get_mdblist_cache("tt0468569", 3600).unwrap().unwrap();
        assert_eq!(cached.tomatometer, Some(80)); // second write wins
    }

    #[test]
    fn test_mdblist_cache_preserves_none_fields() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = MdbListData { imdb_id: Some("tt0000001".into()), ..Default::default() };
        store.save_mdblist_cache("tt0000001", &data).unwrap();
        let cached = store.get_mdblist_cache("tt0000001", 3600).unwrap().unwrap();
        assert!(cached.description.is_none());
        assert!(cached.tomatometer.is_none());
        assert!(cached.imdb_rating.is_none());
        assert!(cached.metacritic_score.is_none());
    }

    // --- OpenSubtitles Search Cache Tests ---

    fn make_subtitle_result() -> SubtitleSearchResult {
        use crate::iptv::opensubtitles::SubtitleEntry;
        SubtitleSearchResult {
            entries: vec![
                SubtitleEntry {
                    file_id: 4052244,
                    language_code: "en".into(),
                    format: "srt".into(),
                    release_name: Some("The.Dark.Knight.2008.BluRay".into()),
                    download_count: Some(5000),
                },
                SubtitleEntry {
                    file_id: 9988776,
                    language_code: "fr".into(),
                    format: "srt".into(),
                    release_name: None,
                    download_count: Some(1200),
                },
            ],
            languages: vec!["en".into(), "fr".into()],
        }
    }

    #[test]
    fn test_save_and_retrieve_opensubtitles_search_cache() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = make_subtitle_result();

        store
            .save_opensubtitles_search_cache("tt0468569", None, None, &data)
            .unwrap();

        let ttl = 24 * 60 * 60; // 24 hours
        let cached = store
            .get_opensubtitles_search_cache("tt0468569", None, None, ttl)
            .unwrap()
            .unwrap();

        assert_eq!(cached.entries.len(), 2);
        assert_eq!(cached.entries[0].file_id, 4052244);
        assert_eq!(cached.entries[0].language_code, "en");
        assert_eq!(cached.entries[1].file_id, 9988776);
        assert_eq!(cached.languages, vec!["en", "fr"]);
    }

    #[test]
    fn test_opensubtitles_search_cache_episode_key() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = make_subtitle_result();

        store
            .save_opensubtitles_search_cache("tt0903747", Some(3), Some(7), &data)
            .unwrap();

        let ttl = 24 * 60 * 60;
        // Episode-specific lookup should find the entry.
        let cached = store
            .get_opensubtitles_search_cache("tt0903747", Some(3), Some(7), ttl)
            .unwrap();
        assert!(cached.is_some());

        // Movie-style lookup (no season/ep) for same IMDB ID must NOT find it.
        let miss = store
            .get_opensubtitles_search_cache("tt0903747", None, None, ttl)
            .unwrap();
        assert!(miss.is_none());
    }

    #[test]
    fn test_opensubtitles_search_cache_returns_none_on_stale() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = make_subtitle_result();

        store
            .save_opensubtitles_search_cache("tt0468569", None, None, &data)
            .unwrap();

        // TTL of -1 seconds — always stale.
        let result = store
            .get_opensubtitles_search_cache("tt0468569", None, None, -1)
            .unwrap();
        assert!(result.is_none(), "stale cache entry must return None");
    }

    #[test]
    fn test_opensubtitles_search_cache_returns_none_for_missing() {
        let store = CacheStore::open_in_memory().unwrap();
        let result = store
            .get_opensubtitles_search_cache("tt9999999", None, None, 3600)
            .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_save_and_retrieve_whatson_cache() {
        let store = CacheStore::open_in_memory().unwrap();
        let data = WhatsonData { imdb_id: Some("tt0111161".into()), imdb_rating: Some(9.3), ..Default::default() };
        store.save_whatson_cache("tt0111161", &data).unwrap();
        assert_eq!(store.get_whatson_cache("tt0111161", 3600).unwrap(), Some(data));
        assert_eq!(store.get_whatson_cache("tt0111161", -1).unwrap(), None);
        assert_eq!(store.get_whatson_cache("tt9999999", 3600).unwrap(), None);
    }

    fn make_skip_times() -> SourceTimes {
        use crate::iptv::skip_segments::{Fit, SegmentKind, SegmentSource, SkipSegment};
        SourceTimes {
            segments: vec![SkipSegment {
                kind: SegmentKind::Intro,
                start: 229.0,
                end: 246.0,
                source: SegmentSource::IntroDb,
                fit: Fit::Unchecked,
                confidence: Some(1.0),
                offset: None,
                auto_from: None,
                auto_to: None,
            }],
            post_credits: Some(3480.0),
        }
    }

    #[test]
    fn test_save_and_retrieve_skip_segments_cache() {
        let store = CacheStore::open_in_memory().unwrap();
        let times = make_skip_times();
        store.save_skip_segments_cache("introdb:tt0903747:1:1", &times).unwrap();
        assert_eq!(store.get_skip_segments_cache("introdb:tt0903747:1:1", 3600).unwrap(), Some(times));
        assert_eq!(store.get_skip_segments_cache("introdb:tt0903747:1:2", 3600).unwrap(), None);
        assert_eq!(store.get_skip_segments_cache("introdb:tt0903747:1:1", -1).unwrap(), None);
    }

    #[test]
    fn test_skip_segments_cache_keeps_an_empty_answer() {
        let store = CacheStore::open_in_memory().unwrap();
        store.save_skip_segments_cache("skipdb:tt0111161:movie:8520", &SourceTimes::default()).unwrap();
        assert_eq!(
            store.get_skip_segments_cache("skipdb:tt0111161:movie:8520", 3600).unwrap(),
            Some(SourceTimes::default())
        );
    }

    #[test]
    fn test_unreadable_cache_entry_is_an_error() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .conn
            .execute(
                "INSERT INTO skip_segments_cache (cache_key, data_json, fetched_at) VALUES ('k', 'not json', ?1)",
                params![chrono::Utc::now().timestamp()],
            )
            .unwrap();
        assert!(matches!(store.get_skip_segments_cache("k", 3600), Err(CacheError::Serde(_))));
        // A stale one is just stale.
        assert!(matches!(store.get_skip_segments_cache("k", -1), Ok(None)));
    }

    #[test]
    fn test_group_hierarchy_roundtrip() {
        let store = CacheStore::open_in_memory().unwrap();
        store.save_group_hierarchy("prov1", "live", "US: Sports", Some("United States"), 0, false).unwrap();
        store.save_group_hierarchy("prov1", "live", "US: News", Some("United States"), 100, false).unwrap();
        store.save_group_hierarchy("prov1", "live", "Misc", None, 200, false).unwrap();

        let entries = store.get_group_hierarchy("prov1", "live").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].group_name, "US: Sports");
        assert_eq!(entries[0].super_category.as_deref(), Some("United States"));
        assert_eq!(entries[2].super_category, None);
    }

    #[test]
    fn test_replace_group_hierarchy_preserves_overrides() {
        let store = CacheStore::open_in_memory().unwrap();
        store.save_group_hierarchy("p1", "live", "Sports", Some("US"), 0, false).unwrap();
        store.save_group_hierarchy("p1", "live", "News", Some("US"), 100, false).unwrap();
        // User moves News to UK
        store.save_group_hierarchy("p1", "live", "News", Some("UK"), 0, true).unwrap();

        let new_entries = vec![
            ("Sports", Some("America"), 0i64),
            ("News", Some("America"), 100),
            ("Kids", Some("America"), 200),
        ];
        store.replace_group_hierarchy("p1", "live", &new_entries).unwrap();

        let entries = store.get_group_hierarchy("p1", "live").unwrap();
        let news = entries.iter().find(|e| e.group_name == "News").unwrap();
        assert_eq!(news.super_category.as_deref(), Some("UK"));
        assert!(news.is_user_override);
        let sports = entries.iter().find(|e| e.group_name == "Sports").unwrap();
        assert_eq!(sports.super_category.as_deref(), Some("America"));
        assert!(!sports.is_user_override);
    }

    #[test]
    fn test_pinned_groups_crud() {
        let store = CacheStore::open_in_memory().unwrap();
        store.pin_group("p1", "live", "US: Sports", 0).unwrap();
        store.pin_group("p1", "live", "UK: News", 100).unwrap();

        let pins = store.get_pinned_groups("p1", "live").unwrap();
        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0].group_name, "US: Sports");

        store.unpin_group("p1", "live", "US: Sports").unwrap();
        let pins = store.get_pinned_groups("p1", "live").unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].group_name, "UK: News");
    }

    // --- Playback Position Tests ---

    #[test]
    fn test_playback_position_roundtrip() {
        let store = CacheStore::open_in_memory().unwrap();
        assert!(store.get_playback_position("movie:dune").unwrap().is_none());

        store.save_playback_position("movie:dune", 1234.5, 9000.0).unwrap();
        let pos = store.get_playback_position("movie:dune").unwrap().unwrap();
        assert_eq!(pos.content_key, "movie:dune");
        assert_eq!(pos.position_seconds, 1234.5);
        assert_eq!(pos.duration_seconds, 9000.0);
        assert!(pos.updated_at > 0);
    }

    #[test]
    fn test_playback_position_overwrites() {
        let store = CacheStore::open_in_memory().unwrap();
        store.save_playback_position("k", 10.0, 100.0).unwrap();
        store.save_playback_position("k", 55.0, 100.0).unwrap();
        let pos = store.get_playback_position("k").unwrap().unwrap();
        assert_eq!(pos.position_seconds, 55.0);
    }

    #[test]
    fn test_delete_playback_position() {
        let store = CacheStore::open_in_memory().unwrap();
        store.save_playback_position("a", 10.0, 100.0).unwrap();
        store.save_playback_position("b", 20.0, 100.0).unwrap();
        store.delete_playback_position("a").unwrap();
        assert!(store.get_playback_position("a").unwrap().is_none());
        assert!(store.get_playback_position("b").unwrap().is_some());
        // Deleting a missing key is a no-op
        store.delete_playback_position("missing").unwrap();
    }

    #[test]
    fn test_clear_watch_history_clears_playback_positions() {
        let store = CacheStore::open_in_memory().unwrap();
        store.save_playback_position("a", 10.0, 100.0).unwrap();
        store.clear_watch_history().unwrap();
        assert!(store.get_playback_position("a").unwrap().is_none());
    }

    // --- Downloads Tests ---

    use crate::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};

    fn movie_record(id: &str, channel: &str) -> DownloadRecord {
        DownloadRecord {
            id: id.into(),
            channel_id: channel.into(),
            title: "A Movie".into(),
            kind: DownloadKind::Movie,
            series_channel_id: None,
            status: DownloadStatus::Queued,
            dest_path: format!("/tmp/{id}.mkv.part"),
            total_bytes: None,
            downloaded_bytes: 0,
            avg_rate_bps: None,
            error: None,
            created_at: 100,
            finished_at: None,
            keep: false,
            last_played_at: None,
            source_channel_id: None,
            start_at: None,
            end_at: None,
            program_title: None,
            program_start: None,
            program_end: None,
        }
    }

    /// A recording of the live channel `source`. Its own id is its channel id.
    fn recording_record(id: &str, source: &str, status: DownloadStatus) -> DownloadRecord {
        let mut r = movie_record(id, id);
        r.title = "City News".into();
        r.kind = DownloadKind::Recording;
        r.status = status;
        r.dest_path = format!("/tmp/{id}.ts");
        r.source_channel_id = Some(source.into());
        r.start_at = Some(1_000);
        r.end_at = Some(4_600);
        r.program_title = Some("Evening news".into());
        r.program_start = Some(1_120);
        r.program_end = Some(4_300);
        r
    }

    #[test]
    fn insert_and_get_download() {
        let store = CacheStore::open_in_memory().unwrap();
        let rec = movie_record("d1", "c1");
        store.upsert_download(&rec).unwrap();

        let got = store.get_download("d1").unwrap().unwrap();
        assert_eq!(got, rec);
        assert!(store.get_download("missing").unwrap().is_none());
    }

    #[test]
    fn keep_and_last_played_survive_progress_updates() {
        let store = CacheStore::open_in_memory().unwrap();
        let mut rec = movie_record("d1", "c1");
        store.upsert_download(&rec).unwrap();
        assert!(store.set_download_keep("d1", true).unwrap());
        assert!(!store.set_download_keep("missing", true).unwrap());
        store.mark_download_played("d1", 500).unwrap();

        // A download task saving its older copy of the record.
        rec.status = DownloadStatus::Completed;
        store.upsert_download(&rec).unwrap();

        let got = store.get_download("d1").unwrap().unwrap();
        assert_eq!(got.status, DownloadStatus::Completed);
        assert!(got.keep);
        assert_eq!(got.last_played_at, Some(500));

        store.set_download_keep("d1", false).unwrap();
        assert!(!store.get_download("d1").unwrap().unwrap().keep);
    }

    #[test]
    fn adds_retention_columns_to_an_existing_downloads_table() {
        // The table as it was before the retention columns.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE downloads (
                id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, title TEXT NOT NULL,
                kind TEXT NOT NULL, series_channel_id TEXT, status TEXT NOT NULL,
                dest_path TEXT NOT NULL, total_bytes INTEGER,
                downloaded_bytes INTEGER NOT NULL DEFAULT 0, avg_rate_bps INTEGER,
                error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
            );
            INSERT INTO downloads (id, channel_id, title, kind, status, dest_path, created_at)
            VALUES ('d1', 'c1', 'A Movie', 'movie', 'completed', '/tmp/d1.mkv', 100);",
        )
        .unwrap();
        let store = CacheStore { conn };
        store.init_tables().unwrap();
        let got = store.get_download("d1").unwrap().unwrap();
        assert!(!got.keep);
        assert_eq!(got.last_played_at, None);
        // The next launch finds the columns there.
        store.init_tables().unwrap();
    }

    #[test]
    fn adding_a_column_only_ignores_one_that_exists() {
        let store = CacheStore::open_in_memory().unwrap();
        let column = "keep INTEGER NOT NULL DEFAULT 0";
        store.add_column("downloads", column).unwrap();
        assert!(store.add_column("no_such_table", "x INTEGER").is_err());
    }

    #[test]
    fn adds_recording_columns_to_an_existing_downloads_table() {
        // The table as it was with the retention columns.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE downloads (
                id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, title TEXT NOT NULL,
                kind TEXT NOT NULL, series_channel_id TEXT, status TEXT NOT NULL,
                dest_path TEXT NOT NULL, total_bytes INTEGER,
                downloaded_bytes INTEGER NOT NULL DEFAULT 0, avg_rate_bps INTEGER,
                error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
                keep INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER
            );
            INSERT INTO downloads (id, channel_id, title, kind, status, dest_path, created_at)
            VALUES ('d1', 'c1', 'A Movie', 'movie', 'completed', '/tmp/d1.mkv', 100);",
        )
        .unwrap();
        let store = CacheStore { conn };
        store.init_tables().unwrap();
        let got = store.get_download("d1").unwrap().unwrap();
        assert_eq!(got.source_channel_id, None);
        assert_eq!(got.end_at, None);

        let rec = recording_record("r1", "c1", DownloadStatus::Scheduled);
        store.upsert_download(&rec).unwrap();
        assert_eq!(store.get_download("r1").unwrap().unwrap(), rec);
    }

    #[test]
    fn adding_a_column_twice_is_fine_but_other_errors_come_back() {
        let store = CacheStore::open_in_memory().unwrap();
        store.add_column("downloads", "end_at INTEGER").unwrap();
        assert!(store.add_column("no_such_table", "x INTEGER").is_err());
    }

    #[test]
    fn a_recording_round_trips_and_its_window_updates() {
        let store = CacheStore::open_in_memory().unwrap();
        let mut rec = recording_record("r1", "c1", DownloadStatus::Scheduled);
        store.upsert_download(&rec).unwrap();
        assert_eq!(store.get_download("r1").unwrap().unwrap(), rec);

        // Starting late and taking in the next program change the window.
        rec.status = DownloadStatus::Recording;
        rec.start_at = Some(1_200);
        rec.end_at = Some(8_200);
        rec.program_title = Some("Evening news, Late news".into());
        store.upsert_download(&rec).unwrap();
        assert_eq!(store.get_download("r1").unwrap().unwrap(), rec);
        assert_eq!(store.list_recordings().unwrap(), vec![rec]);
    }

    #[test]
    fn recordings_are_never_found_through_their_live_channel() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .upsert_download(&recording_record("r1", "c1", DownloadStatus::Completed))
            .unwrap();
        store
            .upsert_download(&recording_record("r2", "c1", DownloadStatus::Failed))
            .unwrap();
        store
            .upsert_download(&recording_record("r3", "c1", DownloadStatus::Completed))
            .unwrap();

        // Playing the live channel still plays live TV.
        assert!(store.completed_download_for_channel("c1").unwrap().is_none());
        // Downloading something on the channel leaves the failed recording.
        store.delete_terminal_downloads_for_channel("c1").unwrap();
        // Two recordings of one channel aren't duplicates.
        assert!(store.prune_redundant_downloads().unwrap().is_empty());
        assert_eq!(store.list_recordings().unwrap().len(), 3);
    }

    #[test]
    fn list_downloads_returns_all() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_download(&movie_record("d1", "c1")).unwrap();
        store.upsert_download(&movie_record("d2", "c2")).unwrap();
        let all = store.list_downloads().unwrap();
        assert_eq!(all.len(), 2);
        let mut paths = store.list_download_paths().unwrap();
        paths.sort();
        assert_eq!(paths, vec!["/tmp/d1.mkv.part", "/tmp/d2.mkv.part"]);
    }

    #[test]
    fn moving_download_paths_changes_only_the_paths_inside_the_folder() {
        let store = CacheStore::open_in_memory().unwrap();
        let paths = [
            ("inside", "/data/old/downloads/Dune.mkv"),
            ("part", "/data/old/downloads/Heat.mkv.part"),
            ("nested", "/data/old/a/b/Up.ts"),
            ("elsewhere", "/Movies/Alien.mkv"),
            // Shares the folder's name as text, but not as a path.
            ("lookalike", "/data/older/Jaws.mkv"),
        ];
        for (id, path) in paths {
            let mut rec = movie_record(id, id);
            rec.dest_path = path.into();
            store.upsert_download(&rec).unwrap();
        }

        let changed = store
            .move_download_paths(Path::new("/data/old"), Path::new("/data/new"))
            .unwrap();

        assert_eq!(changed, 3);
        let mut paths = store.list_download_paths().unwrap();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "/Movies/Alien.mkv",
                "/data/new/a/b/Up.ts",
                "/data/new/downloads/Dune.mkv",
                "/data/new/downloads/Heat.mkv.part",
                "/data/older/Jaws.mkv",
            ]
        );
        // The rest of each record stays.
        let moved = store.get_download("inside").unwrap().unwrap();
        assert_eq!(moved.title, "A Movie");
        assert_eq!(moved.status, DownloadStatus::Queued);
    }

    #[test]
    fn moving_download_paths_again_changes_nothing() {
        let store = CacheStore::open_in_memory().unwrap();
        let mut rec = movie_record("d1", "c1");
        rec.dest_path = "/data/old/downloads/Dune.mkv".into();
        store.upsert_download(&rec).unwrap();
        let (from, to) = (Path::new("/data/old"), Path::new("/data/new"));

        assert_eq!(store.move_download_paths(from, to).unwrap(), 1);
        assert_eq!(store.move_download_paths(from, to).unwrap(), 0);
        assert_eq!(
            store.list_download_paths().unwrap(),
            vec!["/data/new/downloads/Dune.mkv"]
        );
    }

    #[test]
    fn deletes_several_downloads_at_once() {
        let store = CacheStore::open_in_memory().unwrap();
        for id in ["d1", "d2", "d3"] {
            store.upsert_download(&movie_record(id, id)).unwrap();
        }
        store
            .delete_downloads(&["d1".into(), "d3".into(), "missing".into()])
            .unwrap();
        let left: Vec<_> = store
            .list_downloads()
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(left, vec!["d2"]);
    }

    fn episode_record(id: &str, series: &str, status: DownloadStatus) -> DownloadRecord {
        let mut r = movie_record(id, id);
        r.kind = DownloadKind::Episode;
        r.series_channel_id = Some(series.into());
        r.status = status;
        r
    }

    #[test]
    fn lists_downloads_for_series() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_download(&episode_record("e1", "S1", DownloadStatus::Completed)).unwrap();
        store.upsert_download(&episode_record("e2", "S1", DownloadStatus::Downloading)).unwrap();
        store.upsert_download(&episode_record("e3", "S2", DownloadStatus::Completed)).unwrap();

        let s1 = store.list_downloads_for_series("S1").unwrap();
        assert_eq!(s1.len(), 2);
    }

    #[test]
    fn each_kind_of_download_reads_back_as_saved() {
        let store = CacheStore::open_in_memory().unwrap();
        let records = [
            movie_record("m1", "m1"),
            episode_record("e1", "S1", DownloadStatus::Completed),
            recording_record("r1", "live-1", DownloadStatus::Scheduled),
        ];
        for record in records {
            store.upsert_download(&record).unwrap();
            assert_eq!(store.get_download(&record.id).unwrap(), Some(record));
        }
    }

    #[test]
    fn prune_keeps_completed_over_failed_for_same_channel() {
        let store = CacheStore::open_in_memory().unwrap();
        // Two records for the same channel "c1": an old failed attempt and a
        // later completed one (different download ids).
        let mut failed = movie_record("d-failed", "c1");
        failed.status = DownloadStatus::Failed;
        failed.error = Some("boom".into());
        failed.created_at = 100;
        store.upsert_download(&failed).unwrap();

        let mut done = movie_record("d-done", "c1");
        done.status = DownloadStatus::Completed;
        done.created_at = 200;
        store.upsert_download(&done).unwrap();

        // An unrelated channel should be left alone.
        store.upsert_download(&movie_record("d-other", "c2")).unwrap();

        let pruned = store.prune_redundant_downloads().unwrap();
        assert_eq!(pruned, vec!["d-failed".to_string()]);

        let all = store.list_downloads().unwrap();
        let ids: Vec<_> = all.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"d-done"));
        assert!(ids.contains(&"d-other"));
        assert!(!ids.contains(&"d-failed"));
    }

    #[test]
    fn delete_terminal_clears_failed_but_keeps_active() {
        let store = CacheStore::open_in_memory().unwrap();
        let mut failed = movie_record("d-failed", "c1");
        failed.status = DownloadStatus::Failed;
        store.upsert_download(&failed).unwrap();
        let mut active = movie_record("d-active", "c1");
        active.status = DownloadStatus::Downloading;
        store.upsert_download(&active).unwrap();

        store.delete_terminal_downloads_for_channel("c1").unwrap();

        let all = store.list_downloads().unwrap();
        let ids: Vec<_> = all.iter().map(|r| r.id.as_str()).collect();
        assert!(!ids.contains(&"d-failed"));
        assert!(ids.contains(&"d-active"));
    }

    #[test]
    fn lists_active_downloads() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_download(&movie_record("d1", "c1")).unwrap(); // queued
        let mut dl = movie_record("d2", "c2");
        dl.status = DownloadStatus::Downloading;
        store.upsert_download(&dl).unwrap();
        let mut done = movie_record("d3", "c3");
        done.status = DownloadStatus::Completed;
        store.upsert_download(&done).unwrap();

        let active = store.list_active_downloads().unwrap();
        let ids: Vec<_> = active.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"d1"));
        assert!(ids.contains(&"d2"));
        assert!(!ids.contains(&"d3"));
    }

    #[test]
    fn requeues_interrupted_downloads() {
        let store = CacheStore::open_in_memory().unwrap();
        let mut running = movie_record("d1", "c1");
        running.status = DownloadStatus::Downloading;
        running.downloaded_bytes = 4096;
        running.avg_rate_bps = Some(512);
        store.upsert_download(&running).unwrap();
        store.upsert_download(&movie_record("d2", "c2")).unwrap(); // queued
        let mut done = movie_record("d3", "c3");
        done.status = DownloadStatus::Completed;
        done.downloaded_bytes = 8192;
        store.upsert_download(&done).unwrap();

        assert_eq!(store.requeue_interrupted_downloads().unwrap(), 1);

        let d1 = store.get_download("d1").unwrap().unwrap();
        assert_eq!(d1.status, DownloadStatus::Queued);
        assert_eq!(d1.downloaded_bytes, 0);
        assert_eq!(d1.avg_rate_bps, None);
        assert_eq!(
            store.get_download("d2").unwrap().unwrap().status,
            DownloadStatus::Queued
        );
        let d3 = store.get_download("d3").unwrap().unwrap();
        assert_eq!(d3.status, DownloadStatus::Completed);
        assert_eq!(d3.downloaded_bytes, 8192);
    }

    #[test]
    fn upsert_channel_insert_and_update() {
        let store = CacheStore::open_in_memory().unwrap();
        // upsert_channel uses a sentinel provider_id that need not exist in providers table.
        let ch = Channel {
            id: "ep-001".into(),
            name: "Episode 1".into(),
            url: "http://stream.example.com/ep001".into(),
            logo_url: None,
            group_title: "Drama".into(),
            tvg_id: None,
            tvg_name: None,
            is_favorite: false,
            content_type: "series".into(),
            sources: Vec::new(),
            series_title: Some("Great Show".into()),
            season: Some(1),
            episode: Some(1),
        };

        // Insert via upsert_channel.
        store.upsert_channel("__downloads__", &ch).unwrap();

        // Read it back.
        let loaded = store.get_channel_by_id("ep-001").unwrap().expect("channel should exist");
        assert_eq!(loaded.id, "ep-001");
        assert_eq!(loaded.name, "Episode 1");
        assert_eq!(loaded.url, "http://stream.example.com/ep001");
        assert_eq!(loaded.content_type, "series");
        assert_eq!(loaded.series_title, Some("Great Show".into()));
        assert_eq!(loaded.season, Some(1));
        assert_eq!(loaded.episode, Some(1));
        assert!(!loaded.is_favorite);

        // Upsert again with a changed name; is_favorite should NOT be overwritten.
        let ch2 = Channel {
            name: "Episode 1 (Updated)".into(),
            url: "http://stream.example.com/ep001v2".into(),
            ..ch.clone()
        };
        store.upsert_channel("__downloads__", &ch2).unwrap();

        let updated = store.get_channel_by_id("ep-001").unwrap().expect("channel should still exist");
        assert_eq!(updated.name, "Episode 1 (Updated)");
        assert_eq!(updated.url, "http://stream.example.com/ep001v2");
        // is_favorite must be preserved (not overwritten).
        assert!(!updated.is_favorite);
    }

    #[test]
    fn series_episode_cache_round_trips() {
        let store = CacheStore::open_in_memory().unwrap();

        // Empty before anything is cached.
        assert!(store.get_series_episodes("series-1").unwrap().is_empty());

        let make_ep = |id: &str, ep: u32| Channel {
            id: id.into(),
            name: format!("S01E{ep:02}"),
            url: format!("http://h/ep/{id}"),
            logo_url: None,
            group_title: "Drama".into(),
            tvg_id: None,
            tvg_name: None,
            is_favorite: false,
            content_type: "series".into(),
            sources: Vec::new(),
            series_title: Some("Homeland".into()),
            season: Some(1),
            episode: Some(ep),
        };
        let eps = vec![make_ep("e1", 1), make_ep("e2", 2)];
        store.save_series_episodes("series-1", &eps).unwrap();

        let loaded = store.get_series_episodes("series-1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "e1");
        assert_eq!(loaded[1].episode, Some(2));

        // Overwrite replaces the previous list.
        store.save_series_episodes("series-1", &[make_ep("e1", 1)]).unwrap();
        assert_eq!(store.get_series_episodes("series-1").unwrap().len(), 1);
    }

    #[test]
    fn an_episode_names_the_series_it_was_cached_under() {
        let store = CacheStore::open_in_memory().unwrap();
        let episode = |id: &str, name: &str| Channel {
            id: id.into(),
            name: name.into(),
            content_type: "series".into(),
            ..Channel::default()
        };
        assert_eq!(store.series_of_episode("e1").unwrap(), None, "nothing cached");
        store
            .save_series_episodes("series-1", &[episode("e1", "Pilot"), episode("e2", "Two")])
            .unwrap();
        // The text "e2" is only in this one's name, which doesn't count.
        store
            .save_series_episodes("series-2", &[episode("e20", "Like e2")])
            .unwrap();
        assert_eq!(store.series_of_episode("e2").unwrap().as_deref(), Some("series-1"));
        assert_eq!(store.series_of_episode("e20").unwrap().as_deref(), Some("series-2"));
        assert_eq!(store.series_of_episode("e3").unwrap(), None);
    }

    // --- Channel id changes ---

    fn channel_at(id: &str, url: &str, content_type: &str) -> Channel {
        Channel {
            url: url.into(),
            ..vod(id, id, content_type)
        }
    }

    /// A store as an older version left it, with migrations still to run.
    fn store_before_migrations() -> CacheStore {
        let store = CacheStore::open_in_memory().unwrap();
        store.conn.pragma_update(None, "user_version", 0).unwrap();
        store
    }

    fn user_version(store: &CacheStore) -> usize {
        store
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    fn ids_and_favorites(store: &CacheStore, provider_id: &str) -> Vec<(String, bool)> {
        let mut channels: Vec<(String, bool)> = store
            .get_channels(provider_id)
            .unwrap()
            .into_iter()
            .map(|ch| (ch.id, ch.is_favorite))
            .collect();
        channels.sort();
        channels
    }

    fn owned(pairs: &[(&str, bool)]) -> Vec<(String, bool)> {
        pairs
            .iter()
            .map(|(id, fav)| (id.to_string(), *fav))
            .collect()
    }

    /// `channel` with the name the panel gave it.
    fn named(name: &str, channel: Channel) -> Channel {
        Channel {
            name: name.into(),
            ..channel
        }
    }

    /// The first column of each row `sql` returns.
    fn texts(store: &CacheStore, sql: &str) -> Vec<String> {
        store
            .rows_of::<(String,)>(sql)
            .unwrap()
            .into_iter()
            .map(|(text,)| text)
            .collect()
    }

    /// Saves a history row of a live channel, watched from `first` to `last`
    /// for `seconds` over `plays` plays. Its logo is named after `name`.
    fn watched(
        store: &CacheStore,
        channel_id: &str,
        name: &str,
        first: i64,
        last: i64,
        seconds: i64,
        plays: i64,
    ) {
        store
            .conn
            .execute(
                "INSERT INTO watch_history (channel_id, channel_name, channel_logo, content_type,
                     first_watched_at, last_watched_at, total_duration_seconds, play_count)
                 VALUES (?1, ?2, ?3, 'live', ?4, ?5, ?6, ?7)",
                params![channel_id, name, format!("{name}.png"), first, last, seconds, plays],
            )
            .unwrap();
    }

    /// Each history row as its channel, name, logo, first and last time
    /// watched, seconds watched and plays.
    fn history(store: &CacheStore) -> Vec<String> {
        texts(
            store,
            "SELECT channel_id || ' ' || channel_name || ' ' || ifnull(channel_logo, '-') || ' '
                    || first_watched_at || '-' || last_watched_at || ' '
                    || total_duration_seconds || 's ' || play_count || 'x'
             FROM watch_history ORDER BY channel_id",
        )
    }

    /// Each download as its id and channel.
    fn download_channels(store: &CacheStore) -> Vec<String> {
        texts(store, "SELECT id || ' ' || channel_id FROM downloads ORDER BY id")
    }

    #[test]
    fn a_new_database_has_run_every_migration() {
        let store = CacheStore::open_in_memory().unwrap();
        assert_eq!(user_version(&store), MIGRATIONS.len());
    }

    #[test]
    fn old_xtream_ids_move_to_the_panels_ids_with_their_data() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    channel_at("p1-xt-0", "http://srv/live/u/p/7.ts", "live"),
                    named("Ten", channel_at("p1-vod-0", "http://srv/movie/u/p/10.mkv", "movie")),
                    named(
                        "A Movie",
                        channel_at("p1-vod-1", "http://srv/movie/u/p/11.mkv", "movie"),
                    ),
                    channel_at("p1-ser-0", "xtream://series/5", "series"),
                ],
            )
            .unwrap();
        store.toggle_favorite("p1-vod-0").unwrap();
        store.toggle_favorite("p1-xt-0").unwrap();
        store
            .record_play_start("p1-vod-0", "Ten", None, "movie")
            .unwrap();
        store
            .save_omdb_cache("p1-vod-0", &make_omdb_data("Ten"))
            .unwrap();
        store
            .upsert_download(&movie_record("d1", "p1-vod-1"))
            .unwrap();
        let mut episode = movie_record("d2", "p1-xt-ep-5-s1-0");
        episode.series_channel_id = Some("p1-ser-0".into());
        store.upsert_download(&episode).unwrap();
        let episodes = [channel_at(
            "p1-xt-ep-5-s1-0",
            "http://srv/series/u/p/100.mkv",
            "series",
        )];
        store.save_series_episodes("p1-ser-0", &episodes).unwrap();

        store.migrate().unwrap();

        assert_eq!(
            ids_and_favorites(&store, "p1"),
            owned(&[
                ("p1-live-7", true),
                ("p1-movie-10", true),
                ("p1-movie-11", false),
                ("p1-series-5", false),
            ])
        );
        let movie = store.get_channel_by_id("p1-movie-10").unwrap().unwrap();
        assert_eq!(movie.url, "http://srv/movie/u/p/10.mkv");
        assert_eq!(movie.content_type, "movie");
        assert_eq!(
            store.get_watch_history(10).unwrap()[0].channel_id,
            "p1-movie-10"
        );
        // OMDb details can't be checked against the channel, so they're
        // dropped and fetched again.
        assert_eq!(count(&store, "SELECT COUNT(*) FROM omdb_cache"), 0);
        assert_eq!(
            store.get_download("d1").unwrap().unwrap().channel_id,
            "p1-movie-11"
        );
        let episode = store.get_download("d2").unwrap().unwrap();
        assert_eq!(episode.channel_id, "p1-xt-ep-5-s1-0");
        assert_eq!(episode.series_channel_id.as_deref(), Some("p1-series-5"));
        assert_eq!(store.get_series_episodes("p1-series-5").unwrap().len(), 1);
        assert_eq!(user_version(&store), MIGRATIONS.len());

        // The panel adds a movie at the top. The ids no longer depend on the
        // order, so the favorite stays with its movie.
        store
            .save_channels(
                "p1",
                &[
                    channel_at("p1-movie-12", "http://srv/movie/u/p/12.mkv", "movie"),
                    channel_at("p1-movie-10", "http://srv/movie/u/p/10.mkv", "movie"),
                    channel_at("p1-movie-11", "http://srv/movie/u/p/11.mkv", "movie"),
                ],
            )
            .unwrap();
        let favorites: Vec<String> = ids_and_favorites(&store, "p1")
            .into_iter()
            .filter(|(_, fav)| *fav)
            .map(|(id, _)| id)
            .collect();
        assert_eq!(favorites, ["p1-movie-10"]);
    }

    #[test]
    fn the_move_leaves_other_channels_alone() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .upsert_provider(&make_provider("m1", "Playlist"))
            .unwrap();
        store
            .save_channels(
                "p1",
                &[
                    channel_at("p1-xt-0", "http://srv/live/u/p/stream", "live"),
                    channel_at("p1-movie-9", "http://srv/movie/u/p/9.mp4", "movie"),
                ],
            )
            .unwrap();
        store
            .save_channels(
                "m1",
                &[channel_at("m1-xt-0", "http://srv/live/u/p/7.ts", "live")],
            )
            .unwrap();
        store
            .record_play_start("p1-xt-0", "No id in the URL", None, "live")
            .unwrap();

        store.migrate().unwrap();

        assert_eq!(
            ids_and_favorites(&store, "p1"),
            owned(&[("p1-movie-9", false), ("p1-xt-0", false)])
        );
        assert_eq!(
            ids_and_favorites(&store, "m1"),
            owned(&[("m1-xt-0", false)])
        );
        assert_eq!(
            store.get_watch_history(10).unwrap()[0].channel_id,
            "p1-xt-0"
        );
    }

    #[test]
    fn a_stream_saved_twice_joins_its_first_listing() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("Seven", channel_at("p1-xt-0", "http://srv/live/u/p/7.ts", "live")),
                    channel_at("p1-xt-1", "http://srv/live/u/p/8.ts", "live"),
                    named("Seven", channel_at("p1-xt-2", "http://srv/live/u/p/7.ts", "live")),
                ],
            )
            .unwrap();
        store.toggle_favorite("p1-xt-2").unwrap();
        store
            .record_play_start("p1-xt-2", "Seven", None, "live")
            .unwrap();

        store.migrate().unwrap();

        assert_eq!(
            ids_and_favorites(&store, "p1"),
            owned(&[("p1-live-7", true), ("p1-live-8", false)])
        );
        assert_eq!(
            store.get_watch_history(10).unwrap()[0].channel_id,
            "p1-live-7"
        );
    }

    #[test]
    fn the_move_runs_once() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store.migrate().unwrap();
        store
            .save_channels(
                "p1",
                &[channel_at("p1-xt-0", "http://srv/live/u/p/7.ts", "live")],
            )
            .unwrap();

        store.migrate().unwrap();

        assert_eq!(
            ids_and_favorites(&store, "p1"),
            owned(&[("p1-xt-0", false)])
        );
        assert_eq!(user_version(&store), MIGRATIONS.len());
    }

    #[test]
    fn a_download_whose_place_changed_hands_moves_to_the_movie_with_its_title() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("Alien", channel_at("p1-xt-0", "http://srv/live/u/p/3.ts", "live")),
                    named("Heat", channel_at("p1-vod-0", "http://srv/movie/u/p/10.mkv", "movie")),
                    named("Aliens", channel_at("p1-vod-1", "http://srv/movie/u/p/12.mkv", "movie")),
                    named("Alien", channel_at("p1-vod-2", "http://srv/movie/u/p/11.mkv", "movie")),
                    // One stream listed twice is still one movie of that name.
                    named("Alien", channel_at("p1-vod-3", "http://srv/movie/u/p/11.mkv", "movie")),
                ],
            )
            .unwrap();
        // Saved while Alien was the first movie. Heat has taken its place.
        let alien = DownloadRecord {
            title: "Alien".into(),
            ..movie_record("d1", "p1-vod-0")
        };
        store.upsert_download(&alien).unwrap();
        store
            .record_play_start("p1-vod-0", "Alien", None, "movie")
            .unwrap();
        // A title that differs only in case and spacing still matches.
        let heat = DownloadRecord {
            title: " HEAT ".into(),
            ..movie_record("d2", "p1-vod-0")
        };
        store.upsert_download(&heat).unwrap();

        store.migrate().unwrap();

        // The movie of that name takes Alien's rows, not the live channel or
        // a movie with a longer name.
        assert_eq!(download_channels(&store), ["d1 p1-movie-11", "d2 p1-movie-10"]);
        assert_eq!(
            store.get_watch_history(10).unwrap()[0].channel_id,
            "p1-movie-11"
        );
    }

    #[test]
    fn rows_stay_put_when_two_movies_have_their_title() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("Heat", channel_at("p1-vod-0", "http://srv/movie/u/p/10.mkv", "movie")),
                    named("Alien", channel_at("p1-vod-1", "http://srv/movie/u/p/11.mkv", "movie")),
                    named("Alien", channel_at("p1-vod-2", "http://srv/movie/u/p/12.mkv", "movie")),
                ],
            )
            .unwrap();
        // Saved while Alien was the first movie. The panel now lists two
        // movies of that name, and nothing saved says which one it was.
        let alien = DownloadRecord {
            title: "Alien".into(),
            ..movie_record("d1", "p1-vod-0")
        };
        store.upsert_download(&alien).unwrap();
        store
            .record_play_start("p1-vod-0", "Alien", None, "movie")
            .unwrap();

        store.migrate().unwrap();

        assert_eq!(download_channels(&store), ["d1 p1-vod-0"]);
        assert_eq!(texts(&store, "SELECT channel_id FROM watch_history"), ["p1-vod-0"]);
    }

    #[test]
    fn a_recording_follows_the_live_channel_of_its_name() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("Sports", channel_at("p1-xt-0", "http://srv/live/u/p/8.ts", "live")),
                    named("City News", channel_at("p1-xt-1", "http://srv/live/u/p/7.ts", "live")),
                ],
            )
            .unwrap();
        // Both were scheduled while their channel was the first live one,
        // which Sports is now. No channel is named Weather any more.
        let news = recording_record("rec-1", "p1-xt-0", DownloadStatus::Scheduled);
        store.upsert_download(&news).unwrap();
        let weather = DownloadRecord {
            title: "Weather".into(),
            ..recording_record("rec-2", "p1-xt-0", DownloadStatus::Scheduled)
        };
        store.upsert_download(&weather).unwrap();

        store.migrate().unwrap();

        // A recording's own id stays its channel id.
        assert_eq!(
            texts(
                &store,
                "SELECT id || ' ' || channel_id || ' ' || source_channel_id
                 FROM downloads ORDER BY id"
            ),
            ["rec-1 rec-1 p1-live-7", "rec-2 rec-2 p1-xt-0"]
        );
    }

    #[test]
    fn history_with_no_channel_of_its_name_stays_under_its_old_id() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store.upsert_provider(&xtream_provider("p2")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("News", channel_at("p1-xt-0", "http://srv/live/u/p/7.ts", "live")),
                    named("Sports", channel_at("p1-vod-0", "http://srv/movie/u/p/10.mkv", "movie")),
                ],
            )
            .unwrap();
        store
            .save_channels(
                "p2",
                &[named("Sports", channel_at("p2-xt-0", "http://srv/live/u/p/8.ts", "live"))],
            )
            .unwrap();
        // Saved while p1's first live channel was Sports, which p1 has
        // dropped since. A movie or another provider's channel of that name
        // isn't it.
        store
            .record_play_start("p1-xt-0", "Sports", None, "live")
            .unwrap();

        store.migrate().unwrap();

        let history = store.get_watch_history(10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].channel_id, "p1-xt-0");
        assert_eq!(history[0].channel_name, "Sports");
    }

    #[test]
    fn history_of_two_listings_of_one_stream_is_added_together() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("Seven", channel_at("p1-xt-0", "http://srv/live/u/p/7.ts", "live")),
                    named("Seven", channel_at("p1-xt-1", "http://srv/live/u/p/7.ts", "live")),
                    named("Eight", channel_at("p1-xt-2", "http://srv/live/u/p/8.ts", "live")),
                    named("Eight", channel_at("p1-xt-3", "http://srv/live/u/p/8.ts", "live")),
                ],
            )
            .unwrap();
        // Seven's second listing was watched last, and Eight's first.
        watched(&store, "p1-xt-0", "Seven", 100, 200, 60, 2);
        watched(&store, "p1-xt-1", "SEVEN", 50, 300, 30, 1);
        watched(&store, "p1-xt-2", "Eight", 100, 500, 60, 2);
        watched(&store, "p1-xt-3", "eight", 50, 400, 30, 1);
        // A row with no logo doesn't take the other row's away.
        store
            .conn
            .execute(
                "UPDATE watch_history SET channel_logo = NULL WHERE channel_id = 'p1-xt-1'",
                [],
            )
            .unwrap();

        store.migrate().unwrap();

        assert_eq!(
            history(&store),
            [
                "p1-live-7 SEVEN Seven.png 50-300 90s 3x",
                "p1-live-8 Eight Eight.png 50-500 90s 3x",
            ]
        );
    }

    #[test]
    fn history_watched_at_the_same_time_keeps_the_older_rows_name() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("Seven", channel_at("p1-xt-0", "http://srv/live/u/p/7.ts", "live")),
                    named("Seven", channel_at("p1-xt-1", "http://srv/live/u/p/7.ts", "live")),
                ],
            )
            .unwrap();
        // The second listing's row was saved first, and both were last
        // watched at 300.
        watched(&store, "p1-xt-1", "SEVEN", 50, 300, 30, 1);
        watched(&store, "p1-xt-0", "Seven", 100, 300, 60, 2);

        store.migrate().unwrap();

        assert_eq!(history(&store), ["p1-live-7 SEVEN SEVEN.png 50-300 90s 3x"]);
    }

    #[test]
    fn a_download_never_joins_a_channel_that_has_a_finished_one() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("Heat", channel_at("p1-vod-0", "http://srv/movie/u/p/9.mkv", "movie")),
                    named("Heat", channel_at("p1-vod-1", "http://srv/movie/u/p/9.mkv", "movie")),
                ],
            )
            .unwrap();
        let heat = |id: &str, channel: &str, status, created_at| DownloadRecord {
            title: "Heat".into(),
            status,
            created_at,
            ..movie_record(id, channel)
        };
        store.upsert_download(&heat("d1", "p1-vod-0", DownloadStatus::Completed, 100)).unwrap();
        store.upsert_download(&heat("d2", "p1-vod-1", DownloadStatus::Completed, 200)).unwrap();
        store.upsert_download(&heat("d3", "p1-vod-1", DownloadStatus::Queued, 300)).unwrap();

        store.migrate().unwrap();

        // The newest finished download takes the channel. The others keep
        // their old ids, so the cleanup at launch has nothing to drop.
        assert_eq!(
            download_channels(&store),
            ["d1 p1-vod-0", "d2 p1-movie-9", "d3 p1-vod-1"]
        );
        assert!(store.prune_redundant_downloads().unwrap().is_empty());
    }

    #[test]
    fn the_move_drops_omdb_details_it_cant_check() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    channel_at("p1-vod-0", "http://srv/movie/u/p/10.mkv", "movie"),
                    channel_at("p1-xt-0", "http://srv/live/u/p/stream", "live"),
                ],
            )
            .unwrap();
        for id in ["p1-vod-0", "p1-xt-0", "p1-xt-ep-5-s1-0"] {
            store.save_omdb_cache(id, &make_omdb_data(id)).unwrap();
        }

        store.migrate().unwrap();

        // A channel that keeps its id keeps its details, and so does an
        // episode, whose id doesn't change.
        assert_eq!(
            texts(&store, "SELECT channel_id FROM omdb_cache ORDER BY 1"),
            ["p1-xt-0", "p1-xt-ep-5-s1-0"]
        );
    }

    /// Saves three series under position ids. Position 0 held The Wire when
    /// its rows were saved, and Lost has taken that place since.
    fn save_series_that_moved_places(store: &CacheStore) {
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    named("Lost", channel_at("p1-ser-0", "xtream://series/6", "series")),
                    named("The Wire", channel_at("p1-ser-1", "xtream://series/5", "series")),
                    named("Dark", channel_at("p1-ser-2", "xtream://series/7", "series")),
                ],
            )
            .unwrap();
    }

    #[test]
    fn an_episode_download_follows_the_series_its_id_names() {
        let store = store_before_migrations();
        save_series_that_moved_places(&store);
        let wire = episode_record("p1-xt-ep-5-s1-0", "p1-ser-0", DownloadStatus::Completed);
        store.upsert_download(&wire).unwrap();
        // An id without a series in it has only its place to go by.
        let other = episode_record("p1-other-1", "p1-ser-2", DownloadStatus::Completed);
        store.upsert_download(&other).unwrap();

        store.migrate().unwrap();

        assert_eq!(
            texts(&store, "SELECT id || ' ' || series_channel_id FROM downloads ORDER BY id"),
            ["p1-other-1 p1-series-7", "p1-xt-ep-5-s1-0 p1-series-5"]
        );
    }

    #[test]
    fn a_saved_episode_list_follows_the_series_its_episodes_name() {
        let store = store_before_migrations();
        save_series_that_moved_places(&store);
        let wire = [channel_at("p1-xt-ep-5-s1-0", "http://srv/series/u/p/100.mkv", "series")];
        store.save_series_episodes("p1-ser-0", &wire).unwrap();
        // A list with no episodes has nothing to check, and only a download
        // saves it again, so it keeps its place.
        store.save_series_episodes("p1-ser-2", &[]).unwrap();

        store.migrate().unwrap();

        assert_eq!(
            texts(&store, "SELECT series_channel_id FROM series_episode_cache ORDER BY 1"),
            ["p1-series-5", "p1-series-7"]
        );
        assert_eq!(
            store.get_series_episodes("p1-series-5").unwrap()[0].id,
            "p1-xt-ep-5-s1-0"
        );
    }

    #[test]
    fn a_series_keeps_the_newest_episode_list_that_names_it() {
        let store = store_before_migrations();
        save_series_that_moved_places(&store);
        // Both lists name The Wire, under its old place and its later one.
        let old = [channel_at("p1-xt-ep-5-s1-0", "http://srv/series/u/p/100.mkv", "series")];
        store.save_series_episodes("p1-ser-0", &old).unwrap();
        let new = [
            channel_at("p1-xt-ep-5-s1-0", "http://srv/series/u/p/100.mkv", "series"),
            channel_at("p1-xt-ep-5-s1-1", "http://srv/series/u/p/101.mkv", "series"),
        ];
        store.save_series_episodes("p1-ser-1", &new).unwrap();
        store
            .conn
            .execute(
                "UPDATE series_episode_cache SET updated_at = CASE series_channel_id
                    WHEN 'p1-ser-0' THEN 100 ELSE 200 END",
                [],
            )
            .unwrap();

        store.migrate().unwrap();

        assert_eq!(store.get_series_episodes("p1-series-5").unwrap().len(), 2);
        assert_eq!(
            texts(&store, "SELECT series_channel_id FROM series_episode_cache ORDER BY 1"),
            ["p1-ser-0", "p1-series-5"]
        );
    }

    #[test]
    fn a_refresh_keeps_the_saved_channels_of_a_list_that_failed() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[
                    channel_at("p1-live-7", "http://srv/live/u/p/7.ts", "live"),
                    channel_at("p1-movie-9", "http://srv/movie/u/p/9.mp4", "movie"),
                    channel_at("p1-series-5", "xtream://series/5", "series"),
                ],
            )
            .unwrap();
        store.toggle_favorite("p1-movie-9").unwrap();
        store.toggle_favorite("p1-live-7").unwrap();

        // The movie and series lists didn't load, and the live list changed.
        let count = store
            .save_channels_keeping(
                "p1",
                &[
                    channel_at("p1-live-7", "http://srv/live/u/p/7.ts", "live"),
                    channel_at("p1-live-8", "http://srv/live/u/p/8.ts", "live"),
                ],
                &["movie", "series"],
            )
            .unwrap();

        assert_eq!(count, 4);
        assert_eq!(
            ids_and_favorites(&store, "p1"),
            owned(&[
                ("p1-live-7", true),
                ("p1-live-8", false),
                ("p1-movie-9", true),
                ("p1-series-5", false),
            ])
        );

        // Once the lists load again, the refresh replaces everything.
        let count = store
            .save_channels_keeping(
                "p1",
                &[channel_at(
                    "p1-movie-9",
                    "http://srv/movie/u/p/9.mp4",
                    "movie",
                )],
                &[],
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            ids_and_favorites(&store, "p1"),
            owned(&[("p1-movie-9", true)])
        );
    }

    // --- Removing a provider and clearing caches ---

    fn count(store: &CacheStore, sql: &str) -> i64 {
        store.conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn vod(id: &str, name: &str, content_type: &str) -> Channel {
        let mut ch = make_channel(id, name, "VOD");
        ch.content_type = content_type.into();
        ch
    }

    fn programme(channel_id: &str, provider_id: &str) -> StoredEpgProgram {
        StoredEpgProgram {
            channel_id: channel_id.into(),
            title: "News at six".into(),
            description: None,
            start_time: 0,
            end_time: 3600,
            category: None,
            provider_id: provider_id.into(),
            fetched_at: 0,
        }
    }

    /// Store a provider with a live channel, a movie, a series and one of its
    /// episodes, with something saved in every table that belongs to it.
    fn fill_provider(store: &CacheStore, id: &str, movie: &str) {
        store.upsert_provider(&make_provider(id, id)).unwrap();
        let live = format!("{id}-ch-0");
        let film = format!("{id}-ch-1");
        let series = format!("{id}-ch-2");
        let episode = format!("{id}-ep-9");
        store
            .save_channels(
                id,
                &[
                    make_channel(&live, "News", "News"),
                    vod(&film, movie, "movie"),
                    vod(&series, "Homeland", "series"),
                ],
            )
            .unwrap();
        store
            .record_play_start(&live, "News", None, "live")
            .unwrap();
        store
            .record_play_start(&film, movie, None, "movie")
            .unwrap();
        store
            .record_play_start(&episode, "Homeland S01E02", None, "series")
            .unwrap();
        store
            .save_omdb_cache(&film, &make_omdb_data(movie))
            .unwrap();
        store.save_epg_data(&live, "[]").unwrap();
        store
            .save_epg_programmes(id, &[programme(&live, id)])
            .unwrap();
        store
            .save_group_hierarchy(id, "live", "News", Some("Info"), 0, true)
            .unwrap();
        store.pin_group(id, "live", "News", 0).unwrap();
        store.save_series_episodes(&series, &[]).unwrap();
        store
            .save_playback_position(
                &playback_key(movie, "movie", None, None, None).unwrap(),
                600.0,
                7200.0,
            )
            .unwrap();
        store
            .save_playback_position("series:homeland:s1e2", 300.0, 3000.0)
            .unwrap();
    }

    #[test]
    fn remove_provider_deletes_everything_saved_for_it() {
        let store = CacheStore::open_in_memory().unwrap();
        fill_provider(&store, "m3u-a", "Heat");
        fill_provider(&store, "m3u-ab", "Ronin");

        store.remove_provider("m3u-a").unwrap();

        assert!(store.get_provider("m3u-a").unwrap().is_none());
        for (sql, left) in [
            ("SELECT COUNT(*) FROM channels", 3),
            ("SELECT COUNT(*) FROM watch_history", 3),
            ("SELECT COUNT(*) FROM omdb_cache", 1),
            ("SELECT COUNT(*) FROM epg_cache", 1),
            ("SELECT COUNT(*) FROM epg_programmes", 1),
            ("SELECT COUNT(*) FROM group_hierarchy", 1),
            ("SELECT COUNT(*) FROM pinned_groups", 1),
            ("SELECT COUNT(*) FROM series_episode_cache", 1),
        ] {
            assert_eq!(count(&store, sql), left, "{sql}");
        }
        // Every row left belongs to the other provider, whose id starts the same way.
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM watch_history WHERE channel_id LIKE 'm3u-ab-%'"
            ),
            3
        );
        assert!(store.get_playback_position("movie:heat").unwrap().is_none());
        assert!(store
            .get_playback_position("movie:ronin")
            .unwrap()
            .is_some());
        // Both providers had this episode, so its position stays.
        assert!(store
            .get_playback_position("series:homeland:s1e2")
            .unwrap()
            .is_some());

        store.remove_provider("m3u-ab").unwrap();
        assert!(store
            .get_playback_position("series:homeland:s1e2")
            .unwrap()
            .is_none());
        assert_eq!(count(&store, "SELECT COUNT(*) FROM playback_positions"), 0);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM watch_history"), 0);
    }

    #[test]
    fn remove_provider_keeps_downloads() {
        let store = CacheStore::open_in_memory().unwrap();
        fill_provider(&store, "m3u-a", "Heat");
        store
            .conn
            .execute(
                "INSERT INTO downloads (id, channel_id, title, kind, status, dest_path, created_at)
                 VALUES ('d1', 'm3u-a-ch-1', 'Heat', 'movie', 'completed', '/tmp/Heat.mp4', 0)",
                [],
            )
            .unwrap();

        store.remove_provider("m3u-a").unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM downloads"), 1);
    }

    #[test]
    fn clear_all_caches_keeps_providers_history_and_positions() {
        let store = CacheStore::open_in_memory().unwrap();
        fill_provider(&store, "m3u-a", "Heat");
        store.save_whatson_cache("tt0111161", &WhatsonData::default()).unwrap();
        store.save_skip_segments_cache("introdb:tt0111161:movie", &make_skip_times()).unwrap();

        store.clear_all_caches().unwrap();

        for table in [
            "omdb_cache",
            "mdblist_cache",
            "whatson_cache",
            "opensubtitles_search_cache",
            "skip_segments_cache",
            "epg_cache",
            "epg_programmes",
            "series_episode_cache",
        ] {
            assert_eq!(
                count(&store, &format!("SELECT COUNT(*) FROM {table}")),
                0,
                "{table}"
            );
        }
        assert_eq!(count(&store, "SELECT COUNT(*) FROM channels"), 3);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM watch_history"), 3);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM playback_positions"), 2);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pinned_groups"), 1);
    }

    #[test]
    fn playback_key_matches_the_frontend() {
        assert_eq!(playback_key("News", "live", None, None, None), None);
        assert_eq!(
            playback_key("  The   Dark Knight ", "movie", None, None, None).as_deref(),
            Some("movie:the dark knight")
        );
        assert_eq!(
            playback_key(
                "Homeland S01E02",
                "series",
                Some("Homeland".into()),
                Some(1),
                Some(2)
            )
            .as_deref(),
            Some("series:homeland:s1e2")
        );
        // History rows only keep the name, which is parsed as on load.
        assert_eq!(
            playback_key("Homeland S01E02", "series", None, None, None).as_deref(),
            Some("series:homeland:s1e2")
        );
        // A series row with no episode in its name is keyed by name.
        assert_eq!(
            playback_key("Homeland", "series", None, None, None).as_deref(),
            Some("series:homeland")
        );
    }

    #[test]
    fn a_stored_season_and_episode_win_over_the_name() {
        assert_eq!(
            playback_key("Pilot", "series", Some("Example Show".into()), Some(1), Some(1)).as_deref(),
            Some("series:example show:s1e1")
        );
        assert_eq!(
            playback_key("Example Show S09E09", "series", Some("Example Show".into()), Some(2), Some(5))
                .as_deref(),
            Some("series:example show:s2e5")
        );
    }

    // --- Opening the database ---

    #[test]
    fn open_creates_the_folder_and_keeps_data_between_launches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app data").join("cache.db");
        CacheStore::open(&path)
            .unwrap()
            .upsert_provider(&make_provider("p1", "Home"))
            .unwrap();

        let reopened = CacheStore::open(&path).unwrap();
        assert_eq!(reopened.get_provider("p1").unwrap().unwrap().name, "Home");
    }

    #[test]
    fn open_fails_on_a_file_that_is_not_a_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.db");
        std::fs::write(&path, "not a database\n".repeat(100)).unwrap();
        assert!(matches!(CacheStore::open(&path), Err(CacheError::Db(_))));
    }

    #[test]
    fn open_fails_when_the_folder_cannot_be_made() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("taken");
        std::fs::write(&file, "").unwrap();
        assert!(matches!(
            CacheStore::open(&file.join("cache.db")),
            Err(CacheError::Io(_))
        ));
    }

    #[test]
    fn opening_fails_when_any_table_cannot_be_created() {
        // An index that already has a table's name blocks that one table, so
        // each step of the setup gets its turn to fail.
        for table in [
            "providers",
            "epg_programmes",
            "watch_history",
            "omdb_cache",
            "group_hierarchy",
            "playback_positions",
            "pinned_groups",
            "downloads",
            "series_episode_cache",
        ] {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE clash (x); CREATE INDEX {table} ON clash (x);"
            ))
            .unwrap();
            let err = CacheStore { conn }.init_tables().unwrap_err();
            assert!(
                err.to_string()
                    .contains(&format!("already an index named {table}")),
                "{table}: {err}"
            );
        }
    }

    // --- Providers, channels and the guide ---

    /// Every field of a provider. `Provider` has no `PartialEq`, and its
    /// `Debug` hides the login.
    fn as_json(provider: &Provider) -> serde_json::Value {
        serde_json::to_value(provider).unwrap()
    }

    fn xtream_provider(id: &str) -> Provider {
        Provider {
            provider_type: ProviderType::Xtream,
            username: Some("user".into()),
            password: Some("pass".into()),
            last_updated: Some("2026-01-01T00:00:00Z".into()),
            channel_count: 12,
            epg_url: Some("http://epg.example.test/guide.xml".into()),
            ..make_provider(id, "Xtream")
        }
    }

    #[test]
    fn providers_read_back_every_field() {
        let store = CacheStore::open_in_memory().unwrap();
        let provider = xtream_provider("x1");
        let playlist = make_provider("m1", "Playlist");
        store.upsert_provider(&provider).unwrap();
        store.upsert_provider(&playlist).unwrap();

        assert_eq!(
            as_json(&store.get_provider("x1").unwrap().unwrap()),
            as_json(&provider)
        );
        assert_eq!(
            as_json(&store.get_provider("m1").unwrap().unwrap()),
            as_json(&playlist)
        );
        assert!(store.get_provider("missing").unwrap().is_none());
        let mut listed = store.get_providers().unwrap();
        listed.sort_by(|a, b| a.id.cmp(&b.id));
        let listed: Vec<_> = listed.iter().map(as_json).collect();
        assert_eq!(listed, [as_json(&playlist), as_json(&provider)]);
    }

    #[test]
    fn update_provider_credentials_changes_the_login_and_keeps_the_rest() {
        let store = CacheStore::open_in_memory().unwrap();
        let provider = xtream_provider("x1");
        store.upsert_provider(&provider).unwrap();
        store
            .save_channels("x1", &[make_channel("x1-ch-0", "News", "News")])
            .unwrap();
        store
            .upsert_provider(&make_provider("other", "Other"))
            .unwrap();

        store
            .update_provider_credentials(
                "x1",
                "Renamed",
                "http://new.example.test",
                Some("new user"),
                None,
            )
            .unwrap();

        let expected = Provider {
            name: "Renamed".into(),
            url: "http://new.example.test".into(),
            username: Some("new user".into()),
            password: None,
            ..provider
        };
        assert_eq!(
            as_json(&store.get_provider("x1").unwrap().unwrap()),
            as_json(&expected)
        );
        assert_eq!(store.get_channels("x1").unwrap().len(), 1);
        assert_eq!(store.get_provider("other").unwrap().unwrap().name, "Other");
    }

    #[test]
    fn set_provider_epg_url_sets_and_clears_the_guide_address() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "Test")).unwrap();
        let guide = Some("http://epg.example.test/guide.xml");

        store.set_provider_epg_url("p1", guide).unwrap();
        assert_eq!(
            store
                .get_provider("p1")
                .unwrap()
                .unwrap()
                .epg_url
                .as_deref(),
            guide
        );

        store.set_provider_epg_url("p1", None).unwrap();
        assert_eq!(store.get_provider("p1").unwrap().unwrap().epg_url, None);
    }

    #[test]
    fn a_channel_leads_to_the_provider_that_owns_it() {
        let store = CacheStore::open_in_memory().unwrap();
        for id in ["p1", "p2"] {
            store.upsert_provider(&make_provider(id, id)).unwrap();
            store
                .save_channels(id, &[make_channel(&format!("{id}-ch-0"), "News", "News")])
                .unwrap();
        }

        let owner = store.get_provider_for_channel("p2-ch-0").unwrap().unwrap();
        assert_eq!(as_json(&owner), as_json(&make_provider("p2", "p2")));
        assert!(store.get_provider_for_channel("p3-ch-0").unwrap().is_none());
        assert_eq!(
            store.get_channel_by_id("p2-ch-0").unwrap(),
            Some(make_channel("p2-ch-0", "News", "News"))
        );
        assert_eq!(store.get_channel_by_id("p3-ch-0").unwrap(), None);
    }

    #[test]
    fn toggling_a_channel_that_is_gone_is_an_error() {
        let store = CacheStore::open_in_memory().unwrap();
        assert!(matches!(
            store.toggle_favorite("missing"),
            Err(CacheError::Db(rusqlite::Error::QueryReturnedNoRows))
        ));
    }

    #[test]
    fn saved_series_fields_are_kept_and_never_guessed() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P")).unwrap();
        // The name says one episode and the fields another. The fields win.
        let numbered = Channel {
            series_title: Some("Homeland".into()),
            season: Some(2),
            episode: Some(3),
            ..vod("p1-ch-0", "Homeland S01E01", "series")
        };
        // No episode in the name, so there is nothing to fill in.
        let unnumbered = vod("p1-ch-1", "Homeland", "series");
        store
            .save_channels("p1", &[numbered.clone(), unnumbered.clone()])
            .unwrap();

        assert_eq!(store.get_channels("p1").unwrap(), [unnumbered, numbered]);
    }

    fn timed(channel_id: &str, title: &str, start_time: i64, end_time: i64) -> StoredEpgProgram {
        StoredEpgProgram {
            title: title.into(),
            start_time,
            end_time,
            ..programme(channel_id, "p1")
        }
    }

    #[test]
    fn the_guide_window_covers_every_channel_in_order() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .save_epg_programmes(
                "p1",
                &[
                    timed("cnn.us", "Late", 300, 400),
                    timed("bbc.uk", "Evening", 100, 200),
                    timed("cnn.us", "Early", 0, 150),
                    timed("bbc.uk", "Ended", 0, 100),
                    timed("bbc.uk", "Later", 400, 500),
                ],
            )
            .unwrap();

        let window: Vec<(String, String)> = store
            .get_epg_all_channels(100, 400)
            .unwrap()
            .into_iter()
            .map(|p| (p.channel_id, p.title))
            .collect();
        assert_eq!(
            window,
            [
                ("bbc.uk".to_string(), "Evening".to_string()),
                ("cnn.us".to_string(), "Early".to_string()),
                ("cnn.us".to_string(), "Late".to_string()),
            ]
        );
    }

    #[test]
    fn the_guide_window_can_cover_only_some_channels() {
        let store = CacheStore::open_in_memory().unwrap();
        let quoted = "Ñews \"24\".es";
        store
            .save_epg_programmes(
                "p1",
                &[
                    timed("cnn.us", "Late", 300, 400),
                    timed("bbc.uk", "Evening", 100, 200),
                    timed("cnn.us", "Early", 0, 150),
                    timed("itv.uk", "Quiz", 100, 200),
                    timed(quoted, "Headlines", 200, 300),
                    timed("bbc.uk", "Later", 400, 500),
                ],
            )
            .unwrap();
        let window = |ids: &[&str]| -> Vec<(String, String)> {
            let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
            store
                .get_epg_for_channels(&ids, 100, 400)
                .unwrap()
                .into_iter()
                .map(|p| (p.channel_id, p.title))
                .collect()
        };

        assert_eq!(
            window(&["cnn.us", "bbc.uk"]),
            [
                ("bbc.uk".to_string(), "Evening".to_string()),
                ("cnn.us".to_string(), "Early".to_string()),
                ("cnn.us".to_string(), "Late".to_string()),
            ]
        );
        // Any character can be part of a guide id.
        assert_eq!(
            window(&[quoted]),
            [(quoted.to_string(), "Headlines".to_string())]
        );
        // An id without programmes, or no id at all, finds nothing.
        assert!(window(&["abc.au"]).is_empty());
        assert!(window(&[]).is_empty());
    }

    #[test]
    fn guide_search_finds_the_next_match_on_each_channel() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_provider(&make_provider("p1", "P")).unwrap();
        let mut bbc = make_channel("p1-ch-0", "BBC One", "UK");
        bbc.tvg_id = Some("bbc.uk".into());
        bbc.logo_url = Some("http://img.example.test/bbc.png".into());
        store.save_channels("p1", &[bbc]).unwrap();
        let mut world = timed("cnn.us", "World Report", 250, 300);
        world.description = Some("All the NEWS from abroad".into());
        store
            .save_epg_programmes(
                "p1",
                &[
                    timed("bbc.uk", "Old News", 0, 100),
                    timed("bbc.uk", "Late News", 300, 400),
                    timed("bbc.uk", "Evening News", 100, 200),
                    world,
                    timed("cnn.us", "Cooking", 120, 180),
                    timed("sky.uk", "News at Ten", 0, 120),
                ],
            )
            .unwrap();

        let found = store.search_epg_programmes("news", 150).unwrap();
        let summary: Vec<(&str, &str, &str, Option<&str>)> = found
            .iter()
            .map(|p| {
                (
                    p.channel_id.as_str(),
                    p.title.as_str(),
                    p.channel_name.as_str(),
                    p.channel_logo.as_deref(),
                )
            })
            .collect();
        // A channel with no match in the list is named by its guide id.
        assert_eq!(
            summary,
            [
                (
                    "bbc.uk",
                    "Evening News",
                    "BBC One",
                    Some("http://img.example.test/bbc.png")
                ),
                ("cnn.us", "World Report", "cnn.us", None),
            ]
        );
    }

    // --- Group layout and downloads ---

    fn layout(
        store: &CacheStore,
        provider_id: &str,
        content_type: &str,
    ) -> Vec<(String, Option<String>, i64)> {
        store
            .get_group_hierarchy(provider_id, content_type)
            .unwrap()
            .into_iter()
            .map(|e| (e.group_name, e.super_category, e.sort_order))
            .collect()
    }

    fn group(
        name: &str,
        super_category: Option<&str>,
        sort_order: i64,
    ) -> (String, Option<String>, i64) {
        (name.into(), super_category.map(Into::into), sort_order)
    }

    #[test]
    fn group_changes_only_touch_the_named_provider_and_type() {
        let store = CacheStore::open_in_memory().unwrap();
        for (provider, content_type) in [("p1", "live"), ("p1", "movie"), ("p2", "live")] {
            store
                .save_group_hierarchy(provider, content_type, "Sports", Some("US"), 0, false)
                .unwrap();
            store
                .save_group_hierarchy(provider, content_type, "News", Some("US"), 100, false)
                .unwrap();
        }
        store
            .save_group_hierarchy("p1", "movie", "Kids", Some("Family"), 200, false)
            .unwrap();

        store
            .update_group_sort_order("p1", "live", "News", -1)
            .unwrap();
        store
            .rename_super_category("p1", "live", "US", "America")
            .unwrap();
        store.delete_super_category("p1", "movie", "US").unwrap();

        assert_eq!(
            layout(&store, "p1", "live"),
            [
                group("News", Some("America"), -1),
                group("Sports", Some("America"), 0)
            ]
        );
        assert_eq!(
            layout(&store, "p1", "movie"),
            [
                group("Sports", None, 0),
                group("News", None, 100),
                group("Kids", Some("Family"), 200)
            ]
        );
        assert_eq!(
            layout(&store, "p2", "live"),
            [
                group("Sports", Some("US"), 0),
                group("News", Some("US"), 100)
            ]
        );
    }

    #[test]
    fn replacing_the_layout_drops_overrides_for_groups_that_are_gone() {
        let store = CacheStore::open_in_memory().unwrap();
        store
            .save_group_hierarchy("p1", "live", "Old", Some("Mine"), 0, true)
            .unwrap();
        store
            .replace_group_hierarchy("p1", "live", &[("Sports", Some("US"), 0)])
            .unwrap();
        assert_eq!(
            layout(&store, "p1", "live"),
            [group("Sports", Some("US"), 0)]
        );
    }

    #[test]
    fn deleting_a_download_leaves_the_others() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_download(&movie_record("d1", "c1")).unwrap();
        store.upsert_download(&movie_record("d2", "c2")).unwrap();

        store.delete_download("d1").unwrap();
        store.delete_download("missing").unwrap();

        let ids: Vec<String> = store
            .list_downloads()
            .unwrap()
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, ["d2"]);
    }

    #[test]
    fn finds_the_completed_download_of_a_channel() {
        let store = CacheStore::open_in_memory().unwrap();
        let done = DownloadRecord {
            status: DownloadStatus::Completed,
            finished_at: Some(200),
            ..movie_record("d1", "c1")
        };
        store.upsert_download(&movie_record("d0", "c1")).unwrap();
        store.upsert_download(&done).unwrap();
        store.upsert_download(&movie_record("d2", "c2")).unwrap();

        assert_eq!(
            store.completed_download_for_channel("c1").unwrap(),
            Some(done)
        );
        assert_eq!(store.completed_download_for_channel("c2").unwrap(), None);
    }

    // --- Failures ---

    /// The names of the store's own tables.
    fn table_names(store: &CacheStore) -> Vec<String> {
        let mut stmt = store
            .conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .collect::<SqlResult<_>>()
            .unwrap()
    }

    /// Every row of every table, to check that a failed write changed nothing.
    fn snapshot(store: &CacheStore) -> Vec<String> {
        let mut rows = Vec::new();
        for table in table_names(store) {
            let mut stmt = store
                .conn
                .prepare(&format!("SELECT * FROM {table}"))
                .unwrap();
            let columns = stmt.column_count();
            let mut query = stmt.query([]).unwrap();
            while let Some(row) = query.next().unwrap() {
                let values: Vec<String> = (0..columns)
                    .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                    .collect();
                rows.push(format!("{table}: {}", values.join(", ")));
            }
        }
        rows.sort();
        rows
    }

    /// Makes every INSERT, UPDATE or DELETE, whichever `event` names, on
    /// `table` fail, the way a full disk fails a write partway through.
    fn fail_on(store: &CacheStore, event: &str, table: &str) {
        store
            .conn
            .execute_batch(&format!(
                "CREATE TRIGGER fail_{event}_{table} BEFORE {event} ON {table}
                 BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
            ))
            .unwrap();
    }

    /// Asserts that each call failed with a database error, naming the call
    /// that didn't.
    macro_rules! assert_db_errors {
        ($($call:expr),+ $(,)?) => {$(
            let result = $call.map(drop);
            assert!(
                matches!(result, Err(CacheError::Db(_))),
                "{}: {result:?}",
                stringify!($call)
            );
        )+};
    }

    #[test]
    fn a_refresh_that_fails_partway_keeps_the_old_channels() {
        let store = CacheStore::open_in_memory().unwrap();
        fill_provider(&store, "p1", "Heat");
        store.toggle_favorite("p1-ch-0").unwrap();
        let before = snapshot(&store);
        fail_on(&store, "INSERT", "channels");
        let new = make_channel("p1-ch-5", "New", "News");

        assert_db_errors!(
            store.save_channels("p1", std::slice::from_ref(&new)),
            store.upsert_channel("p1", &new),
        );
        assert_eq!(snapshot(&store), before);

        // The failed refresh ended its transaction, so the next one can run.
        store
            .conn
            .execute_batch("DROP TRIGGER fail_INSERT_channels")
            .unwrap();
        store.save_channels("p1", &[new]).unwrap();
        assert_eq!(store.get_channels("p1").unwrap().len(), 1);
    }

    #[test]
    fn a_move_that_fails_partway_changes_nothing_and_runs_again() {
        let store = store_before_migrations();
        store.upsert_provider(&xtream_provider("p1")).unwrap();
        store
            .save_channels(
                "p1",
                &[named("Seven", channel_at("p1-xt-0", "http://srv/live/u/p/7.ts", "live"))],
            )
            .unwrap();
        store
            .record_play_start("p1-xt-0", "Seven", None, "live")
            .unwrap();
        let before = snapshot(&store);
        // The channels have moved by the time the history fails, so the
        // rollback has something to undo.
        fail_on(&store, "UPDATE", "watch_history");

        assert_db_errors!(store.migrate());
        assert_eq!(snapshot(&store), before);
        assert_eq!(user_version(&store), 0);

        store
            .conn
            .execute_batch("DROP TRIGGER fail_UPDATE_watch_history")
            .unwrap();
        store.migrate().unwrap();
        assert_eq!(
            ids_and_favorites(&store, "p1"),
            owned(&[("p1-live-7", false)])
        );
        assert_eq!(
            store.get_watch_history(10).unwrap()[0].channel_id,
            "p1-live-7"
        );
        assert_eq!(user_version(&store), MIGRATIONS.len());
    }

    #[test]
    fn a_guide_refresh_that_fails_partway_keeps_the_old_guide() {
        let store = CacheStore::open_in_memory().unwrap();
        fill_provider(&store, "p1", "Heat");
        let before = snapshot(&store);
        fail_on(&store, "INSERT", "epg_programmes");

        assert_db_errors!(store.save_epg_programmes("p1", &[timed("bbc.uk", "New", 0, 100)]));
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn removing_a_provider_that_fails_partway_removes_nothing() {
        let store = CacheStore::open_in_memory().unwrap();
        fill_provider(&store, "m3u-a", "Heat");
        let before = snapshot(&store);
        // Positions, history and metadata are deleted before the guide.
        fail_on(&store, "DELETE", "epg_programmes");

        assert_db_errors!(store.remove_provider("m3u-a"));
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn writes_to_a_read_only_database_fail_and_change_nothing() {
        let store = CacheStore::open_in_memory().unwrap();
        fill_provider(&store, "p1", "Heat");
        store
            .upsert_provider(&make_provider("empty", "Empty"))
            .unwrap();
        store.upsert_download(&movie_record("d1", "c1")).unwrap();
        // An older attempt at the same channel, for pruning to remove.
        let older = DownloadRecord {
            created_at: 50,
            ..movie_record("d0", "c1")
        };
        store.upsert_download(&older).unwrap();
        let before = snapshot(&store);
        store.conn.execute_batch("PRAGMA query_only = 1").unwrap();

        assert_db_errors!(
            store.upsert_provider(&make_provider("p2", "Other")),
            store.update_provider_credentials("p1", "New", "http://new.example.test", None, None),
            store.set_provider_epg_url("p1", None),
            store.remove_provider("p1"),
            // A provider with nothing saved fails on its own row.
            store.remove_provider("empty"),
            store.save_channels("p1", &[]),
            store.save_channels_keeping("p1", &[], &["movie"]),
            store.toggle_favorite("p1-ch-0"),
            store.upsert_channel("p1", &make_channel("p1-ch-9", "New", "News")),
            store.save_epg_data("p1-ch-0", "[]"),
            store.save_epg_programmes("p1", &[]),
            store.save_omdb_cache("p1-ch-1", &make_omdb_data("Heat")),
            store.record_play_start("p1-ch-0", "News", None, "live"),
            store.record_play_end("p1-ch-0", 60),
            store.delete_history_entry("p1-ch-0"),
            store.delete_history_series("Homeland"),
            store.clear_watch_history_of_type("live"),
            store.clear_watch_history(),
            store.save_playback_position("movie:heat", 1.0, 2.0),
            store.delete_playback_position("movie:heat"),
            store.clear_all_caches(),
            store.update_group_sort_order("p1", "live", "News", 5),
            store.save_group_hierarchy("p1", "live", "News", None, 5, false),
            store.replace_group_hierarchy("p1", "live", &[]),
            store.rename_super_category("p1", "live", "Info", "News"),
            store.delete_super_category("p1", "live", "Info"),
            store.pin_group("p1", "live", "Sports", 1),
            store.unpin_group("p1", "live", "News"),
            store.upsert_download(&movie_record("d2", "c2")),
            store.set_download_keep("d1", true),
            store.mark_download_played("d1", 500),
            store.delete_download("d1"),
            store.delete_downloads(&["d1".to_string()]),
            store.delete_terminal_downloads_for_channel("c1"),
            store.prune_redundant_downloads(),
            store.requeue_interrupted_downloads(),
            store.save_series_episodes("p1-ch-2", &[]),
        );

        store.conn.execute_batch("PRAGMA query_only = 0").unwrap();
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn reads_from_a_damaged_database_are_errors_not_empty_results() {
        // An empty answer here would look as if the user's data were gone.
        let store = CacheStore::open_in_memory().unwrap();
        for table in table_names(&store) {
            store
                .conn
                .execute_batch(&format!("DROP TABLE {table}"))
                .unwrap();
        }

        assert_db_errors!(
            store.get_providers(),
            store.get_provider("p1"),
            store.get_provider_for_channel("p1-ch-0"),
            store.remove_provider("p1"),
            store.save_channels("p1", &[]),
            store.save_channels_keeping("p1", &[], &["movie"]),
            store.get_channels("p1"),
            store.get_all_channels(),
            store.get_channel_by_id("p1-ch-0"),
            store.toggle_favorite("p1-ch-0"),
            store.get_epg_data("p1-ch-0"),
            store.get_epg_programmes("bbc.uk", 0, 100),
            store.get_epg_all_channels(0, 100),
            store.get_epg_for_channels(&["bbc.uk".to_string()], 0, 100),
            store.search_epg_programmes("news", 0),
            store.get_omdb_cache("p1-ch-1", 3600),
            store.get_watch_history(10),
            store.delete_history_series("Homeland"),
            store.get_playback_position("movie:heat"),
            store.get_group_hierarchy("p1", "live"),
            store.replace_group_hierarchy("p1", "live", &[]),
            store.get_pinned_groups("p1", "live"),
            store.get_download("d1"),
            store.list_downloads(),
            store.list_download_paths(),
            store.delete_downloads(&["d1".to_string()]),
            store.prune_redundant_downloads(),
            store.list_downloads_for_series("s1"),
            store.list_active_downloads(),
            store.completed_download_for_channel("c1"),
            store.get_series_episodes("p1-ch-2"),
        );
    }
}
