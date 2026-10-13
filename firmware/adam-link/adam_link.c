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

void adam_ring_init(adam_ring_t *r, uint8_t *mem, size_t size, uint32_t preroll_ms) {
    memset(r, 0, sizeof *r);
    r->mem = mem;
    r->size = size & ~(size_t)1;
    r->preroll = (size_t)preroll_ms * ADAM_SAMPLE_RATE / 1000 * 2;
    if (r->preroll > r->size / 2) r->preroll = r->size / 2;
}

static void ring_put(adam_ring_t *r, uint8_t byte) {
    r->mem[(r->head + r->count) % r->size] = byte;
    r->count++;
}

size_t adam_ring_write(adam_ring_t *r, const uint8_t *data, size_t n) {
    size_t taken = 0;
    // Keep the ring holding whole samples only: a lone byte waits in `carry` for its partner.
    while (taken < n) {
        if (r->has_carry) {
            if (r->size - r->count < 2) break;
            ring_put(r, r->carry);
            ring_put(r, data[taken++]);
            r->has_carry = 0;
        } else if (n - taken >= 2) {
            if (r->size - r->count < 2) break;
            ring_put(r, data[taken++]);
            ring_put(r, data[taken++]);
        } else {
            r->carry = data[taken++];
            r->has_carry = 1;
        }
    }
    return taken;
}

void adam_ring_finish(adam_ring_t *r) { r->finished = 1; }

size_t adam_ring_read(adam_ring_t *r, uint8_t *out, size_t max_bytes) {
    if (!r->started) {
        if (r->count < r->preroll && !r->finished) return 0;
        r->started = 1;
    }
    size_t n = r->count < max_bytes ? r->count : max_bytes;
    n &= ~(size_t)1;
    if (!n) {
        if (!r->finished) r->underruns++;
        return 0;
    }
    for (size_t i = 0; i < n; i++) out[i] = r->mem[(r->head + i) % r->size];
    r->head = (r->head + n) % r->size;
    r->count -= n;
    return n;
}

int adam_ring_done(const adam_ring_t *r) { return r->finished && r->count == 0; }

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
        link->ever_ok = 1;
        link->last_ok_ms = now_ms;
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

int adam_link_heartbeat_due(const adam_link_t *link, uint64_t now_ms) {
    if (!adam_link_may_send(link, now_ms)) return 0;
    return !link->ever_ok || now_ms < link->last_ok_ms || now_ms - link->last_ok_ms >= ADAM_HEARTBEAT_MS;
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

// ---- Pairing from the device ------------------------------------------------------------------

static const char *skip_ws(const char *s) {
    while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
    return s;
}

// Reads a JSON string starting at the opening quote. Writes up to cap - 1 bytes (if out) and returns
// the pointer past the closing quote, or NULL. *len is the unescaped length; *ok is 0 if it did not fit
// or used an escape we don't decode.
static const char *read_string(const char *s, char *out, size_t cap, size_t *len, int *ok) {
    *len = 0;
    *ok = 1;
    if (*s++ != '"') return NULL;
    while (*s && *s != '"') {
        char ch = *s++;
        if (ch == '\\') {
            ch = *s++;
            if (ch != '"' && ch != '\\' && ch != '/') {
                *ok = 0;
                if (!ch) return NULL;
                if (ch == 'u') for (int i = 0; i < 4 && *s; i++) s++;
            }
        } else if ((unsigned char)ch < 0x20) {
            return NULL;
        }
        if (out && *len + 1 < cap) out[*len] = ch;
        else *ok = 0;
        (*len)++;
    }
    if (*s != '"') return NULL;
    if (out && cap) out[*len < cap ? *len : cap - 1] = '\0';
    return s + 1;
}

// Skips any JSON value; NULL if malformed.
static const char *skip_value(const char *s) {
    s = skip_ws(s);
    size_t len;
    int ok;
    if (*s == '"') return read_string(s, NULL, 0, &len, &ok);
    if (*s == '{' || *s == '[') {
        int depth = 0;
        while (*s) {
            if (*s == '"') { s = read_string(s, NULL, 0, &len, &ok); if (!s) return NULL; continue; }
            if (*s == '{' || *s == '[') depth++;
            else if (*s == '}' || *s == ']') { if (--depth == 0) return s + 1; }
            s++;
        }
        return NULL;
    }
    const char *start = s;
    while (*s && *s != ',' && *s != '}' && *s != ']' && *s != ' ' && *s != '\n' && *s != '\r' && *s != '\t') s++;
    return s == start ? NULL : s;
}

// Finds the value of a top-level key; NULL if absent or malformed.
static const char *find_key(const char *json, const char *key) {
    const char *s = skip_ws(json);
    if (*s++ != '{') return NULL;
    char name[32];
    for (;;) {
        s = skip_ws(s);
        if (*s == '}') return NULL;
        size_t len;
        int ok;
        s = read_string(s, name, sizeof name, &len, &ok);
        if (!s) return NULL;
        s = skip_ws(s);
        if (*s++ != ':') return NULL;
        s = skip_ws(s);
        if (ok && !strcmp(name, key)) return s;
        s = skip_value(s);
        if (!s) return NULL;
        s = skip_ws(s);
        if (*s == ',') s++;
        else if (*s != '}') return NULL;
    }
}

int adam_json_string(const char *json, const char *key, char *out, size_t cap) {
    const char *v = json ? find_key(json, key) : NULL;
    if (!v || *v != '"' || !cap) return -1;
    size_t len;
    int ok;
    if (!read_string(v, out, cap, &len, &ok) || !ok) { out[0] = '\0'; return -1; }
    return (int)len;
}

static int json_uint(const char *json, const char *key, uint32_t *value) {
    const char *v = find_key(json, key);
    if (!v || *v < '0' || *v > '9') return -1;
    uint32_t n = 0;
    while (*v >= '0' && *v <= '9' && n < 100000) n = n * 10 + (uint32_t)(*v++ - '0');
    *value = n;
    return 0;
}

// Writes s as a JSON string (quotes included). Control characters are dropped. -1 if it doesn't fit.
static int put_json_string(char *out, size_t cap, size_t *at, const char *s) {
    if (*at + 1 >= cap) return -1;
    out[(*at)++] = '"';
    for (; *s; s++) {
        unsigned char ch = (unsigned char)*s;
        if (ch < 0x20) continue;
        if (ch == '"' || ch == '\\') { if (*at + 1 >= cap) return -1; out[(*at)++] = '\\'; }
        if (*at + 1 >= cap) return -1;
        out[(*at)++] = (char)ch;
    }
    if (*at + 1 >= cap) return -1;
    out[(*at)++] = '"';
    out[*at] = '\0';
    return 0;
}

static int put_raw(char *out, size_t cap, size_t *at, const char *s) {
    size_t n = strlen(s);
    if (*at + n >= cap) return -1;
    memcpy(out + *at, s, n + 1);
    *at += n;
    return 0;
}

int adam_pair_start_body(const char *name, char *out, size_t cap) {
    size_t at = 0;
    if (put_raw(out, cap, &at, "{\"name\":") || put_json_string(out, cap, &at, name ? name : "") ||
        put_raw(out, cap, &at, "}")) return -1;
    return (int)at;
}

int adam_pair_poll_body(const adam_pairing_t *p, char *out, size_t cap) {
    size_t at = 0;
    if (put_raw(out, cap, &at, "{\"requestId\":") || put_json_string(out, cap, &at, p->request_id) ||
        put_raw(out, cap, &at, ",\"pollSecret\":") || put_json_string(out, cap, &at, p->poll_secret) ||
        put_raw(out, cap, &at, "}")) return -1;
    return (int)at;
}

int adam_pair_parse_start(const char *json, adam_pairing_t *p) {
    memset(p, 0, sizeof *p);
    uint32_t seconds = 3;
    if (!json || adam_json_string(json, "requestId", p->request_id, sizeof p->request_id) <= 0 ||
        adam_json_string(json, "pollSecret", p->poll_secret, sizeof p->poll_secret) <= 0 ||
        adam_json_string(json, "code", p->code, sizeof p->code) <= 0) {
        memset(p, 0, sizeof *p);
        return -1;
    }
    json_uint(json, "pollSeconds", &seconds);
    if (seconds < 1) seconds = 1;
    if (seconds > 30) seconds = 30;
    p->poll_ms = seconds * 1000u;
    return 0;
}

adam_pair_status_t adam_pair_parse_poll(int http_status, const char *json,
                                        char *display_id, size_t id_cap, char *token, size_t token_cap) {
    char status[16];
    if (display_id && id_cap) display_id[0] = '\0';
    if (token && token_cap) token[0] = '\0';
    if (http_status >= 400 && http_status < 500 && http_status != 429) return ADAM_PAIR_EXPIRED;
    if (http_status != 200 || !json || adam_json_string(json, "status", status, sizeof status) < 0) return ADAM_PAIR_BAD;
    if (!strcmp(status, "pending")) return ADAM_PAIR_PENDING;
    if (!strcmp(status, "expired")) return ADAM_PAIR_EXPIRED;
    if (strcmp(status, "paired")) return ADAM_PAIR_BAD;
    if (adam_json_string(json, "displayId", display_id, id_cap) <= 0 ||
        adam_json_string(json, "token", token, token_cap) <= 0) {
        if (display_id && id_cap) display_id[0] = '\0';
        if (token && token_cap) token[0] = '\0';
        return ADAM_PAIR_BAD;
    }
    return ADAM_PAIR_PAIRED;
}
