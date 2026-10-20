// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Writes small MPEG-TS files for the tests: H.264 from libx264 and MP2
// audio, with the keyframe spacing, channel count and timestamps a test
// asks for. Only Linux test builds compile it, against the system's
// FFmpeg. It isn't in native/, so the iOS app never gets it.

#include <stdint.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>

#define FPS 25
#define SIZE 64
#define RATE 48000

/* Sends `frame`, or NULL to flush, and writes what comes out. */
static int send(AVFormatContext *fmt, AVCodecContext *enc, AVStream *st, AVFrame *frame) {
  int err = avcodec_send_frame(enc, frame);
  if (err < 0) return err;
  AVPacket *pkt = av_packet_alloc();
  if (!pkt) return AVERROR(ENOMEM);
  while ((err = avcodec_receive_packet(enc, pkt)) == 0) {
    av_packet_rescale_ts(pkt, enc->time_base, st->time_base);
    pkt->stream_index = st->index;
    err = av_interleaved_write_frame(fmt, pkt);
    if (err < 0) break;
  }
  av_packet_free(&pkt);
  return err == AVERROR(EAGAIN) || err == AVERROR_EOF ? 0 : err;
}

static AVStream *add_stream(AVFormatContext *fmt, AVCodecContext *enc) {
  AVStream *st = avformat_new_stream(fmt, NULL);
  if (!st || avcodec_parameters_from_context(st->codecpar, enc) < 0) return NULL;
  st->time_base = enc->time_base;
  return st;
}

/* Writes `seconds` of media to `path`. `h264` adds 64x64 H.264 video at 25
 * frames a second with a keyframe every `gop` frames, `channels` adds MP2
 * audio with that many channels at 48 kHz, and every timestamp is moved by
 * `ts_offset` seconds. Returns 0, -2 when libx264 is missing, or -1. */
int cinette_test_write_ts(const char *path, double seconds, int h264, int gop, int channels,
                          double ts_offset) {
  AVFormatContext *fmt = NULL;
  AVCodecContext *venc = NULL, *aenc = NULL;
  AVStream *vst = NULL, *ast = NULL;
  AVFrame *vframe = NULL, *aframe = NULL;
  int code = -1;
  if (avformat_alloc_output_context2(&fmt, NULL, "mpegts", path) < 0) return -1;
  fmt->output_ts_offset = (int64_t)(ts_offset * AV_TIME_BASE);

  if (h264) {
    const AVCodec *codec = avcodec_find_encoder_by_name("libx264");
    if (!codec) {
      code = -2;
      goto done;
    }
    venc = avcodec_alloc_context3(codec);
    if (!venc) goto done;
    venc->width = SIZE;
    venc->height = SIZE;
    venc->pix_fmt = AV_PIX_FMT_YUV420P;
    venc->time_base = (AVRational){1, FPS};
    venc->framerate = (AVRational){FPS, 1};
    venc->gop_size = gop;
    venc->keyint_min = gop;
    venc->max_b_frames = 0;
    av_opt_set(venc->priv_data, "preset", "ultrafast", 0);
    // Keyframes only where the test asks for them.
    av_opt_set(venc->priv_data, "x264-params", "scenecut=0", 0);
    if (avcodec_open2(venc, codec, NULL) < 0 || !(vst = add_stream(fmt, venc))) goto done;
    vframe = av_frame_alloc();
    if (!vframe) goto done;
    vframe->format = venc->pix_fmt;
    vframe->width = SIZE;
    vframe->height = SIZE;
    if (av_frame_get_buffer(vframe, 0) < 0) goto done;
  }
  if (channels > 0) {
    const AVCodec *codec = avcodec_find_encoder(AV_CODEC_ID_MP2);
    if (!codec || !(aenc = avcodec_alloc_context3(codec))) goto done;
    aenc->sample_fmt = AV_SAMPLE_FMT_S16;
    aenc->sample_rate = RATE;
    aenc->bit_rate = 128000;
    aenc->time_base = (AVRational){1, RATE};
    av_channel_layout_default(&aenc->ch_layout, channels);
    if (avcodec_open2(aenc, codec, NULL) < 0 || !(ast = add_stream(fmt, aenc))) goto done;
    aframe = av_frame_alloc();
    if (!aframe) goto done;
    aframe->format = aenc->sample_fmt;
    aframe->sample_rate = RATE;
    aframe->nb_samples = aenc->frame_size;
    if (av_channel_layout_copy(&aframe->ch_layout, &aenc->ch_layout) < 0 ||
        av_frame_get_buffer(aframe, 0) < 0)
      goto done;
  }
  if (avio_open(&fmt->pb, path, AVIO_FLAG_WRITE) < 0) goto done;
  if (avformat_write_header(fmt, NULL) < 0) goto done;

  int frames = (int)(seconds * FPS);
  int64_t samples = 0;
  for (int i = 0; i < frames; i++) {
    if (vframe) {
      if (av_frame_make_writable(vframe) < 0) goto done;
      for (int y = 0; y < SIZE; y++)
        for (int x = 0; x < SIZE; x++)
          vframe->data[0][y * vframe->linesize[0] + x] = (uint8_t)(x + y + i * 3);
      for (int p = 1; p < 3; p++)
        for (int y = 0; y < SIZE / 2; y++)
          for (int x = 0; x < SIZE / 2; x++) vframe->data[p][y * vframe->linesize[p] + x] = 128;
      vframe->pts = i;
      if (send(fmt, venc, vst, vframe) < 0) goto done;
    }
    // The audio up to the end of this video frame.
    while (aframe && samples < (int64_t)(i + 1) * RATE / FPS) {
      if (av_frame_make_writable(aframe) < 0) goto done;
      int16_t *data = (int16_t *)aframe->data[0];
      for (int n = 0; n < aframe->nb_samples * channels; n++) data[n] = (int16_t)((n % 64) * 200);
      aframe->pts = samples;
      samples += aframe->nb_samples;
      if (send(fmt, aenc, ast, aframe) < 0) goto done;
    }
  }
  if (venc && send(fmt, venc, vst, NULL) < 0) goto done;
  if (aenc && send(fmt, aenc, ast, NULL) < 0) goto done;
  if (av_write_trailer(fmt) < 0) goto done;
  code = 0;

done:
  av_frame_free(&vframe);
  av_frame_free(&aframe);
  avcodec_free_context(&venc);
  avcodec_free_context(&aenc);
  if (fmt && fmt->pb) avio_closep(&fmt->pb);
  avformat_free_context(fmt);
  return code;
}
