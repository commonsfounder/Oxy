// ESP-IDF glue for adam_link: Wi-Fi and pairing from NVS, SNTP, and the two HTTPS calls.
// Board audio (I2S capture, codec playback) stays in the board firmware; this file never touches it.
//
//   adam_net_t net;
//   ESP_ERROR_CHECK(adam_net_start(&net));                      // NVS, Wi-Fi, SNTP
//   // push-to-talk released: pcm holds the recording (16 kHz mono int16)
//   size_t got; int status;
//   adam_net_voice(&net, pcm, samples, reply, reply_cap, &got, &status);
//   const uint8_t *speech; size_t bytes;
//   if (status == 200 && adam_wav_samples(reply, got, &speech, &bytes) == 0) board_play(speech, bytes);
//   // every second or so, from the task that runs the detectors:
//   adam_net_flush_sounds(&net);
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "adam_link.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char base_url[128];
    char display_id[64];
    char token[96];
    adam_link_t link;
    adam_sound_queue_t sounds;
} adam_net_t;

// Reads namespace "adam" (written by scripts/home-device.js nvs), joins Wi-Fi and starts SNTP.
// ESP_ERR_NOT_FOUND: no Wi-Fi or server in NVS. ESP_OK with adam_net_paired() false: online but not
// paired yet; call adam_net_pair().
esp_err_t adam_net_start(adam_net_t *net);
int adam_net_paired(const adam_net_t *net);

// Pairs from the device: asks Adam for a code, calls show_code("ABC DEF") so the board can draw it
// (and again with a fresh code if the old one expires), and polls until the person types it into the
// app. Saves the display id and token to NVS. Blocks; run it from a task, not the audio path.
// Gives up after `minutes` (0: keep trying) with ESP_ERR_TIMEOUT.
typedef void (*adam_show_code_fn)(const char *code, void *ctx);
esp_err_t adam_net_pair(adam_net_t *net, const char *name, adam_show_code_fn show_code, void *ctx, uint32_t minutes);

// One spoken turn. Sends the recording as WAV and reads Adam's spoken reply (16 kHz mono WAV) into
// reply. *status is the HTTP status (0 if no response). A 401 forgets the pairing.
esp_err_t adam_net_voice(adam_net_t *net, const int16_t *pcm, size_t samples,
                         uint8_t *reply, size_t reply_cap, size_t *reply_len, int *status);

// The same turn with the reply streamed: Adam's speech arrives as raw 16 kHz PCM while it is being
// synthesised and is written into `ring` as it comes; run the speaker task on adam_ring_read() at the
// same time so playback starts after the ring's pre-roll instead of after the whole download.
// The ring is finished when the reply ends or fails.
esp_err_t adam_net_voice_stream(adam_net_t *net, const int16_t *pcm, size_t samples, adam_ring_t *ring, int *status);

// Queue detections (thread-safe), then send whatever is due. Cheap to call often: it does nothing
// while the queue is empty or the link is backing off.
void adam_net_heard_alarm(adam_net_t *net, alarm_kind_t kind);
void adam_net_heard_model(adam_net_t *net, const se_class_cfg_t *cfg, int classes, const se_event_t *events, int n);
esp_err_t adam_net_flush_sounds(adam_net_t *net);

// Tells Adam the device is still there when nothing else has gone out for a minute. Call it from
// any loop that runs at least every few seconds; it sends only when due.
esp_err_t adam_net_heartbeat(adam_net_t *net);

uint64_t adam_net_unix_ms(void);   // 0 until SNTP has set the clock

#ifdef __cplusplus
}
#endif
