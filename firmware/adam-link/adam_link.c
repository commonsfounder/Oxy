#include "adam_link.h"
#include <stdio.h>
#include <string.h>

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)v); put16(p + 2, (uint16_t)(v >> 16)); }
static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t get32(const uint8_t *p) { return (uint32_t)get16(p) | ((uint32_t)get16(p + 2) << 16); }

void adam_wav_header(uint8_t out[ADAM_WAV_HEADER_BYTES], uint32_t pcm_bytes) {
    memcpy(out, "RIFF", 4);
    put32(out + 4, 36 + pcm_bytes);
    memcpy(out + 8, "WAVEfmt ", 8);
    put32(out + 16, 16);
    put16(out + 20, 1);                      // PCM
    put16(out + 22, 1);                      // mono
    put32(out + 24, ADAM_SAMPLE_RATE);
    put32(out + 28, ADAM_SAMPLE_RATE * 2);
    put16(out + 32, 2);
    put16(out + 34, 16);
    memcpy(out + 36, "data", 4);
    put32(out + 40, pcm_bytes);
}

int adam_wav_samples(const uint8_t *wav, size_t len, const uint8_t **pcm, size_t *pcm_bytes) {
    if (!wav || len < 12 || memcmp(wav, "RIFF", 4) || memcmp(wav + 8, "WAVE", 4)) return -1;
    int format_ok = 0;
    size_t off = 12;
    while (off + 8 <= len) {
        uint32_t size = get32(wav + off + 4);
        size_t body = off + 8;
        if (!memcmp(wav + off, "fmt ", 4)) {
            if (size < 16 || body + 16 > len) return -1;
            format_ok = get16(wav + body) == 1 && get16(wav + body + 2) == 1 &&
                        get32(wav + body + 4) == ADAM_SAMPLE_RATE && get16(wav + body + 14) == 16;
        } else if (!memcmp(wav + off, "data", 4)) {
            if (!format_ok) return -1;
            size_t avail = len - body;
            size_t n = (size == 0 || size == 0xFFFFFFFFu || size > avail) ? avail : size;
            *pcm = wav + body;
            *pcm_bytes = n & ~(size_t)1;
            return 0;
        }
        if (size > len - body) return -1;
        off = body + size + (size & 1);
    }
    return -1;
}

void adam_sounds_init(adam_sound_queue_t *q) { memset(q, 0, sizeof *q); }

static adam_sound_t *at(adam_sound_queue_t *q, int i) { return &q->items[(q->head + i) % ADAM_SOUND_QUEUE]; }

int adam_sounds_push(adam_sound_queue_t *q, const char *key, int sustained, float confidence, uint64_t at_ms) {
    if (!key) return 0;
    for (int i = 0; i < q->count; i++) {
        adam_sound_t *s = at(q, i);
        if (s->sustained == (sustained != 0) && !strcmp(s->key, key) && s->at_ms && at_ms &&
            at_ms >= s->at_ms && at_ms - s->at_ms < ADAM_SOUND_DEDUPE_MS) {
            if (confidence > s->confidence) s->confidence = confidence;
            return 0;
        }
    }
    if (q->count == ADAM_SOUND_QUEUE) {          // full: lose the oldest, keep the newest
        q->head = (q->head + 1) % ADAM_SOUND_QUEUE;
        q->count--;
        q->dropped++;
    }
    adam_sound_t *slot = at(q, q->count++);
    slot->key = key;
    slot->sustained = sustained != 0;
    slot->confidence = confidence < 0 ? 0 : confidence > 1 ? 1 : confidence;
    slot->at_ms = at_ms;
    return 1;
}

const char *adam_alarm_key(alarm_kind_t kind) {
    switch (kind) {
    case ALARM_SMOKE: return "smoke_alarm";
    case ALARM_CARBON_MONOXIDE: return "carbon_monoxide_alarm";
    case ALARM_SUSTAINED_BEEPING: return "sustained_beeping";
    default: return NULL;
    }
}

int adam_sounds_push_model(adam_sound_queue_t *q, const se_class_cfg_t *cfg, int classes,
                           const se_event_t *events, int n, uint64_t at_ms) {
    int queued = 0;
    for (int i = 0; i < n; i++) {
        if (events[i].class_index < 0 || events[i].class_index >= classes) continue;
        queued += adam_sounds_push(q, cfg[events[i].class_index].name, events[i].kind == SE_SUSTAINED,
                                   events[i].confidence, at_ms);
    }
    return queued;
}

int adam_sounds_body(adam_sound_queue_t *q, uint64_t now_ms, char *out, size_t cap, int *covered) {
    // Drop from the front what can never be accepted: too old, or stamped before the clock was set.
    while (q->count) {
        const adam_sound_t *s = at(q, 0);
        int stale = !s->at_ms || (now_ms >= s->at_ms && now_ms - s->at_ms > ADAM_SOUND_MAX_AGE_MS);
        if (!stale) break;
        q->head = (q->head + 1) % ADAM_SOUND_QUEUE;
        q->count--;
    }
    *covered = 0;
    size_t used = 0;
    int n = snprintf(out, cap, "{\"events\":[");
    if (n < 0 || (size_t)n >= cap) return -1;
    used = (size_t)n;
    int events = 0;
    for (int i = 0; i < q->count && events < 12; i++) {
        const adam_sound_t *s = at(q, i);
        *covered = i + 1;
        if (!s->at_ms || (now_ms >= s->at_ms && now_ms - s->at_ms > ADAM_SOUND_MAX_AGE_MS)) continue;
        char when[25];
        adam_iso8601(s->at_ms, when);
        n = snprintf(out + used, cap - used, "%s{\"sound\":\"%s\",\"kind\":\"%s\",\"confidence\":%.3f,\"occurredAt\":\"%s\"}",
                     events ? "," : "", s->key, s->sustained ? "sustained" : "heard", (double)s->confidence, when);
        if (n < 0 || (size_t)n >= cap - used) return -1;
        used += (size_t)n;
        events++;
    }
    n = snprintf(out + used, cap - used, "]}");
    if (n < 0 || (size_t)n >= cap - used) return -1;
    return events;
}

void adam_sounds_sent(adam_sound_queue_t *q, int covered) {
    if (covered < 0) covered = 0;
    if (covered > q->count) covered = q->count;
    q->head = (q->head + covered) % ADAM_SOUND_QUEUE;
    q->count -= covered;
}

void adam_link_init(adam_link_t *link) { memset(link, 0, sizeof *link); }

adam_link_result_t adam_link_result(adam_link_t *link, int status, uint64_t now_ms, uint32_t jitter_ms) {
    if (status >= 200 && status < 300) {
        link->failures = 0;
        link->retry_at_ms = 0;
        return ADAM_LINK_OK;
    }
    if (status == 401 || status == 403) {
        link->unpaired = 1;
        return ADAM_LINK_UNPAIRED;
    }
    if (status >= 400 && status < 500 && status != 408 && status != 429) return ADAM_LINK_REJECTED;
    // No response, timeout, rate limit or server error: back off 1, 2, 4 … 60 s, plus jitter.
    uint32_t shift = link->failures < 6 ? link->failures : 6;
    uint64_t wait = (uint64_t)1000 << shift;
    if (wait > 60000) wait = 60000;
    if (link->failures < 0xFFFFFFFFu) link->failures++;
    link->retry_at_ms = now_ms + wait + (jitter_ms % 1000);
    return ADAM_LINK_RETRY;
}

int adam_link_may_send(const adam_link_t *link, uint64_t now_ms) {
    return !link->unpaired && now_ms >= link->retry_at_ms;
}

// Days since 1970-01-01 -> civil date (Howard Hinnant's algorithm); no gmtime needed.
void adam_iso8601(uint64_t unix_ms, char out[25]) {
    uint64_t secs = unix_ms / 1000;
    unsigned ms = (unsigned)(unix_ms % 1000);
    int64_t z = (int64_t)(secs / 86400) + 719468;
    unsigned rem = (unsigned)(secs % 86400);
    int64_t era = z / 146097;
    unsigned doe = (unsigned)(z - era * 146097);
    unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t y = (int64_t)yoe + era * 400;
    unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    unsigned mp = (5 * doy + 2) / 153;
    unsigned d = doy - (153 * mp + 2) / 5 + 1;
    unsigned m = mp < 10 ? mp + 3 : mp - 9;
    if (m <= 2) y++;
    char tmp[64];   // roomy so the compiler can prove no truncation; the result is always 24 chars here
    snprintf(tmp, sizeof tmp, "%04d-%02u-%02uT%02u:%02u:%02u.%03uZ", (int)(y % 10000), m, d, rem / 3600, (rem / 60) % 60, rem % 60, ms);
    memcpy(out, tmp, 24);
    out[24] = '\0';
}
