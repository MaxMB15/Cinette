// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Providers, channels, the guide, watch history and channel groups.

use super::*;
use mvp_core::http::test_server::{self, route};

/// 12:00 UTC on 4 March 2026, when the first program in [`GUIDE`] starts.
const NOON: i64 = 1_772_625_600;
const HOUR: i64 = 3600;

/// Two programs on `news.test` and one on `film.test`, from noon to 15:00.
const GUIDE: &str = r#"<tv>
<programme start="20260304120000 +0000" stop="20260304130000 +0000" channel="news.test"><title>Noon News</title><desc>The day so far</desc><category>News</category></programme>
<programme start="20260304130000 +0000" stop="20260304140000 +0000" channel="news.test"><title>Weather</title></programme>
<programme start="20260304140000 +0000" stop="20260304150000 +0000" channel="film.test"><title>Evening News Film</title></programme>
</tv>"#;

/// What many Xtream panels send when they have no guide.
const GUIDE_WITHOUT_PROGRAMS: &str =
    r#"<tv><channel id="news.test"><display-name>News</display-name></channel></tv>"#;

const LOGIN_ACCEPTED: &str = r#"{"user_info":{"auth":1,"status":"Active"}}"#;
const LOGIN_REFUSED: &str = r#"{"user_info":{"auth":0,"status":"Banned"}}"#;

/// A playlist with one live channel per name, all in the News group, and a
/// guide address in the header when `guide` is given.
fn playlist(guide: Option<&str>, names: &[&str]) -> String {
    let mut text = match guide {
        Some(url) => format!("#EXTM3U x-tvg-url=\"{url}\"\n"),
        None => "#EXTM3U\n".to_string(),
    };
    for (i, name) in names.iter().enumerate() {
        text.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"{name}.test\" group-title=\"News\",{name}\nhttp://example.test/live/{i}.ts\n"
        ));
    }
    text
}

/// An Xtream panel that takes any login, with one live channel and one series
/// of two episodes. It has no movies, so those requests get a 404.
fn xtream_panel() -> (String, std::sync::mpsc::Receiver<String>) {
    test_server::serve_routes(vec![
        route("action= ", "200 OK", LOGIN_ACCEPTED),
        route(
            "action=get_live_streams",
            "200 OK",
            r#"[{"name":"News One","stream_id":101,"epg_channel_id":"news.test","category_id":"1"}]"#,
        ),
        route(
            "action=get_live_categories",
            "200 OK",
            r#"[{"category_id":"1","category_name":"News"}]"#,
        ),
        route(
            "action=get_series ",
            "200 OK",
            r#"[{"series_id":7,"name":"Show","category_id":"2"}]"#,
        ),
        route(
            "action=get_series_categories",
            "200 OK",
            r#"[{"category_id":"2","category_name":"Drama"}]"#,
        ),
        route(
            "action=get_series_info",
            "200 OK",
            r#"{"info":{"name":"The Show"},"episodes":{"1":[
                {"id":"9002","episode_num":2,"title":"Second"},
                {"id":"9001","episode_num":1,"title":"First"}]}}"#,
        ),
    ])
}

/// A provider with no login, named after its id.
fn provider(id: &str, provider_type: ProviderType, url: &str) -> Provider {
    Provider {
        id: id.into(),
        name: format!("Provider {id}"),
        provider_type,
        url: url.into(),
        username: None,
        password: None,
        last_updated: None,
        channel_count: 0,
        epg_url: None,
    }
}

/// An Xtream provider with a login.
fn xtream_provider(id: &str, url: &str) -> Provider {
    Provider {
        username: Some("user".into()),
        password: Some("pass".into()),
        ..provider(id, ProviderType::Xtream, url)
    }
}

/// A live channel in the News group.
fn channel(id: &str, name: &str, url: &str) -> Channel {
    Channel {
        id: id.into(),
        name: name.into(),
        url: url.into(),
        group_title: "News".into(),
        content_type: "live".into(),
        ..Default::default()
    }
}

/// Saves `provider` and its channels straight to the cache.
fn add_provider(app: &TestApp, provider: &Provider, channels: &[Channel]) {
    let cache = cache(app);
    cache.upsert_provider(provider).unwrap();
    cache.save_channels(&provider.id, channels).unwrap();
}

/// The one saved provider. Fails the test if there are more or none.
async fn only_provider(app: &TestApp) -> Provider {
    let mut providers = get_providers(app.state()).await.unwrap();
    assert_eq!(providers.len(), 1, "{providers:?}");
    providers.remove(0)
}

/// The names of every saved channel, in the order the app lists them.
async fn channel_names(app: &TestApp) -> Vec<String> {
    let channels = get_all_channels(app.state()).await.unwrap();
    channels.into_iter().map(|ch| ch.name).collect()
}

/// The ids of the channels marked as favorites.
async fn favorite_ids(app: &TestApp) -> Vec<String> {
    let channels = get_all_channels(app.state()).await.unwrap();
    channels
        .into_iter()
        .filter(|ch| ch.is_favorite)
        .map(|ch| ch.id)
        .collect()
}

/// Loads the Xtream panel at `url` as "Panel", logging in as `user` with
/// `password`.
async fn load_panel(app: &TestApp, url: &str, password: &str) -> Result<Vec<Channel>, String> {
    load_xtream_provider(
        app.state(),
        "Panel".into(),
        url.into(),
        "user".into(),
        password.into(),
    )
    .await
}

/// Adds provider `p`, with a channel that [`GUIDE`] calls `news.test`, and
/// downloads the guide for it.
async fn add_provider_with_guide(app: &TestApp) {
    let guide_url = test_server::serve_once("200 OK", GUIDE);
    let news = Channel {
        tvg_id: Some("news.test".into()),
        logo_url: Some("http://example.test/news.png".into()),
        ..channel("p-news", "News One", "http://example.test/live/1.ts")
    };
    let with_guide = Provider {
        epg_url: Some(guide_url),
        ..provider("p", ProviderType::M3u, "http://example.test/list.m3u")
    };
    add_provider(app, &with_guide, &[news]);
    assert_eq!(refresh_epg(app.handle(), "p".into()).await, Ok(3));
}

#[tokio::test]
async fn a_playlist_from_a_url_is_saved_with_its_guide_address() {
    let app = TestApp::new();
    let body = playlist(Some("http://example.test/guide.xml"), &["Alpha", "Beta"]);
    let url = test_server::serve_once("200 OK", body);

    let channels = load_m3u_playlist(app.state(), "Home".into(), url.clone())
        .await
        .unwrap();

    let saved = only_provider(&app).await;
    assert!(saved.id.starts_with("m3u-"), "{}", saved.id);
    assert_eq!(saved.name, "Home");
    assert_eq!(saved.provider_type, ProviderType::M3u);
    assert_eq!(saved.url, url);
    assert_eq!(
        saved.epg_url.as_deref(),
        Some("http://example.test/guide.xml")
    );
    assert_eq!(saved.channel_count, 2);
    assert!(saved.last_updated.is_some());

    let ids: Vec<&str> = channels.iter().map(|ch| ch.id.as_str()).collect();
    let expected = [format!("{}-ch-0", saved.id), format!("{}-ch-1", saved.id)];
    assert_eq!(ids, expected);
    assert_eq!(get_all_channels(app.state()).await.unwrap(), channels);
}

#[tokio::test]
async fn a_playlist_that_fails_to_download_saves_nothing() {
    let app = TestApp::new();
    let url = test_server::serve_once("404 Not Found", "");

    let err = load_m3u_playlist(app.state(), "Home".into(), url)
        .await
        .unwrap_err();

    assert!(err.starts_with("Failed to load playlist:"), "{err}");
    assert!(get_providers(app.state()).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_playlist_file_is_saved_with_a_file_address_and_no_guide() {
    let app = TestApp::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("list.m3u");
    let body = playlist(Some("http://example.test/guide.xml"), &["Alpha"]);
    std::fs::write(&path, body).unwrap();
    let path = path.to_string_lossy().into_owned();

    let channels = load_m3u_file(app.state(), "Local".into(), path.clone())
        .await
        .unwrap();

    let saved = only_provider(&app).await;
    assert!(saved.id.starts_with("m3u-"), "{}", saved.id);
    assert_eq!(saved.name, "Local");
    assert_eq!(saved.url, format!("file://{path}"));
    assert_eq!(saved.epg_url, None);
    assert_eq!(saved.channel_count, 1);
    assert_eq!(channels.len(), 1);
    assert_eq!(channels[0].id, format!("{}-ch-0", saved.id));
    assert_eq!(channels[0].tvg_id.as_deref(), Some("Alpha.test"));
}

#[tokio::test]
async fn a_file_that_is_not_a_playlist_is_rejected() {
    let app = TestApp::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "just some notes\n").unwrap();

    let err = load_m3u_file(
        app.state(),
        "Local".into(),
        path.to_string_lossy().into_owned(),
    )
    .await
    .unwrap_err();

    assert!(err.starts_with("Failed to parse playlist:"), "{err}");
    assert!(get_providers(app.state()).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_playlist_that_cannot_be_saved_is_an_error() {
    let app = TestApp::new();
    let db = cache_on_disk(&app);
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("list.m3u");
    std::fs::write(&file, playlist(None, &["Alpha"])).unwrap();
    let file = file.to_string_lossy().into_owned();
    let load_both = || async {
        let url = test_server::serve_once("200 OK", playlist(None, &["Alpha"]));
        let from_url = load_m3u_playlist(app.state(), "Home".into(), url).await;
        let from_file = load_m3u_file(app.state(), "Local".into(), file.clone()).await;
        (from_url.map(|_| ()), from_file.map(|_| ()))
    };
    let refused = || Err(SAVE_REFUSED.to_string());

    refuse_saves(&db, "providers");
    assert_eq!(load_both().await, (refused(), refused()));
    assert!(get_providers(app.state()).await.unwrap().is_empty());

    db.execute_batch("DROP TRIGGER refuse_providers").unwrap();
    refuse_saves(&db, "channels");
    assert_eq!(load_both().await, (refused(), refused()));
    assert!(channel_names(&app).await.is_empty());
}

#[tokio::test]
async fn an_xtream_panel_is_saved_with_its_login_and_guide_address() {
    let app = TestApp::new();
    let (url, _requests) = xtream_panel();
    let password = test_server::password();

    let channels = load_panel(&app, &url, &password).await.unwrap();

    let saved = only_provider(&app).await;
    assert!(saved.id.starts_with("xt-"), "{}", saved.id);
    assert_eq!(saved.provider_type, ProviderType::Xtream);
    assert_eq!(saved.username.as_deref(), Some("user"));
    assert_eq!(saved.password, Some(password.clone()));
    assert_eq!(
        saved.epg_url,
        Some(format!("{url}/xmltv.php?username=user&password={password}"))
    );
    assert_eq!(saved.channel_count, 2);

    let live = &channels[0];
    assert_eq!(live.id, format!("{}-xt-0", saved.id));
    assert_eq!(live.url, format!("{url}/live/user/{password}/101.ts"));
    assert_eq!(live.group_title, "News");
    let series = &channels[1];
    assert_eq!(series.id, format!("{}-ser-0", saved.id));
    assert_eq!(series.url, "xtream://series/7");
}

#[tokio::test]
async fn a_panel_that_refuses_the_login_saves_nothing() {
    let app = TestApp::new();
    let url = test_server::serve_once("200 OK", LOGIN_REFUSED);

    // The panel turns every login away, so any password is wrong.
    let err = load_panel(&app, &url, &test_server::password())
        .await
        .unwrap_err();

    assert!(err.starts_with("Failed to connect:"), "{err}");
    assert!(get_providers(app.state()).await.unwrap().is_empty());
}

#[tokio::test]
async fn series_episodes_are_fetched_in_order_with_the_provider_prefix() {
    let app = TestApp::new();
    let (url, requests) = xtream_panel();
    let password = test_server::password();
    let channels = load_panel(&app, &url, &password).await.unwrap();
    let provider_id = only_provider(&app).await.id;
    let series_id = channels[1].id.clone();

    let episodes = get_xtream_series_episodes(app.state(), series_id)
        .await
        .unwrap();

    let ids: Vec<&str> = episodes.iter().map(|ep| ep.id.as_str()).collect();
    let expected = [
        format!("{provider_id}-xt-ep-7-s1-1"),
        format!("{provider_id}-xt-ep-7-s1-0"),
    ];
    assert_eq!(ids, expected);
    assert_eq!(episodes[0].name, "The Show S01E01 First");
    assert_eq!(
        episodes[0].url,
        format!("{url}/series/user/{password}/9001.mkv")
    );
    assert_eq!(episodes[0].group_title, "Drama");
    let asked_for_the_series = requests
        .try_iter()
        .any(|request| request.contains("action=get_series_info&series_id=7 "));
    assert!(asked_for_the_series);
}

/// What was logged while a test held [`Logged::start`]'s guard.
#[derive(Clone, Default)]
struct Logged(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl Logged {
    /// Logs everything on this thread until the guard drops. A tokio test
    /// runs its awaits on its own thread, so their logs land here too.
    fn start(&self) -> tracing::subscriber::DefaultGuard {
        // tracing caches whether a log line is wanted. While only one
        // dispatcher has ever existed, a line first reached with none set
        // stays off for good, even after this test sets its own. A second
        // dispatcher alive for the whole run makes tracing ask again.
        static SECOND: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
        SECOND.get_or_init(|| tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default()));
        let logged = self.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || logged.clone())
            .finish();
        tracing::subscriber::set_default(subscriber)
    }

    /// Everything logged so far.
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl std::io::Write for Logged {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn loading_a_provider_logs_where_it_is_without_its_login() {
    let app = TestApp::new();
    let logged = Logged::default();
    let _logging = logged.start();
    let list = test_server::serve_once("200 OK", playlist(None, &["Alpha"]));
    let (panel, _requests) = xtream_panel();

    let password = test_server::password();

    let login = format!("?username=user&password={password}");
    load_m3u_playlist(app.state(), "Home".into(), format!("{list}/get.php{login}"))
        .await
        .unwrap();
    let channels = load_panel(&app, &panel, &password).await.unwrap();
    get_xtream_series_episodes(app.state(), channels[1].id.clone())
        .await
        .unwrap();

    let log = logged.text();
    assert!(log.contains(&format!("from {list}\n")), "{log}");
    assert!(log.contains(&format!("from {panel}\n")), "{log}");
    assert!(log.contains("fetched 2 episodes for series_id=7"), "{log}");
    assert!(!log.contains(&password), "{log}");
}

#[tokio::test]
async fn episodes_are_only_fetched_for_xtream_series() {
    let app = TestApp::new();
    add_provider(
        &app,
        &provider("m3u", ProviderType::M3u, "http://example.test/list.m3u"),
        &[channel("m3u-ch-0", "Show", "xtream://series/7")],
    );
    add_provider(
        &app,
        &xtream_provider("xt", "http://example.test"),
        &[
            channel("xt-live", "News", "http://example.test/live/1.ts"),
            channel("xt-bad", "Broken", "xtream://series/seven"),
        ],
    );

    let episodes = |id: &str| get_xtream_series_episodes(app.state(), id.into());
    assert_eq!(
        episodes("missing").await,
        Err("Channel not found: missing".into())
    );
    assert_eq!(
        episodes("m3u-ch-0").await,
        Err("Not an Xtream provider".into())
    );
    assert_eq!(
        episodes("xt-live").await,
        Err("Invalid Xtream series URL".into())
    );
    let err = episodes("xt-bad").await.unwrap_err();
    assert!(err.starts_with("Invalid series ID:"), "{err}");
}

#[tokio::test]
async fn refreshing_a_file_provider_reads_the_file_again() {
    let app = TestApp::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("list.m3u");
    std::fs::write(&path, playlist(None, &["Alpha"])).unwrap();
    let path_text = path.to_string_lossy().into_owned();
    load_m3u_file(app.state(), "Local".into(), path_text)
        .await
        .unwrap();
    let id = only_provider(&app).await.id;
    std::fs::write(&path, playlist(None, &["Alpha", "Beta", "Gamma"])).unwrap();

    refresh_provider(app.state(), id.clone()).await.unwrap();

    assert_eq!(only_provider(&app).await.channel_count, 3);
    let channels = get_all_channels(app.state()).await.unwrap();
    let prefix = format!("{id}-ch-");
    assert_eq!(channels.len(), 3);
    assert!(channels.iter().all(|ch| ch.id.starts_with(&prefix)));
}

#[tokio::test]
async fn refreshing_a_url_provider_keeps_its_guide_address_unless_the_playlist_has_a_new_one() {
    let app = TestApp::new();
    let first = playlist(Some("http://example.test/old.xml"), &["Alpha"]);
    let second = playlist(Some("http://example.test/new.xml"), &["Alpha", "Beta"]);
    let third = playlist(None, &["Alpha", "Beta", "Gamma"]);
    let (url, _requests) =
        test_server::serve_in_order(&[("200 OK", &first), ("200 OK", &second), ("200 OK", &third)]);
    load_m3u_playlist(app.state(), "Home".into(), url)
        .await
        .unwrap();
    let id = only_provider(&app).await.id;

    refresh_provider(app.state(), id.clone()).await.unwrap();
    let saved = only_provider(&app).await;
    assert_eq!(
        saved.epg_url.as_deref(),
        Some("http://example.test/new.xml")
    );
    assert_eq!(saved.channel_count, 2);

    refresh_provider(app.state(), id).await.unwrap();
    let saved = only_provider(&app).await;
    assert_eq!(
        saved.epg_url.as_deref(),
        Some("http://example.test/new.xml")
    );
    assert_eq!(saved.channel_count, 3);
    assert_eq!(channel_names(&app).await, ["Alpha", "Beta", "Gamma"]);
}

#[tokio::test]
async fn refreshing_an_xtream_provider_restores_its_guide_address() {
    let app = TestApp::new();
    let (url, _requests) = xtream_panel();
    load_panel(&app, &url, &test_server::password())
        .await
        .unwrap();
    let saved = only_provider(&app).await;
    set_epg_url(app.state(), saved.id.clone(), None)
        .await
        .unwrap();
    assert_eq!(only_provider(&app).await.epg_url, None);

    refresh_provider(app.state(), saved.id.clone())
        .await
        .unwrap();

    let refreshed = only_provider(&app).await;
    assert_eq!(refreshed.epg_url, saved.epg_url);
    assert_eq!(refreshed.channel_count, 2);
}

#[tokio::test]
async fn refreshing_a_missing_provider_is_an_error() {
    let app = TestApp::new();
    assert_eq!(
        refresh_provider(app.state(), "gone".into()).await,
        Err("Provider not found: gone".into())
    );
}

#[tokio::test]
async fn a_failed_refresh_keeps_the_saved_channels() {
    let app = TestApp::new();
    let dir = tempfile::tempdir().unwrap();
    let missing_file = format!("file://{}", dir.path().join("gone.m3u").display());
    let failures = [
        (
            provider("file", ProviderType::M3u, &missing_file),
            "Failed to parse file:",
        ),
        (
            provider(
                "url",
                ProviderType::M3u,
                &test_server::serve_once("500 Internal Server Error", ""),
            ),
            "Failed to fetch:",
        ),
        (
            xtream_provider("xt", &test_server::serve_once("200 OK", LOGIN_REFUSED)),
            "Failed to connect:",
        ),
    ];

    for (source, expected) in failures {
        let kept = channel(
            &format!("{}-ch-0", source.id),
            "Kept",
            "http://example.test/1.ts",
        );
        add_provider(&app, &source, &[kept]);

        let err = refresh_provider(app.state(), source.id.clone())
            .await
            .unwrap_err();

        assert!(err.starts_with(expected), "{}: {err}", source.id);
        let saved = cache(&app).get_channels(&source.id).unwrap();
        assert_eq!(saved.len(), 1);
    }
}

#[tokio::test]
async fn updating_a_provider_changes_its_name_address_and_login() {
    let app = TestApp::new();
    add_provider(&app, &xtream_provider("xt", "http://example.test/old"), &[]);

    update_provider(
        app.state(),
        "xt".into(),
        "Renamed".into(),
        "http://example.test/new".into(),
        Some("other".into()),
        None,
    )
    .await
    .unwrap();

    let saved = only_provider(&app).await;
    assert_eq!(saved.name, "Renamed");
    assert_eq!(saved.url, "http://example.test/new");
    assert_eq!(saved.username.as_deref(), Some("other"));
    assert_eq!(saved.password, None);
}

#[tokio::test]
async fn removing_a_provider_removes_its_channels() {
    let app = TestApp::new();
    let one = provider("one", ProviderType::M3u, "http://example.test/1.m3u");
    let two = provider("two", ProviderType::M3u, "http://example.test/2.m3u");
    add_provider(
        &app,
        &one,
        &[channel("one-ch-0", "Alpha", "http://example.test/a")],
    );
    add_provider(
        &app,
        &two,
        &[channel("two-ch-0", "Beta", "http://example.test/b")],
    );

    remove_provider(app.state(), "one".into()).await.unwrap();

    assert_eq!(only_provider(&app).await.id, "two");
    assert_eq!(channel_names(&app).await, ["Beta"]);
}

#[tokio::test]
async fn a_favorite_toggles_on_and_off() {
    let app = TestApp::new();
    let list = provider("p", ProviderType::M3u, "http://example.test/list.m3u");
    let channels = [
        channel("p-ch-0", "Alpha", "http://example.test/a"),
        channel("p-ch-1", "Beta", "http://example.test/b"),
    ];
    add_provider(&app, &list, &channels);

    assert_eq!(
        toggle_favorite(app.state(), "p-ch-1".into()).await,
        Ok(true)
    );
    assert_eq!(favorite_ids(&app).await, ["p-ch-1"]);
    assert_eq!(
        toggle_favorite(app.state(), "p-ch-1".into()).await,
        Ok(false)
    );
    assert!(favorite_ids(&app).await.is_empty());
    assert!(toggle_favorite(app.state(), "missing".into())
        .await
        .is_err());
}

#[tokio::test]
async fn a_downloaded_guide_is_read_back_by_channel_and_time() {
    let app = TestApp::new();
    add_provider_with_guide(&app).await;

    let news = get_epg_programmes(app.state(), "news.test".into(), NOON, NOON + 2 * HOUR)
        .await
        .unwrap();
    let titles: Vec<&str> = news.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(titles, ["Noon News", "Weather"]);
    assert_eq!(news[0].channel_id, "news.test");
    assert_eq!(news[0].description.as_deref(), Some("The day so far"));
    assert_eq!(news[0].category.as_deref(), Some("News"));
    assert_eq!((news[0].start_time, news[0].end_time), (NOON, NOON + HOUR));
    assert_eq!(news[1].description, None);

    let later = get_epg_programmes(
        app.state(),
        "news.test".into(),
        NOON + HOUR,
        NOON + 2 * HOUR,
    )
    .await
    .unwrap();
    assert_eq!(later.len(), 1);
    assert_eq!(later[0].title, "Weather");
}

#[tokio::test]
async fn the_guide_for_all_channels_is_sorted_by_channel_and_time() {
    let app = TestApp::new();
    add_provider_with_guide(&app).await;

    let all = get_epg_for_live_channels(app.state(), NOON, NOON + 3 * HOUR)
        .await
        .unwrap();
    let shown: Vec<(&str, &str)> = all
        .iter()
        .map(|p| (p.channel_id.as_str(), p.title.as_str()))
        .collect();
    assert_eq!(
        shown,
        [
            ("film.test", "Evening News Film"),
            ("news.test", "Noon News"),
            ("news.test", "Weather"),
        ]
    );

    let last_hour = get_epg_for_live_channels(app.state(), NOON + 2 * HOUR, NOON + 3 * HOUR)
        .await
        .unwrap();
    assert_eq!(last_hour.len(), 1);
    assert_eq!(last_hour[0].title, "Evening News Film");
    assert_eq!(last_hour[0].category, None);
}

#[tokio::test]
async fn a_guide_search_names_the_channel_and_skips_what_has_ended() {
    let app = TestApp::new();
    add_provider_with_guide(&app).await;

    let found = search_epg_programmes(app.state(), "news".into(), NOON)
        .await
        .unwrap();
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].title, "Noon News");
    assert_eq!(found[0].channel_name, "News One");
    assert_eq!(
        found[0].channel_logo_url.as_deref(),
        Some("http://example.test/news.png")
    );
    assert_eq!(found[0].description.as_deref(), Some("The day so far"));
    assert_eq!(
        (found[0].start_time, found[0].end_time),
        (NOON, NOON + HOUR)
    );
    // No saved channel has this guide id, so the id stands in for the name.
    assert_eq!(found[1].channel_id, "film.test");
    assert_eq!(found[1].channel_name, "film.test");
    assert_eq!(found[1].channel_logo_url, None);

    let after_noon_news = search_epg_programmes(app.state(), "news".into(), NOON + HOUR)
        .await
        .unwrap();
    assert_eq!(after_noon_news.len(), 1);
    assert_eq!(after_noon_news[0].title, "Evening News Film");

    let blank = search_epg_programmes(app.state(), "  ".into(), NOON)
        .await
        .unwrap();
    assert!(blank.is_empty());
}

#[tokio::test]
async fn a_guide_without_programs_keeps_the_saved_one() {
    let app = TestApp::new();
    let (guide_url, _requests) =
        test_server::serve_in_order(&[("200 OK", GUIDE), ("200 OK", GUIDE_WITHOUT_PROGRAMS)]);
    let with_guide = Provider {
        epg_url: Some(guide_url),
        ..provider("p", ProviderType::M3u, "http://example.test/list.m3u")
    };
    add_provider(&app, &with_guide, &[]);
    assert_eq!(refresh_epg(app.handle(), "p".into()).await, Ok(3));

    assert_eq!(refresh_epg(app.handle(), "p".into()).await, Ok(0));

    let kept = get_epg_for_live_channels(app.state(), NOON, NOON + 3 * HOUR)
        .await
        .unwrap();
    assert_eq!(kept.len(), 3);
}

#[tokio::test]
async fn a_guide_that_fails_to_download_is_an_error() {
    let app = TestApp::new();
    let with_guide = Provider {
        epg_url: Some(test_server::serve_once("500 Internal Server Error", "")),
        ..provider("p", ProviderType::M3u, "http://example.test/list.m3u")
    };
    add_provider(&app, &with_guide, &[]);

    let err = refresh_epg(app.handle(), "p".into()).await.unwrap_err();

    assert!(err.starts_with("Failed to fetch EPG:"), "{err}");
}

#[tokio::test]
async fn a_guide_needs_a_guide_address() {
    let app = TestApp::new();
    add_provider(
        &app,
        &provider("p", ProviderType::M3u, "http://example.test/list.m3u"),
        &[],
    );
    let missing = Err("No EPG URL configured for this provider".to_string());

    assert_eq!(refresh_epg(app.handle(), "p".into()).await, missing);
    assert_eq!(refresh_epg(app.handle(), "unknown".into()).await, missing);
}

#[tokio::test]
async fn the_guide_address_is_derived_for_xtream_and_stored_for_m3u() {
    let app = TestApp::new();
    add_provider(
        &app,
        &xtream_provider("xt", "http://example.test:8080/"),
        &[],
    );
    let m3u = Provider {
        epg_url: Some("http://example.test/guide.xml".into()),
        ..provider("m3u", ProviderType::M3u, "http://example.test/list.m3u")
    };
    add_provider(&app, &m3u, &[]);

    assert_eq!(
        detect_epg_url(app.state(), "xt".into()).await,
        Ok(Some(
            "http://example.test:8080/xmltv.php?username=user&password=pass".into()
        ))
    );
    assert_eq!(
        detect_epg_url(app.state(), "m3u".into()).await,
        Ok(Some("http://example.test/guide.xml".into()))
    );
    assert_eq!(
        detect_epg_url(app.state(), "unknown".into()).await,
        Ok(None)
    );

    set_epg_url(app.state(), "m3u".into(), None).await.unwrap();
    assert_eq!(detect_epg_url(app.state(), "m3u".into()).await, Ok(None));
}

#[tokio::test]
async fn playing_counts_plays_and_adds_up_the_time_watched() {
    let app = TestApp::new();
    let logo = Some("http://example.test/logo.png".to_string());
    for _ in 0..2 {
        record_play_start(
            app.state(),
            "ch-1".into(),
            "News One".into(),
            logo.clone(),
            "live".into(),
        )
        .await
        .unwrap();
    }
    record_play_end(app.state(), "ch-1".into(), 30)
        .await
        .unwrap();
    record_play_end(app.state(), "ch-1".into(), 15)
        .await
        .unwrap();
    // A negative length, as from a clock that went backwards, adds nothing.
    record_play_end(app.state(), "ch-1".into(), -10)
        .await
        .unwrap();

    let history = get_watch_history(app.state(), 10, None).await.unwrap();
    assert_eq!(history.len(), 1);
    let entry = &history[0];
    assert_eq!(entry.channel_id, "ch-1");
    assert_eq!(entry.channel_name, "News One");
    assert_eq!(entry.channel_logo, logo);
    assert_eq!(entry.content_type, "live");
    assert_eq!(entry.play_count, 2);
    assert_eq!(entry.total_duration_seconds, 45);
    assert!(entry.first_watched_at <= entry.last_watched_at);
    assert_eq!(entry.series_title, None);
}

/// Plays a live channel, a movie and two episodes of one show.
async fn play_one_of_each(app: &TestApp) {
    for (id, name, content_type) in [
        ("live-1", "News One", "live"),
        ("movie-1", "A Film", "movie"),
        ("ep-1", "Show S01E01", "series"),
        ("ep-2", "Show S01E02", "series"),
    ] {
        record_play_start(
            app.state(),
            id.into(),
            name.into(),
            None,
            content_type.into(),
        )
        .await
        .unwrap();
    }
}

/// The ids in the history, sorted, since plays in the same second have no
/// set order.
async fn history_ids(app: &TestApp, content_type: Option<&str>) -> Vec<String> {
    let history = get_watch_history(app.state(), 10, content_type.map(String::from))
        .await
        .unwrap();
    let mut ids: Vec<String> = history.into_iter().map(|e| e.channel_id).collect();
    ids.sort();
    ids
}

#[tokio::test]
async fn history_can_be_limited_and_filtered_by_type() {
    let app = TestApp::new();
    play_one_of_each(&app).await;

    assert_eq!(history_ids(&app, Some("movie")).await, ["movie-1"]);
    assert_eq!(history_ids(&app, Some("series")).await, ["ep-1", "ep-2"]);
    let limited = get_watch_history(app.state(), 2, None).await.unwrap();
    assert_eq!(limited.len(), 2);
    let negative = get_watch_history(app.state(), -5, None).await.unwrap();
    assert!(negative.is_empty());
}

#[tokio::test]
async fn series_history_is_grouped_and_deleted_by_show() {
    let app = TestApp::new();
    play_one_of_each(&app).await;
    record_play_start(
        app.state(),
        "other-1".into(),
        "Other S02E05".into(),
        None,
        "series".into(),
    )
    .await
    .unwrap();

    let series = get_watch_history(app.state(), 10, Some("series".into()))
        .await
        .unwrap();
    let show_of = |id: &str| {
        let entry = series.iter().find(|e| e.channel_id == id).unwrap();
        entry.series_title.clone()
    };
    assert_eq!(show_of("ep-1").as_deref(), Some("Show"));
    assert_eq!(show_of("other-1").as_deref(), Some("Other"));

    delete_history_series(app.state(), "Show".into())
        .await
        .unwrap();

    assert_eq!(history_ids(&app, Some("series")).await, ["other-1"]);
    assert_eq!(history_ids(&app, None).await.len(), 3);
}

#[tokio::test]
async fn history_is_cleared_by_entry_by_type_or_all_at_once() {
    let app = TestApp::new();
    play_one_of_each(&app).await;
    save_playback_position(app.state(), "movie:A Film".into(), 60.0, 600.0)
        .await
        .unwrap();
    let position = || get_playback_position(app.state(), "movie:A Film".into());

    delete_history_entry(app.state(), "live-1".into())
        .await
        .unwrap();
    assert_eq!(history_ids(&app, None).await, ["ep-1", "ep-2", "movie-1"]);

    clear_watch_history_of_type(app.state(), "series".into())
        .await
        .unwrap();
    assert_eq!(history_ids(&app, None).await, ["movie-1"]);
    assert!(position().await.unwrap().is_some());

    clear_watch_history(app.state()).await.unwrap();
    assert!(history_ids(&app, None).await.is_empty());
    assert_eq!(position().await, Ok(None));
}

#[tokio::test]
async fn a_playback_position_is_saved_replaced_and_deleted() {
    let app = TestApp::new();
    let key = || "series:Show:1:2".to_string();
    assert_eq!(get_playback_position(app.state(), key()).await, Ok(None));

    save_playback_position(app.state(), key(), 30.0, 1200.0)
        .await
        .unwrap();
    save_playback_position(app.state(), key(), 95.5, 1200.0)
        .await
        .unwrap();

    let saved = get_playback_position(app.state(), key())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.content_key, key());
    assert_eq!(saved.position_seconds, 95.5);
    assert_eq!(saved.duration_seconds, 1200.0);

    delete_playback_position(app.state(), key()).await.unwrap();
    assert_eq!(get_playback_position(app.state(), key()).await, Ok(None));
}

/// Puts the live group `group` of provider `p` under `category` at `order`.
async fn place_group(app: &TestApp, group: &str, category: Option<&str>, order: i64) {
    update_group_hierarchy_entry(
        app.state(),
        "p".into(),
        "live".into(),
        group.into(),
        category.map(String::from),
        order,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn groups_are_placed_and_reordered_by_hand() {
    let app = TestApp::new();
    place_group(&app, "News", Some("Info"), 10).await;
    place_group(&app, "Sport", None, 20).await;

    reorder_group_hierarchy_entry(app.state(), "p".into(), "live".into(), "Sport".into(), 5)
        .await
        .unwrap();

    let expected = [
        ("Sport".to_string(), None, 5),
        ("News".to_string(), Some("Info".to_string()), 10),
    ];
    assert_eq!(groups(&app, "live").await, expected);
    assert!(groups(&app, "movie").await.is_empty());
    let entries = get_group_hierarchy(app.state(), "p".into(), "live".into())
        .await
        .unwrap();
    assert!(entries.iter().all(|e| e.is_user_override));

    delete_group_hierarchy(app.state(), "p".into(), "live".into())
        .await
        .unwrap();
    assert!(groups(&app, "live").await.is_empty());
}

#[tokio::test]
async fn a_category_is_renamed_or_removed_in_all_its_groups() {
    let app = TestApp::new();
    place_group(&app, "News", Some("Info"), 10).await;
    place_group(&app, "Weather", Some("Info"), 20).await;
    place_group(&app, "Sport", Some("Games"), 30).await;
    let categories = |groups: Vec<Placed>| groups.into_iter().map(|g| g.1).collect::<Vec<_>>();
    let facts = Some("Facts".to_string());
    let games = Some("Games".to_string());

    rename_super_category(
        app.state(),
        "p".into(),
        "live".into(),
        "Info".into(),
        "Facts".into(),
    )
    .await
    .unwrap();
    assert_eq!(
        categories(groups(&app, "live").await),
        [facts.clone(), facts, games.clone()]
    );

    delete_super_category(app.state(), "p".into(), "live".into(), "Facts".into())
        .await
        .unwrap();
    assert_eq!(categories(groups(&app, "live").await), [None, None, games]);
}

#[tokio::test]
async fn groups_are_pinned_in_order_and_unpinned() {
    let app = TestApp::new();
    let pin = |group: &str, order: i64| {
        pin_group(app.state(), "p".into(), "live".into(), group.into(), order)
    };
    let pinned =
        |content_type: &str| get_pinned_groups(app.state(), "p".into(), content_type.into());
    pin("Sport", 2).await.unwrap();
    pin("News", 1).await.unwrap();
    let names = |pins: Vec<PinnedGroup>| pins.into_iter().map(|g| g.group_name).collect::<Vec<_>>();
    assert_eq!(names(pinned("live").await.unwrap()), ["News", "Sport"]);

    unpin_group(app.state(), "p".into(), "live".into(), "News".into())
        .await
        .unwrap();

    assert_eq!(names(pinned("live").await.unwrap()), ["Sport"]);
    assert!(pinned("movie").await.unwrap().is_empty());
}

#[tokio::test]
async fn clearing_caches_drops_the_guide_and_subtitles_but_keeps_providers_and_history() {
    let app = TestApp::new();
    add_provider_with_guide(&app).await;
    play_one_of_each(&app).await;
    let subtitles = subtitles_folder(&app);
    std::fs::create_dir_all(&subtitles).unwrap();
    std::fs::write(
        subtitles.join("42.srt"),
        "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    )
    .unwrap();

    clear_all_caches(app.handle(), app.state()).await.unwrap();

    assert!(!subtitles.exists());
    let guide = get_epg_for_live_channels(app.state(), NOON, NOON + 3 * HOUR)
        .await
        .unwrap();
    assert!(guide.is_empty());
    assert_eq!(only_provider(&app).await.id, "p");
    assert_eq!(channel_names(&app).await, ["News One"]);
    assert_eq!(history_ids(&app, None).await.len(), 4);

    // With no subtitles folder left, clearing again still works.
    clear_all_caches(app.handle(), app.state()).await.unwrap();
}

#[tokio::test]
async fn a_subtitles_folder_that_cannot_be_removed_is_an_error() {
    let app = TestApp::new();
    let subtitles = subtitles_folder(&app);
    std::fs::create_dir_all(subtitles.parent().unwrap()).unwrap();
    std::fs::write(&subtitles, "not a folder").unwrap();

    assert!(clear_all_caches(app.handle(), app.state()).await.is_err());
    assert!(subtitles.is_file());
}

#[tokio::test]
async fn a_subtitle_file_is_read_as_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("1.srt");
    let text = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
    std::fs::write(&path, text).unwrap();
    let path = path.to_string_lossy().into_owned();

    assert_eq!(read_subtitle_file(path).await, Ok(text.to_string()));
    let missing = dir.path().join("2.srt").to_string_lossy().into_owned();
    assert!(read_subtitle_file(missing).await.is_err());
}

#[test]
fn install_info_points_manual_updates_at_the_latest_release() {
    let info = get_install_info();
    assert_eq!(
        info.release_url,
        "https://github.com/MaxMB15/MaxVideoPlayer/releases/latest"
    );
    if cfg!(target_os = "linux") {
        let known = ["appimage", "deb", "rpm", "native"];
        assert!(
            known.contains(&info.install_type.as_str()),
            "{}",
            info.install_type
        );
    } else {
        // macOS and Windows update through the built-in updater.
        assert_eq!(info.install_type, "native");
    }
}
