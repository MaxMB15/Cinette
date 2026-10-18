// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// See remux.h. libavformat's API reads and writes struct fields whose
// layout changes between FFmpeg versions, which is why this part is C,
// built against the real headers, rather than declared by hand in Rust.

#include "remux.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>

/* The AAC that receivers play: stereo at 48 kHz, 256 kb/s, which leaves a
 * second lossy pass room. */
#define AAC_RATE 48000
#define AAC_BITRATE 256000
#define IO_BUFFER (64 * 1024)
#define MAX_AUDIO 32

struct CinetteRemux {
  AVFormatContext *in;
  AVFormatContext *out;
  AVIOContext *pb;

  int video_in;
  int audio_streams[MAX_AUDIO];
  int audio_count;
  int audio_in;
  int video_out;
  int audio_out;
  int audio_mode;

  AVCodecContext *dec;
  AVCodecContext *enc;
  SwrContext *swr;
  AVAudioFifo *fifo;
  AVFrame *frame;
  AVPacket *pkt;
  int64_t next_audio_pts;
  int audio_pts_set;

  /* Segments: their target length, and where the current one started and
   * the last cut point seen, in seconds. */
  double segment;
  int segment_started;
  double segment_start;
  double last_time;

  atomic_int cancelled;
  cinette_remux_write_fn write;
  cinette_remux_cut_fn cut;
  void *ctx;
};

static int interrupted(void *opaque) {
  CinetteRemux *r = opaque;
  return atomic_load(&r->cancelled);
}

/* What an FFmpeg error means here. */
static int open_error(const CinetteRemux *r, int err) {
  if (atomic_load(&r->cancelled)) return CINETTE_REMUX_CANCELLED;
  if (err == AVERROR_HTTP_UNAUTHORIZED || err == AVERROR_HTTP_FORBIDDEN)
    return CINETTE_REMUX_REFUSED;
  return CINETTE_REMUX_UNREACHABLE;
}

int cinette_remux_open(const char *url, double start, const char *user_agent,
                       CinetteRemux **out) {
  *out = NULL;
  CinetteRemux *r = calloc(1, sizeof *r);
  if (!r) return CINETTE_REMUX_FAILED;
  atomic_init(&r->cancelled, 0);
  r->video_in = -1;
  r->audio_in = -1;
  r->video_out = -1;
  r->audio_out = -1;
  r->in = avformat_alloc_context();
  if (!r->in) {
    free(r);
    return CINETTE_REMUX_FAILED;
  }
  r->in->interrupt_callback.callback = interrupted;
  r->in->interrupt_callback.opaque = r;

  AVDictionary *options = NULL;
  av_dict_set(&options, "reconnect", "1", 0);
  av_dict_set(&options, "reconnect_delay_max", "5", 0);
  av_dict_set(&options, "rw_timeout", "15000000", 0);
  if (user_agent) av_dict_set(&options, "user_agent", user_agent, 0);
  int err = avformat_open_input(&r->in, url, NULL, &options);
  av_dict_free(&options);
  if (err < 0) {
    int code = open_error(r, err);
    free(r);
    return code;
  }
  err = avformat_find_stream_info(r->in, NULL);
  if (err < 0) {
    int code = open_error(r, err);
    cinette_remux_close(r);
    return code;
  }
  r->video_in = av_find_best_stream(r->in, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
  if (r->video_in < 0) r->video_in = -1;
  for (unsigned i = 0; i < r->in->nb_streams && r->audio_count < MAX_AUDIO; i++) {
    if (r->in->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO)
      r->audio_streams[r->audio_count++] = (int)i;
  }
  if (start > 0) {
    int64_t ts = (int64_t)(start * AV_TIME_BASE);
    // The keyframe at or before the start, so the first segment can play.
    err = avformat_seek_file(r->in, -1, INT64_MIN, ts, ts, 0);
    if (err < 0) {
      int code = open_error(r, err);
      cinette_remux_close(r);
      return code;
    }
  }
  *out = r;
  return CINETTE_REMUX_OK;
}

int cinette_remux_audio_count(const CinetteRemux *r) { return r->audio_count; }

CinetteAudioTrack cinette_remux_audio_track(const CinetteRemux *r, int index) {
  CinetteAudioTrack track = {"", NULL, 0};
  if (index < 0 || index >= r->audio_count) return track;
  const AVStream *st = r->in->streams[r->audio_streams[index]];
  track.codec = avcodec_get_name(st->codecpar->codec_id);
  const AVDictionaryEntry *language = av_dict_get(st->metadata, "language", NULL, 0);
  track.language = language ? language->value : NULL;
  track.is_default = (st->disposition & AV_DISPOSITION_DEFAULT) != 0;
  return track;
}

int cinette_remux_video(const CinetteRemux *r, const uint8_t **extradata, int *size) {
  *extradata = NULL;
  *size = 0;
  if (r->video_in < 0) return -1;
  const AVCodecParameters *par = r->in->streams[r->video_in]->codecpar;
  *extradata = par->extradata;
  *size = par->extradata_size;
  if (par->codec_id == AV_CODEC_ID_H264) return 1;
  if (par->codec_id == AV_CODEC_ID_HEVC) return 2;
  return 0;
}

double cinette_remux_duration(const CinetteRemux *r) {
  if (r->in->duration <= 0 || r->in->duration == AV_NOPTS_VALUE) return 0;
  return (double)r->in->duration / AV_TIME_BASE;
}

static int write_packet(void *opaque, const uint8_t *data, int size) {
  CinetteRemux *r = opaque;
  r->write(r->ctx, data, size);
  return size;
}

static int add_copy(CinetteRemux *r, int in_index) {
  AVStream *st = avformat_new_stream(r->out, NULL);
  if (!st) return -1;
  if (avcodec_parameters_copy(st->codecpar, r->in->streams[in_index]->codecpar) < 0) return -1;
  st->codecpar->codec_tag = 0;
  st->time_base = r->in->streams[in_index]->time_base;
  return st->index;
}

static int add_aac(CinetteRemux *r, int in_index, int downmix) {
  const AVStream *in = r->in->streams[in_index];
  const AVCodec *decoder = avcodec_find_decoder(in->codecpar->codec_id);
  const AVCodec *encoder = avcodec_find_encoder(AV_CODEC_ID_AAC);
  if (!decoder || !encoder) return -1;
  r->dec = avcodec_alloc_context3(decoder);
  r->enc = avcodec_alloc_context3(encoder);
  if (!r->dec || !r->enc) return -1;
  if (avcodec_parameters_to_context(r->dec, in->codecpar) < 0) return -1;
  r->dec->pkt_timebase = in->time_base;
  AVDictionary *options = NULL;
  // AC-3, E-AC-3 and DTS decoders mix down with the levels in the stream.
  if (downmix) av_dict_set(&options, "downmix", "stereo", 0);
  int err = avcodec_open2(r->dec, decoder, &options);
  av_dict_free(&options);
  if (err < 0) return -1;

  r->enc->sample_fmt = AV_SAMPLE_FMT_FLTP;
  r->enc->sample_rate = AAC_RATE;
  r->enc->bit_rate = AAC_BITRATE;
  r->enc->time_base = (AVRational){1, AAC_RATE};
  av_channel_layout_default(&r->enc->ch_layout, 2);
  if (avcodec_open2(r->enc, encoder, NULL) < 0) return -1;

  AVStream *st = avformat_new_stream(r->out, NULL);
  if (!st) return -1;
  if (avcodec_parameters_from_context(st->codecpar, r->enc) < 0) return -1;
  st->time_base = r->enc->time_base;
  r->fifo = av_audio_fifo_alloc(r->enc->sample_fmt, 2, r->enc->frame_size);
  r->frame = av_frame_alloc();
  if (!r->fifo || !r->frame) return -1;
  return st->index;
}

int cinette_remux_start(CinetteRemux *r, int audio, int audio_mode, int downmix, double segment,
                        cinette_remux_write_fn write, cinette_remux_cut_fn cut, void *ctx) {
  r->write = write;
  r->cut = cut;
  r->ctx = ctx;
  r->segment = segment;
  r->audio_mode = audio_mode;
  r->audio_in = (audio >= 0 && audio < r->audio_count) ? r->audio_streams[audio] : -1;
  if (r->video_in < 0 && r->audio_in < 0) return CINETTE_REMUX_FAILED;

  if (avformat_alloc_output_context2(&r->out, NULL, "mpegts", NULL) < 0) return CINETTE_REMUX_FAILED;
  uint8_t *buffer = av_malloc(IO_BUFFER);
  if (!buffer) return CINETTE_REMUX_FAILED;
  r->pb = avio_alloc_context(buffer, IO_BUFFER, 1, r, NULL, write_packet, NULL);
  if (!r->pb) {
    av_free(buffer);
    return CINETTE_REMUX_FAILED;
  }
  r->out->pb = r->pb;
  r->out->flags |= AVFMT_FLAG_CUSTOM_IO;

  if (r->video_in >= 0 && (r->video_out = add_copy(r, r->video_in)) < 0) return CINETTE_REMUX_FAILED;
  if (r->audio_in >= 0) {
    r->audio_out = audio_mode == CINETTE_AUDIO_AAC ? add_aac(r, r->audio_in, downmix)
                                                   : add_copy(r, r->audio_in);
    if (r->audio_out < 0) return CINETTE_REMUX_FAILED;
  }
  r->pkt = av_packet_alloc();
  if (!r->pkt) return CINETTE_REMUX_FAILED;
  if (avformat_write_header(r->out, NULL) < 0) return CINETTE_REMUX_FAILED;
  return CINETTE_REMUX_OK;
}

/* Ends the current segment: everything queued goes out, then the caller
 * hears how long it was. The next segment starts with the tables a
 * player needs to read it on its own. */
static int cut_segment(CinetteRemux *r, double at) {
  if (av_interleaved_write_frame(r->out, NULL) < 0) return CINETTE_REMUX_FAILED;
  av_write_frame(r->out, NULL);
  avio_flush(r->out->pb);
  double duration = at - r->segment_start;
  r->segment_start = at;
  av_opt_set(r->out->priv_data, "mpegts_flags", "+resend_headers", 0);
  if (r->cut(r->ctx, duration > 0 ? duration : 0)) return CINETTE_REMUX_CANCELLED;
  return CINETTE_REMUX_OK;
}

/* Cuts before `pkt` when it starts a new segment. Segments start at video
 * keyframes, or at any audio packet in a stream without video. */
static int maybe_cut(CinetteRemux *r, const AVPacket *pkt, AVRational tb) {
  int64_t ts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
  if (ts == AV_NOPTS_VALUE) return CINETTE_REMUX_OK;
  double t = ts * av_q2d(tb);
  r->last_time = t;
  if (r->video_in >= 0 && !(pkt->flags & AV_PKT_FLAG_KEY)) return CINETTE_REMUX_OK;
  if (!r->segment_started) {
    r->segment_started = 1;
    r->segment_start = t;
    return CINETTE_REMUX_OK;
  }
  if (t - r->segment_start >= r->segment) return cut_segment(r, t);
  return CINETTE_REMUX_OK;
}

static int write_copy(CinetteRemux *r, AVPacket *pkt, int out_index) {
  AVStream *in = r->in->streams[pkt->stream_index];
  AVStream *out = r->out->streams[out_index];
  pkt->stream_index = out_index;
  av_packet_rescale_ts(pkt, in->time_base, out->time_base);
  pkt->pos = -1;
  return av_interleaved_write_frame(r->out, pkt) < 0 ? CINETTE_REMUX_FAILED : CINETTE_REMUX_OK;
}

/* Sends the encoder's packets to the output. */
static int drain_encoder(CinetteRemux *r) {
  AVPacket *out = av_packet_alloc();
  if (!out) return CINETTE_REMUX_FAILED;
  int code = CINETTE_REMUX_OK;
  while (avcodec_receive_packet(r->enc, out) == 0) {
    out->stream_index = r->audio_out;
    av_packet_rescale_ts(out, r->enc->time_base, r->out->streams[r->audio_out]->time_base);
    if (av_interleaved_write_frame(r->out, out) < 0) {
      code = CINETTE_REMUX_FAILED;
      break;
    }
  }
  av_packet_free(&out);
  return code;
}

/* Encodes `samples` samples from the FIFO, or flushes with 0. */
static int encode(CinetteRemux *r, int samples) {
  if (samples == 0) {
    avcodec_send_frame(r->enc, NULL);
    return drain_encoder(r);
  }
  AVFrame *frame = av_frame_alloc();
  if (!frame) return CINETTE_REMUX_FAILED;
  frame->nb_samples = samples;
  frame->format = r->enc->sample_fmt;
  frame->sample_rate = r->enc->sample_rate;
  int code = CINETTE_REMUX_FAILED;
  if (av_channel_layout_copy(&frame->ch_layout, &r->enc->ch_layout) == 0 &&
      av_frame_get_buffer(frame, 0) == 0 &&
      av_audio_fifo_read(r->fifo, (void **)frame->data, samples) == samples) {
    frame->pts = r->next_audio_pts;
    r->next_audio_pts += samples;
    code = avcodec_send_frame(r->enc, frame) < 0 ? CINETTE_REMUX_FAILED : drain_encoder(r);
  }
  av_frame_free(&frame);
  return code;
}

static int convert_audio(CinetteRemux *r, const AVPacket *pkt) {
  if (avcodec_send_packet(r->dec, pkt) < 0) return CINETTE_REMUX_OK;  // a bad packet: skip it
  while (avcodec_receive_frame(r->dec, r->frame) == 0) {
    AVFrame *f = r->frame;
    if (!r->swr) {
      if (swr_alloc_set_opts2(&r->swr, &r->enc->ch_layout, r->enc->sample_fmt, AAC_RATE,
                              &f->ch_layout, f->format, f->sample_rate, 0, NULL) < 0 ||
          swr_init(r->swr) < 0)
        return CINETTE_REMUX_FAILED;
    }
    if (!r->audio_pts_set) {
      int64_t ts = f->best_effort_timestamp;
      AVRational tb = r->in->streams[r->audio_in]->time_base;
      r->next_audio_pts =
          ts == AV_NOPTS_VALUE ? 0 : av_rescale_q(ts, tb, r->enc->time_base);
      r->audio_pts_set = 1;
    }
    int room = swr_get_out_samples(r->swr, f->nb_samples);
    uint8_t **samples = NULL;
    if (room <= 0 ||
        av_samples_alloc_array_and_samples(&samples, NULL, 2, room, r->enc->sample_fmt, 0) < 0)
      return CINETTE_REMUX_FAILED;
    int made = swr_convert(r->swr, samples, room, (const uint8_t **)f->extended_data,
                           f->nb_samples);
    int stored = made > 0 ? av_audio_fifo_write(r->fifo, (void **)samples, made) : made;
    av_freep(&samples[0]);
    av_freep(&samples);
    av_frame_unref(f);
    if (stored < 0) return CINETTE_REMUX_FAILED;
    while (av_audio_fifo_size(r->fifo) >= r->enc->frame_size) {
      int code = encode(r, r->enc->frame_size);
      if (code != CINETTE_REMUX_OK) return code;
    }
  }
  return CINETTE_REMUX_OK;
}

static int finish(CinetteRemux *r) {
  if (r->enc) {
    int left = av_audio_fifo_size(r->fifo);
    if (left > 0 && encode(r, left) != CINETTE_REMUX_OK) return CINETTE_REMUX_FAILED;
    if (encode(r, 0) != CINETTE_REMUX_OK) return CINETTE_REMUX_FAILED;
  }
  if (av_interleaved_write_frame(r->out, NULL) < 0) return CINETTE_REMUX_FAILED;
  if (av_write_trailer(r->out) < 0) return CINETTE_REMUX_FAILED;
  avio_flush(r->out->pb);
  if (r->segment_started) {
    double duration = r->last_time - r->segment_start;
    r->cut(r->ctx, duration > 0 ? duration : 0);
  }
  return CINETTE_REMUX_OK;
}

int cinette_remux_run(CinetteRemux *r) {
  for (;;) {
    if (atomic_load(&r->cancelled)) return CINETTE_REMUX_CANCELLED;
    int err = av_read_frame(r->in, r->pkt);
    if (err == AVERROR_EOF) break;
    if (err < 0) return open_error(r, err);
    int code = CINETTE_REMUX_OK;
    AVPacket *pkt = r->pkt;
    AVRational tb = r->in->streams[pkt->stream_index]->time_base;
    if (pkt->stream_index == r->video_in) {
      code = maybe_cut(r, pkt, tb);
      if (code == CINETTE_REMUX_OK) code = write_copy(r, pkt, r->video_out);
    } else if (pkt->stream_index == r->audio_in) {
      if (r->video_in < 0) code = maybe_cut(r, pkt, tb);
      if (code == CINETTE_REMUX_OK)
        code = r->enc ? convert_audio(r, pkt) : write_copy(r, pkt, r->audio_out);
    }
    av_packet_unref(pkt);
    if (code != CINETTE_REMUX_OK) return code;
  }
  return finish(r);
}

void cinette_remux_cancel(CinetteRemux *r) { atomic_store(&r->cancelled, 1); }

void cinette_remux_close(CinetteRemux *r) {
  if (!r) return;
  av_packet_free(&r->pkt);
  av_frame_free(&r->frame);
  av_audio_fifo_free(r->fifo);
  swr_free(&r->swr);
  avcodec_free_context(&r->dec);
  avcodec_free_context(&r->enc);
  if (r->out) {
    avformat_free_context(r->out);
  }
  if (r->pb) {
    av_freep(&r->pb->buffer);
    avio_context_free(&r->pb);
  }
  avformat_close_input(&r->in);
  free(r);
}
