// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::downloads::model::{DownloadKind, DownloadRecord, DownloadStatus};
use crate::iptv::m3u::parse_series_name;
use crate::iptv::mdblist::MdbListData;
use crate::iptv::omdb::OmdbData;
use crate::iptv::opensubtitles::SubtitleSearchResult;
use crate::iptv::whatson::WhatsonData;
use crate::models::channel::Channel;
use crate::models::playlist::{Provider, ProviderType};
use rusqlite::{params, Connection, Result as SqlResult};
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

/// Last known playback position for a piece of VOD content (movie or episode),
/// keyed by a frontend-derived content key so it survives provider refreshes
/// (channel IDs are index-based) and source switches.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPosition {
    pub content_key: String,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub updated_at: i64,
}

pub struct CacheStore {
    conn: Connection,
}

impl CacheStore {
    pub fn open(db_path: &Path) -> Result<Self, CacheError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        let store = Self { conn };
        store.init_tables()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, CacheError> {
        let conn = Connection::open_in_memory()?;
        let store = Self { conn };
        store.init_tables()?;
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
            "CREATE TABLE IF NOT EXISTS omdb_cache (
                channel_id  TEXT PRIMARY KEY,
                data_json   TEXT NOT NULL,
                fetched_at  INTEGER NOT NULL
            );"
        )?;
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mdblist_cache (
                imdb_id     TEXT PRIMARY KEY,
                data_json   TEXT NOT NULL,
                fetched_at  INTEGER NOT NULL
            );"
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
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS opensubtitles_search_cache (
                cache_key   TEXT PRIMARY KEY,
                data_json   TEXT NOT NULL,
                fetched_at  INTEGER NOT NULL
            );"
        )?;
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS whatson_cache (
                imdb_id     TEXT PRIMARY KEY,
                data_json   TEXT NOT NULL,
                fetched_at  INTEGER NOT NULL
            );"
        )?;
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
                finished_at        INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_downloads_channel ON downloads(channel_id);
            CREATE INDEX IF NOT EXISTS idx_downloads_series ON downloads(series_channel_id);
            CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);",
        )?;
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

    pub fn remove_provider(&self, id: &str) -> Result<(), CacheError> {
        self.conn.execute("DELETE FROM channels WHERE provider_id = ?1", params![id])?;
        self.conn.execute("DELETE FROM providers WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Channels ---

    pub fn save_channels(&self, provider_id: &str, channels: &[Channel]) -> Result<(), CacheError> {
        self.conn.execute_batch("BEGIN")?;

        if let Err(e) = self.save_channels_inner(provider_id, channels) {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(e);
        }

        self.conn.execute_batch("COMMIT")?;
        Ok(())
    }

    fn save_channels_inner(&self, provider_id: &str, channels: &[Channel]) -> Result<(), CacheError> {
        // Preserve favorites: collect IDs that were favorited before the wipe.
        let mut fav_stmt = self.conn.prepare(
            "SELECT id FROM channels WHERE provider_id = ?1 AND is_favorite = 1",
        )?;
        let favorites: std::collections::HashSet<String> = fav_stmt
            .query_map(params![provider_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        self.conn.execute("DELETE FROM channels WHERE provider_id = ?1", params![provider_id])?;

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
        Ok(())
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
        let rows = stmt.query_map(params![channel_id, range_start, range_end], |row| {
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
        })?;
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
        let rows = stmt.query_map(params![range_start, range_end], |row| {
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
        })?;
        rows.collect::<SqlResult<Vec<_>>>().map_err(CacheError::Db)
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

    // --- OMDB Cache ---

    /// Store OMDB data for a channel. Overwrites any existing cached entry.
    pub fn save_omdb_cache(&self, channel_id: &str, data: &OmdbData) -> Result<(), CacheError> {
        let data_json = serde_json::to_string(data)?;
        let now = chrono::Utc::now().timestamp();
        self.conn.execute(
            "INSERT OR REPLACE INTO omdb_cache (channel_id, data_json, fetched_at) VALUES (?1, ?2, ?3)",
            params![channel_id, data_json, now],
        )?;
        Ok(())
    }

    /// Retrieve cached OMDB data for a channel. Returns `None` if not cached or if the
    /// cached entry is older than `ttl_seconds`.
    pub fn get_omdb_cache(&self, channel_id: &str, ttl_seconds: i64) -> Result<Option<OmdbData>, CacheError> {
        let result = self.conn.query_row(
            "SELECT data_json, fetched_at FROM omdb_cache WHERE channel_id = ?1",
            params![channel_id],
            |row| {
                let data_json: String = row.get(0)?;
                let fetched_at: i64 = row.get(1)?;
                Ok((data_json, fetched_at))
            },
        );
        match result {
            Ok((data_json, fetched_at)) => {
                let now = chrono::Utc::now().timestamp();
                if now - fetched_at > ttl_seconds {
                    return Ok(None); // stale
                }
                let data: OmdbData = serde_json::from_str(&data_json)?;
                Ok(Some(data))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
    }

    // --- MDBList Cache ---

    /// Store MDBList data for an IMDB ID. Overwrites any existing cached entry.
    pub fn save_mdblist_cache(&self, imdb_id: &str, data: &MdbListData) -> Result<(), CacheError> {
        let data_json = serde_json::to_string(data)?;
        let now = chrono::Utc::now().timestamp();
        self.conn.execute(
            "INSERT OR REPLACE INTO mdblist_cache (imdb_id, data_json, fetched_at) VALUES (?1, ?2, ?3)",
            params![imdb_id, data_json, now],
        )?;
        Ok(())
    }

    /// Retrieve cached MDBList data for an IMDB ID. Returns `None` if not cached or stale.
    pub fn get_mdblist_cache(&self, imdb_id: &str, ttl_seconds: i64) -> Result<Option<MdbListData>, CacheError> {
        let result = self.conn.query_row(
            "SELECT data_json, fetched_at FROM mdblist_cache WHERE imdb_id = ?1",
            params![imdb_id],
            |row| {
                let data_json: String = row.get(0)?;
                let fetched_at: i64 = row.get(1)?;
                Ok((data_json, fetched_at))
            },
        );
        match result {
            Ok((data_json, fetched_at)) => {
                let now = chrono::Utc::now().timestamp();
                if now - fetched_at > ttl_seconds {
                    return Ok(None); // stale
                }
                let data: MdbListData = serde_json::from_str(&data_json)?;
                Ok(Some(data))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
    }

    // --- Whatson Cache ---

    /// Store whatson-api data for an IMDB ID. Overwrites any existing cached entry.
    pub fn save_whatson_cache(&self, imdb_id: &str, data: &WhatsonData) -> Result<(), CacheError> {
        let data_json = serde_json::to_string(data)?;
        let now = chrono::Utc::now().timestamp();
        self.conn.execute(
            "INSERT OR REPLACE INTO whatson_cache (imdb_id, data_json, fetched_at) VALUES (?1, ?2, ?3)",
            params![imdb_id, data_json, now],
        )?;
        Ok(())
    }

    /// Retrieve cached whatson-api data for an IMDB ID. Returns `None` if not cached or stale.
    pub fn get_whatson_cache(&self, imdb_id: &str, ttl_seconds: i64) -> Result<Option<WhatsonData>, CacheError> {
        let result = self.conn.query_row(
            "SELECT data_json, fetched_at FROM whatson_cache WHERE imdb_id = ?1",
            params![imdb_id],
            |row| {
                let data_json: String = row.get(0)?;
                let fetched_at: i64 = row.get(1)?;
                Ok((data_json, fetched_at))
            },
        );
        match result {
            Ok((data_json, fetched_at)) => {
                let now = chrono::Utc::now().timestamp();
                if now - fetched_at > ttl_seconds {
                    return Ok(None); // stale
                }
                let data: WhatsonData = serde_json::from_str(&data_json)?;
                Ok(Some(data))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
    }

    // --- OpenSubtitles Search Cache ---

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
        let key = Self::opensubtitles_cache_key(imdb_id, season, episode);
        let data_json = serde_json::to_string(data)?;
        let now = chrono::Utc::now().timestamp();
        self.conn.execute(
            "INSERT OR REPLACE INTO opensubtitles_search_cache (cache_key, data_json, fetched_at) VALUES (?1, ?2, ?3)",
            params![key, data_json, now],
        )?;
        Ok(())
    }

    /// Retrieve cached OpenSubtitles search results. Returns `None` if not cached or stale.
    pub fn get_opensubtitles_search_cache(
        &self,
        imdb_id: &str,
        season: Option<u32>,
        episode: Option<u32>,
        ttl_seconds: i64,
    ) -> Result<Option<SubtitleSearchResult>, CacheError> {
        let key = Self::opensubtitles_cache_key(imdb_id, season, episode);
        let result = self.conn.query_row(
            "SELECT data_json, fetched_at FROM opensubtitles_search_cache WHERE cache_key = ?1",
            params![key],
            |row| {
                let data_json: String = row.get(0)?;
                let fetched_at: i64 = row.get(1)?;
                Ok((data_json, fetched_at))
            },
        );
        match result {
            Ok((data_json, fetched_at)) => {
                let now = chrono::Utc::now().timestamp();
                if now - fetched_at > ttl_seconds {
                    return Ok(None); // stale
                }
                let data: SubtitleSearchResult = serde_json::from_str(&data_json)?;
                Ok(Some(data))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CacheError::Db(e)),
        }
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
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.execute(
            "INSERT INTO playback_positions (content_key, position_seconds, duration_seconds, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(content_key) DO UPDATE SET
                position_seconds = excluded.position_seconds,
                duration_seconds = excluded.duration_seconds,
                updated_at       = excluded.updated_at",
            params![content_key, position_seconds, duration_seconds, now],
        )?;
        Ok(())
    }

    pub fn get_playback_position(
        &self,
        content_key: &str,
    ) -> Result<Option<PlaybackPosition>, CacheError> {
        let result = self.conn.query_row(
            "SELECT content_key, position_seconds, duration_seconds, updated_at
             FROM playback_positions WHERE content_key = ?1",
            params![content_key],
            |row| {
                Ok(PlaybackPosition {
                    content_key: row.get(0)?,
                    position_seconds: row.get(1)?,
                    duration_seconds: row.get(2)?,
                    updated_at: row.get(3)?,
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

    pub fn clear_all_caches(&self) -> Result<(), CacheError> {
        self.conn.execute("DELETE FROM omdb_cache", [])?;
        self.conn.execute("DELETE FROM mdblist_cache", [])?;
        self.conn.execute("DELETE FROM opensubtitles_search_cache", [])?;
        self.conn.execute("DELETE FROM whatson_cache", [])?;
        self.conn.execute("DELETE FROM epg_programmes", [])?;
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

    pub fn upsert_download(&self, rec: &DownloadRecord) -> Result<(), CacheError> {
        let kind = match rec.kind {
            DownloadKind::Movie => "movie",
            DownloadKind::Episode => "episode",
        };
        self.conn.execute(
            "INSERT INTO downloads
                (id, channel_id, title, kind, series_channel_id, status, dest_path,
                 total_bytes, downloaded_bytes, avg_rate_bps, error, created_at, finished_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
             ON CONFLICT(id) DO UPDATE SET
                status=excluded.status,
                dest_path=excluded.dest_path,
                total_bytes=excluded.total_bytes,
                downloaded_bytes=excluded.downloaded_bytes,
                avg_rate_bps=excluded.avg_rate_bps,
                error=excluded.error,
                finished_at=excluded.finished_at",
            params![
                rec.id, rec.channel_id, rec.title, kind, rec.series_channel_id,
                rec.status.as_str(), rec.dest_path, rec.total_bytes, rec.downloaded_bytes,
                rec.avg_rate_bps, rec.error, rec.created_at, rec.finished_at,
            ],
        )?;
        Ok(())
    }

    // Column order in SELECT * matches CREATE TABLE:
    // 0=id, 1=channel_id, 2=title, 3=kind, 4=series_channel_id, 5=status,
    // 6=dest_path, 7=total_bytes, 8=downloaded_bytes, 9=avg_rate_bps,
    // 10=error, 11=created_at, 12=finished_at
    fn row_to_download(row: &rusqlite::Row) -> SqlResult<DownloadRecord> {
        let kind_str: String = row.get(3)?;
        let status_str: String = row.get(5)?;
        Ok(DownloadRecord {
            id: row.get(0)?,
            channel_id: row.get(1)?,
            title: row.get(2)?,
            kind: if kind_str == "episode" {
                DownloadKind::Episode
            } else {
                DownloadKind::Movie
            },
            series_channel_id: row.get(4)?,
            status: DownloadStatus::from_str(&status_str).unwrap_or(DownloadStatus::Failed),
            dest_path: row.get(6)?,
            total_bytes: row.get(7)?,
            downloaded_bytes: row.get(8)?,
            avg_rate_bps: row.get(9)?,
            error: row.get(10)?,
            created_at: row.get(11)?,
            finished_at: row.get(12)?,
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

    pub fn delete_download(&self, id: &str) -> Result<(), CacheError> {
        self.conn
            .execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
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

/// For series channels loaded from an older cache that has NULL series_title/season/episode,
/// re-parse the channel name in memory so the frontend always gets enriched metadata.
/// Does not modify the database — the next playlist refresh will persist the correct values.
fn enrich_stale_series(channels: &mut Vec<Channel>) {
    for ch in channels.iter_mut() {
        if ch.content_type != "series" {
            continue;
        }
        if ch.series_title.is_none() || ch.season.is_none() || ch.episode.is_none() {
            if let Some((title, season, episode)) = parse_series_name(&ch.name) {
                ch.series_title = Some(title);
                ch.season = Some(season);
                ch.episode = Some(episode);
            }
        }
    }
}

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
        store.save_epg_programmes("p1", &[prog.clone()]).unwrap();
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
    fn test_xtream_provider_roundtrip() {
        let store = CacheStore::open_in_memory().unwrap();
        let provider = Provider {
            id: "x1".into(),
            name: "Xtream Test".into(),
            provider_type: ProviderType::Xtream,
            url: "http://xtream.example.com".into(),
            username: Some("user".into()),
            password: Some("pass".into()),
            last_updated: Some("2026-01-01".into()),
            channel_count: 500,
            epg_url: None,
        };
        store.upsert_provider(&provider).unwrap();
        let loaded = store.get_providers().unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(matches!(loaded[0].provider_type, ProviderType::Xtream));
        assert_eq!(loaded[0].username.as_deref(), Some("user"));
        assert_eq!(loaded[0].password.as_deref(), Some("pass"));
        assert_eq!(loaded[0].channel_count, 500);
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
        }
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
    fn list_downloads_returns_all() {
        let store = CacheStore::open_in_memory().unwrap();
        store.upsert_download(&movie_record("d1", "c1")).unwrap();
        store.upsert_download(&movie_record("d2", "c2")).unwrap();
        let all = store.list_downloads().unwrap();
        assert_eq!(all.len(), 2);
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
}
