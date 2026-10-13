// The device side of Adam's home-device link: everything a board needs to talk to Adam that is not
// radio, audio hardware or HTTP. Plain C, no heap, no OS, host-tested (`make test`).
//
//   POST /display/{id}/voice   body: 16 kHz mono 16-bit WAV  ->  reply: same format, play it as is
//   POST /display/{id}/sounds  body: {"events":[{"sound","kind","confidence","occurredAt"}]}
//   Authorization: Bearer {token}   (from pairing; see README.md)
//
// The server owns wording, ids, approval and whether to interrupt anyone. The device sends only
// sound keys from its detectors and scores, so it can never put its own words in front of people.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "alarm_pattern.h"
#include "sound_events.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ADAM_SAMPLE_RATE 16000
#define ADAM_WAV_HEADER_BYTES 44
#define ADAM_MAX_CAPTURE_SECONDS 15
#define ADAM_SOUND_QUEUE 16
#define ADAM_SOUND_MAX_AGE_MS (14u * 60u * 1000u)   // server refuses anything older than 15 min
#define ADAM_SOUND_DEDUPE_MS (15u * 60u * 1000u)     // server ids are 15-minute buckets anyway

// ---- WAV --------------------------------------------------------------------------------------

// Header for a capture of pcm_bytes of 16 kHz mono 16-bit samples. Write it, then the samples.
void adam_wav_header(uint8_t out[ADAM_WAV_HEADER_BYTES], uint32_t pcm_bytes);

// Finds the samples in a reply. Walks chunks (no fixed 44-byte assumption). Returns 0 and sets
// *pcm/*pcm_bytes when the reply is 16 kHz mono 16-bit PCM; -1 for anything else.
int adam_wav_samples(const uint8_t *wav, size_t len, const uint8_t **pcm, size_t *pcm_bytes);

// ---- Streamed replies ----------------------------------------------------------------------
//
// POST /display/{id}/voice?stream=1 answers with raw 16 kHz 16-bit mono PCM (audio/L16) as Adam's
// reply is synthesised. The network task writes whatever each read returns into a ring; the speaker
// task reads whole samples from it. Reads return nothing until `preroll` bytes are buffered (or the
// stream has ended), so a slow first packet doesn't start playback only to stutter.

typedef struct {
    uint8_t *mem;
    size_t size, head, count;  // bytes
    size_t preroll;
    uint8_t carry, has_carry;  // half of a sample split across two network reads
    uint8_t started, finished;
    uint32_t underruns;        // times the speaker caught up with the network mid-reply
} adam_ring_t;

// mem: caller-owned buffer (PSRAM is fine); size must be even. preroll_ms: e.g. 250.
void adam_ring_init(adam_ring_t *r, uint8_t *mem, size_t size, uint32_t preroll_ms);
// Copies as many bytes as fit (odd-sized writes are fine); returns how many were taken. The caller
// retries the rest after the speaker has drained some.
size_t adam_ring_write(adam_ring_t *r, const uint8_t *data, size_t n);
// The network is done (or failed): play out what is left, pre-roll or not.
void adam_ring_finish(adam_ring_t *r);
// Up to max_bytes of whole samples (always even); 0 while pre-rolling or empty.
size_t adam_ring_read(adam_ring_t *r, uint8_t *out, size_t max_bytes);
// Everything received has been played.
int adam_ring_done(const adam_ring_t *r);

// ---- Sounds -----------------------------------------------------------------------------------

typedef struct {
    const char *key;      // server key, e.g. "smoke_alarm"
    uint8_t sustained;
    float confidence;
    uint64_t at_ms;       // unix milliseconds (from SNTP); 0 if the clock was not yet set
} adam_sound_t;

typedef struct {
    adam_sound_t items[ADAM_SOUND_QUEUE];
    int head, count;
    uint32_t dropped;     // overwritten because the queue was full (oldest first)
} adam_sound_queue_t;

void adam_sounds_init(adam_sound_queue_t *q);
// Queues one detection. A repeat of the same key and kind inside ADAM_SOUND_DEDUPE_MS is dropped
// (returns 0); otherwise returns 1.
int adam_sounds_push(adam_sound_queue_t *q, const char *key, int sustained, float confidence, uint64_t at_ms);
// Server key for a beep-pattern alarm, or NULL for ALARM_NONE.
const char *adam_alarm_key(alarm_kind_t kind);
// Queues every event se_update() returned; cfg is the same table passed to se_init().
int adam_sounds_push_model(adam_sound_queue_t *q, const se_class_cfg_t *cfg, int classes,
                           const se_event_t *events, int n, uint64_t at_ms);

// Writes the request body for everything still worth sending (drops what the server would refuse
// as too old, and anything recorded before the clock was set). Returns the number of events in
// the body (0 = nothing to send) and stores how many queue entries it covered in *covered, to pass
// to adam_sounds_sent() after a 2xx. Returns -1 if out is too small.
int adam_sounds_body(adam_sound_queue_t *q, uint64_t now_ms, char *out, size_t cap, int *covered);
void adam_sounds_sent(adam_sound_queue_t *q, int covered);

// ---- Link state -------------------------------------------------------------------------------

typedef enum { ADAM_LINK_OK = 0, ADAM_LINK_RETRY, ADAM_LINK_UNPAIRED, ADAM_LINK_REJECTED } adam_link_result_t;

typedef struct {
    uint32_t failures;
    uint64_t retry_at_ms;   // monotonic ms; don't send before this
    uint8_t unpaired;       // the token was refused: stop, forget it, show "pair again"
    uint8_t ever_ok;
    uint64_t last_ok_ms;    // monotonic ms of the last 2xx from Adam, of any kind
} adam_link_t;

// The app shows the device online while Adam has heard from it in the last 3 minutes. Any request
// that succeeds counts; a heartbeat (POST /display/{id}/heartbeat) fills the gaps.
#define ADAM_HEARTBEAT_MS 60000u

void adam_link_init(adam_link_t *link);
// Feed every HTTP outcome (status 0 = no response). jitter_ms: any value in [0, 1000) from a
// random source, so a houseful of devices don't retry in lockstep after an outage.
adam_link_result_t adam_link_result(adam_link_t *link, int http_status, uint64_t now_ms, uint32_t jitter_ms);
int adam_link_may_send(const adam_link_t *link, uint64_t now_ms);
// A heartbeat is due when nothing has succeeded for ADAM_HEARTBEAT_MS (and the link may send).
int adam_link_heartbeat_due(const adam_link_t *link, uint64_t now_ms);

// ISO-8601 UTC with milliseconds, e.g. 2026-10-13T09:59:30.250Z. out needs 25 bytes.
void adam_iso8601(uint64_t unix_ms, char out[25]);

#ifdef __cplusplus
}
#endif
