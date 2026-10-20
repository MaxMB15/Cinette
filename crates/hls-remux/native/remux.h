// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Converts a stream into MPEG-TS segments in memory with libavformat and
// libavcodec, for HLS. It copies the video, and copies or converts one
// audio track to stereo AAC. On iOS, Xcode builds this file against
// MPVKit's FFmpeg. Rust's tests build it against the system's.
//
// The stream's URL carries the provider's login, so nothing here logs it.

#ifndef CINETTE_REMUX_H
#define CINETTE_REMUX_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* What the functions return. */
enum {
  CINETTE_REMUX_OK = 0,
  /* The source couldn't be opened or read. */
  CINETTE_REMUX_UNREACHABLE = -1,
  /* The provider answered 401 or 403. */
  CINETTE_REMUX_REFUSED = -2,
  /* Something on this device failed, such as an encoder. */
  CINETTE_REMUX_FAILED = -3,
  /* cinette_remux_cancel stopped it. */
  CINETTE_REMUX_CANCELLED = -4,
};

enum {
  CINETTE_AUDIO_COPY = 0,
  CINETTE_AUDIO_AAC = 1,
};

typedef struct CinetteRemux CinetteRemux;

/* Bytes of MPEG-TS output, in order. */
typedef void (*cinette_remux_write_fn)(void *ctx, const uint8_t *data, int size);
/* The segment written since the last cut ended. It's `duration` seconds
 * long, and it started `start` seconds into the source. It blocks while
 * the caller wants the converter to wait. Returns nonzero to stop. */
typedef int (*cinette_remux_cut_fn)(void *ctx, double duration, double start);

/* One of the source's audio streams. */
typedef struct {
  /* FFmpeg's codec name, such as "aac" or "ac3". */
  const char *codec;
  /* The language tag, or NULL. */
  const char *language;
  int is_default;
  /* This FFmpeg has a decoder for it, so it can be converted. */
  int decodable;
} CinetteAudioTrack;

/* Makes a converter that hasn't opened anything, so it can be cancelled
 * while it opens. Returns CINETTE_REMUX_OK and sets `*out`, or an error.
 * Free it with cinette_remux_close, whether it opened or not. */
int cinette_remux_new(CinetteRemux **out);
/* Opens `url`, starting `start` seconds in when it's above 0. Positions
 * count from the source's first timestamp. A cancel stops it. */
int cinette_remux_open(CinetteRemux *r, const char *url, double start, const char *user_agent);

/* The source's audio streams, valid until cinette_remux_close. */
int cinette_remux_audio_count(const CinetteRemux *r);
CinetteAudioTrack cinette_remux_audio_track(const CinetteRemux *r, int index);

/* What the source's video is: 1 for H.264, 2 for HEVC, 0 for another
 * codec, -1 for none. `extradata` points into the stream's codec data. */
int cinette_remux_video(const CinetteRemux *r, const uint8_t **extradata, int *size);

/* The source's length in seconds, or 0 for a live stream. */
double cinette_remux_duration(const CinetteRemux *r);

/* Starts the output: audio stream `audio` (counting the audio streams from
 * 0, or -1 for none) by `audio_mode`. `downmix` asks the decoder for
 * stereo, which AC-3, E-AC-3 and DTS decoders do with the stream's own
 * levels. Segments are cut at video keyframes once they're at least
 * `segment` seconds long, and at any packet once they're four times that
 * or 32 MB. Timestamps that jump are moved to carry on. */
int cinette_remux_start(CinetteRemux *r, int audio, int audio_mode, int downmix, double segment,
                        cinette_remux_write_fn write, cinette_remux_cut_fn cut, void *ctx);

/* Runs until the source ends, an error, or a cancel. The last segment is
 * cut before it returns CINETTE_REMUX_OK. */
int cinette_remux_run(CinetteRemux *r);

/* Stops a run from any thread. */
void cinette_remux_cancel(CinetteRemux *r);

void cinette_remux_close(CinetteRemux *r);

#ifdef __cplusplus
}
#endif

#endif
