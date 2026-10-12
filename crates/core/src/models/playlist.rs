// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use serde::{Deserialize, Serialize};

use super::channel::{Category, Channel};
use crate::downloads::redact::redact_credentials;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: ProviderType,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub last_updated: Option<String>,
    pub channel_count: usize,
    pub epg_url: Option<String>,
}

/// Leaves the login out, so a `{:?}` in a log line or an error can't print it.
/// A login that is set shows as `Some("***")`, and the addresses go through
/// [`redact_credentials`], since an M3U address or an EPG address often carries
/// the login as well.
impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let hidden = |login: &Option<String>| login.as_ref().map(|_| "***");
        f.debug_struct("Provider")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("provider_type", &self.provider_type)
            .field("url", &redact_credentials(&self.url))
            .field("username", &hidden(&self.username))
            .field("password", &hidden(&self.password))
            .field("last_updated", &self.last_updated)
            .field("channel_count", &self.channel_count)
            .field("epg_url", &self.epg_url.as_deref().map(redact_credentials))
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    M3u,
    Xtream,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub provider: Provider,
    pub channels: Vec<Channel>,
    pub categories: Vec<Category>,
}

impl Playlist {
    pub fn new(provider: Provider, channels: Vec<Channel>) -> Self {
        let categories = Category::from_channels(&channels);
        Self {
            provider,
            channels,
            categories,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_hides_the_login() {
        let provider = Provider {
            id: "p1".into(),
            name: "Home".into(),
            provider_type: ProviderType::Xtream,
            url: "http://srv:8080".into(),
            username: Some("user1".into()),
            password: Some("s3cret".into()),
            last_updated: None,
            channel_count: 3,
            epg_url: Some("http://srv:8080/xmltv.php?username=user1&password=s3cret".into()),
        };
        let printed = format!("{provider:?}");
        assert!(printed.contains("http://srv:8080"));
        assert!(printed.contains(r#"username: Some("***")"#));
        assert!(!printed.contains("user1"));
        assert!(!printed.contains("s3cret"));

        let m3u = Provider {
            provider_type: ProviderType::M3u,
            url: "http://srv:8080/get.php?username=user1&password=s3cret&type=m3u_plus".into(),
            username: None,
            password: None,
            epg_url: None,
            ..provider
        };
        let printed = format!("{m3u:?}");
        assert!(printed.contains("password: None"));
        assert!(printed.contains("get.php?username=***&password=***&type=m3u_plus"));
        assert!(!printed.contains("user1"));
        assert!(!printed.contains("s3cret"));
    }
}
