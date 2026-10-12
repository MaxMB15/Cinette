// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/// Map a container extension to the ffmpeg muxer (`-f`) name. We pass this
/// explicitly because the download writes to a temporary `.part` file whose
/// extension ffmpeg cannot use to guess the output format (it would fail with
/// "Unable to choose an output format ... Invalid argument").
pub fn muxer_for_container(container: &str) -> &'static str {
    match container.trim_start_matches('.').to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "mp4",
        "mov" => "mov",
        "ts" | "mpegts" | "m2ts" => "mpegts",
        "webm" => "webm",
        "avi" => "avi",
        _ => "matroska",
    }
}

/// Extract the final container extension from a `.part` destination path,
/// e.g. `/dl/Show/S01E01.mkv.part` → `mkv`. Falls back to `mkv` when there is
/// no usable extension.
pub fn container_from_part_path(dest_path: &str) -> &str {
    let final_path = dest_path.strip_suffix(".part").unwrap_or(dest_path);
    match final_path.rsplit_once('.') {
        // Guard against a dot that belongs to a directory rather than the file.
        Some((_, ext)) if !ext.is_empty() && !ext.contains('/') => ext,
        _ => "mkv",
    }
}

/// Build the ffmpeg argument vector for a stream-copy download.
/// `dest_part` is the temporary `.part` path written during download.
/// `container` is the final file extension (e.g. `mkv`, `mp4`) used to select
/// the output muxer explicitly via `-f`.
pub fn build_ffmpeg_args(url: &str, dest_part: &str, container: &str) -> Vec<String> {
    let muxer = muxer_for_container(container);
    let mut args = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        // Reconnect after a dropped connection and carry on from where the
        // reply broke off. ffmpeg can tell a reply broke off when the server
        // gave its size. There's no `-reconnect_at_eof`: it takes the normal
        // end of every file and HLS playlist for a drop and keeps trying to
        // reconnect for close to a minute.
        "-reconnect".into(),
        "1".into(),
        "-reconnect_streamed".into(),
        "1".into(),
        "-reconnect_delay_max".into(),
        "30".into(),
        "-i".into(),
        url.into(),
        "-c".into(),
        "copy".into(),
    ];
    // `+faststart` is a private option of the mp4/mov muxers; applying it to
    // other containers (matroska, mpegts, …) makes ffmpeg error out.
    if muxer == "mp4" || muxer == "mov" {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    // Name the output muxer, because ffmpeg can't detect it from the `.part` extension.
    args.push("-f".into());
    args.push(muxer.into());
    // Machine-readable progress on stdout, one key=value per line.
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push("-y".into());
    args.push(dest_part.into());
    args
}

/// A parsed snapshot from ffmpeg's `-progress` stream. ffmpeg emits a block of
/// `key=value` lines terminated by `progress=continue` or `progress=end`.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ProgressUpdate {
    pub total_size: Option<i64>,
    pub out_time_ms: Option<i64>,
    pub done: bool,
}

/// Fold a single `key=value` line into an accumulating ProgressUpdate.
/// Returns true when the block is complete (`progress=continue|end`).
pub fn fold_progress_line(acc: &mut ProgressUpdate, line: &str) -> bool {
    let line = line.trim();
    let Some((key, value)) = line.split_once('=') else {
        return false;
    };
    match key {
        "total_size" => acc.total_size = value.parse().ok(),
        "out_time_ms" => acc.out_time_ms = value.parse().ok(),
        "progress" => {
            acc.done = value == "end";
            return true;
        }
        _ => {}
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_use_stream_copy_and_progress_pipe() {
        let args = build_ffmpeg_args("http://h/movie/u/p/1.mkv", "/tmp/1.mkv.part", "mkv");
        let joined = args.join(" ");
        assert!(joined.contains("-c copy"));
        assert!(joined.contains("-progress pipe:1"));
        assert!(joined.contains("-reconnect 1"));
        // Explicit muxer so the ".part" extension doesn't break detection.
        assert!(joined.contains("-f matroska"));
        // faststart must NOT be present for a matroska container.
        assert!(!joined.contains("-movflags"));
        assert_eq!(args.last().unwrap(), "/tmp/1.mkv.part");
        // URL is the argument right after -i.
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[i + 1], "http://h/movie/u/p/1.mkv");
    }

    #[test]
    fn does_not_reconnect_when_a_file_ends() {
        let args = build_ffmpeg_args("http://h/movie/u/p/1.m3u8", "/tmp/1.mkv.part", "mkv");
        assert!(!args.iter().any(|a| a == "-reconnect_at_eof"));
        assert!(args.windows(2).any(|w| w[0] == "-reconnect" && w[1] == "1"));
    }

    #[test]
    fn mp4_container_gets_faststart_and_mp4_muxer() {
        let args = build_ffmpeg_args("http://h/movie/u/p/1.mp4", "/tmp/1.mp4.part", "mp4");
        let joined = args.join(" ");
        assert!(joined.contains("-movflags +faststart"));
        assert!(joined.contains("-f mp4"));
    }

    #[test]
    fn extracts_container_from_part_path() {
        assert_eq!(container_from_part_path("/dl/Show/S01E01.mkv.part"), "mkv");
        assert_eq!(container_from_part_path("/dl/Movie.mp4.part"), "mp4");
        // Already-final path (no .part suffix).
        assert_eq!(container_from_part_path("/dl/Movie.ts"), "ts");
        // No extension → default.
        assert_eq!(container_from_part_path("/dl/noext.part"), "mkv");
    }

    #[test]
    fn maps_containers_to_muxers() {
        assert_eq!(muxer_for_container("mkv"), "matroska");
        assert_eq!(muxer_for_container("mp4"), "mp4");
        assert_eq!(muxer_for_container("ts"), "mpegts");
        assert_eq!(muxer_for_container("webm"), "webm");
        assert_eq!(muxer_for_container("unknown"), "matroska");
    }

    #[test]
    fn folds_progress_block() {
        let mut acc = ProgressUpdate::default();
        assert!(!fold_progress_line(&mut acc, "total_size=410000000"));
        assert!(!fold_progress_line(&mut acc, "out_time_ms=41000000"));
        let complete = fold_progress_line(&mut acc, "progress=continue");
        assert!(complete);
        assert_eq!(acc.total_size, Some(410_000_000));
        assert_eq!(acc.out_time_ms, Some(41_000_000));
        assert!(!acc.done);
    }

    #[test]
    fn detects_end() {
        let mut acc = ProgressUpdate::default();
        assert!(fold_progress_line(&mut acc, "progress=end"));
        assert!(acc.done);
    }
}
