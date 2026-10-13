#include "adam_link.h"
#include "../sound-events/sound_events_config.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static const uint64_t T0 = 1791885570250ull;   // 2026-10-13T09:59:30.250Z

static void test_iso8601(void) {
    char s[25];
    adam_iso8601(0, s);
    assert(!strcmp(s, "1970-01-01T00:00:00.000Z"));
    adam_iso8601(T0, s);
    assert(!strcmp(s, "2026-10-13T09:59:30.250Z"));
    adam_iso8601(951782400000ull, s);            // leap day
    assert(!strcmp(s, "2000-02-29T00:00:00.000Z"));
    adam_iso8601(4102444799999ull, s);
    assert(!strcmp(s, "2099-12-31T23:59:59.999Z"));
}

static void test_wav(void) {
    uint8_t buf[ADAM_WAV_HEADER_BYTES + 8] = {0};
    adam_wav_header(buf, 8);
    assert(!memcmp(buf, "RIFF", 4) && buf[24] == 0x80 && buf[25] == 0x3E);   // 16000
    const uint8_t *pcm; size_t n;
    assert(adam_wav_samples(buf, sizeof buf, &pcm, &n) == 0 && n == 8 && pcm == buf + 44);

    // A LIST chunk before the data, and a streamed (0xFFFFFFFF) data size.
    uint8_t big[44 + 12 + 6];
    adam_wav_header(big, 6);
    memmove(big + 36 + 12, big + 36, 8);
    memcpy(big + 36, "LIST\x04\x00\x00\x00INFO", 12);
    memset(big + 36 + 12 + 4, 0xFF, 4);
    assert(adam_wav_samples(big, sizeof big, &pcm, &n) == 0 && n == 6);

    uint8_t wrong[ADAM_WAV_HEADER_BYTES + 4];
    adam_wav_header(wrong, 4);
    wrong[24] = 0xC0; wrong[25] = 0x5D;            // 24000 Hz: the device can't play it as is
    assert(adam_wav_samples(wrong, sizeof wrong, &pcm, &n) == -1);
    assert(adam_wav_samples((const uint8_t *)"nonsense", 8, &pcm, &n) == -1);
}

static void test_sounds(void) {
    adam_sound_queue_t q;
    adam_sounds_init(&q);
    char body[2048];
    int covered;

    assert(adam_sounds_push(&q, adam_alarm_key(ALARM_SMOKE), 0, 0.95f, T0) == 1);
    assert(adam_sounds_push(&q, "smoke_alarm", 0, 0.97f, T0 + 5000) == 0);      // same alarm, same window
    assert(adam_alarm_key(ALARM_NONE) == NULL);

    se_event_t ev[2] = {{6, SE_HEARD, 0.93f}, {14, SE_SUSTAINED, 0.99f}};     // glass_breaking, water_running
    assert(adam_sounds_push_model(&q, SOUND_EVENT_CONFIG, SOUND_EVENT_CLASSES, ev, 2, T0 + 1000) == 2);

    assert(adam_sounds_body(&q, T0 + 2000, body, sizeof body, &covered) == 3 && covered == 3);
    assert(!strcmp(body,
        "{\"events\":["
        "{\"sound\":\"smoke_alarm\",\"kind\":\"heard\",\"confidence\":0.970,\"occurredAt\":\"2026-10-13T09:59:30.250Z\"},"
        "{\"sound\":\"glass_breaking\",\"kind\":\"heard\",\"confidence\":0.930,\"occurredAt\":\"2026-10-13T09:59:31.250Z\"},"
        "{\"sound\":\"water_running\",\"kind\":\"sustained\",\"confidence\":0.990,\"occurredAt\":\"2026-10-13T09:59:31.250Z\"}"
        "]}"));

    // Not sent (no 2xx): everything is still there for the retry.
    assert(q.count == 3);
    adam_sounds_sent(&q, covered);
    assert(q.count == 0);
    assert(adam_sounds_body(&q, T0, body, sizeof body, &covered) == 0 && !strcmp(body, "{\"events\":[]}"));

    // Recorded before SNTP set the clock, or held offline too long: dropped, never sent.
    adam_sounds_push(&q, "knock", 0, 0.9f, 0);
    adam_sounds_push(&q, "doorbell", 0, 0.9f, T0);
    assert(adam_sounds_body(&q, T0 + ADAM_SOUND_MAX_AGE_MS + 1, body, sizeof body, &covered) == 0 && q.count == 0);

    // Too small a buffer is an error, not a truncated body.
    adam_sounds_push(&q, "doorbell", 0, 0.9f, T0);
    assert(adam_sounds_body(&q, T0, body, 20, &covered) == -1);

    // A full queue keeps the newest.
    adam_sounds_init(&q);
    for (int i = 0; i < ADAM_SOUND_QUEUE + 3; i++) adam_sounds_push(&q, i % 2 ? "knock" : "doorbell", 0, 0.9f, T0 + (uint64_t)i * ADAM_SOUND_DEDUPE_MS);
    assert(q.count == ADAM_SOUND_QUEUE && q.dropped == 3);
    assert(adam_sounds_body(&q, T0 + (uint64_t)(ADAM_SOUND_QUEUE + 2) * ADAM_SOUND_DEDUPE_MS, body, sizeof body, &covered) == 1);
}

static void test_link(void) {
    adam_link_t l;
    adam_link_init(&l);
    assert(adam_link_may_send(&l, 0));
    assert(adam_link_result(&l, 0, 1000, 0) == ADAM_LINK_RETRY && l.retry_at_ms == 2000);
    assert(!adam_link_may_send(&l, 1999) && adam_link_may_send(&l, 2000));
    assert(adam_link_result(&l, 503, 2000, 250) == ADAM_LINK_RETRY && l.retry_at_ms == 4250);
    for (int i = 0; i < 20; i++) adam_link_result(&l, 500, 0, 0);
    assert(l.retry_at_ms == 60000);                       // capped
    assert(adam_link_result(&l, 429, 0, 0) == ADAM_LINK_RETRY);
    assert(adam_link_result(&l, 200, 5000, 0) == ADAM_LINK_OK && l.failures == 0 && adam_link_may_send(&l, 5000));
    assert(adam_link_result(&l, 400, 0, 0) == ADAM_LINK_REJECTED && adam_link_may_send(&l, 5000));
    assert(adam_link_result(&l, 401, 0, 0) == ADAM_LINK_UNPAIRED && !adam_link_may_send(&l, 1u << 30));
}

static void test_ring(void) {
    uint8_t mem[64], out[64];
    adam_ring_t r;
    adam_ring_init(&r, mem, sizeof mem, 1);              // 1 ms = 32 bytes of pre-roll
    assert(r.preroll == 32);

    // Network reads split samples anywhere; the speaker only ever sees whole samples, in order.
    uint8_t stream[40];
    for (int i = 0; i < 40; i++) stream[i] = (uint8_t)i;
    assert(adam_ring_write(&r, stream, 3) == 3 && r.count == 2 && r.has_carry);
    assert(adam_ring_read(&r, out, 64) == 0);           // pre-rolling
    assert(adam_ring_write(&r, stream + 3, 30) == 30 && r.count == 32 && r.has_carry == 1);
    assert(adam_ring_read(&r, out, 7) == 6);             // even only
    for (int i = 0; i < 6; i++) assert(out[i] == i);
    assert(adam_ring_read(&r, out, 64) == 26);
    for (int i = 0; i < 26; i++) assert(out[i] == 6 + i);
    assert(adam_ring_read(&r, out, 64) == 0 && r.underruns == 1);   // caught up mid-reply

    // A full ring takes what fits; the caller retries the rest.
    assert(adam_ring_write(&r, stream + 33, 7) == 7);    // carry(32)+33.. → 8 bytes, ring has room
    adam_ring_finish(&r);
    assert(adam_ring_read(&r, out, 64) == 8);
    for (int i = 0; i < 8; i++) assert(out[i] == 32 + i);
    assert(adam_ring_done(&r));

    adam_ring_init(&r, mem, sizeof mem, 0);
    uint8_t big[100] = {0};
    assert(adam_ring_write(&r, big, 100) == 64 && r.count == 64);
    assert(adam_ring_write(&r, big, 1) == 1 && r.has_carry);  // a lone byte is held, not stored
    assert(adam_ring_write(&r, big, 1) == 0);                  // and its pair has no room yet

    // A reply shorter than the pre-roll still plays once the stream ends.
    adam_ring_init(&r, mem, sizeof mem, 1);
    adam_ring_write(&r, stream, 10);
    assert(adam_ring_read(&r, out, 64) == 0);
    adam_ring_finish(&r);
    assert(adam_ring_read(&r, out, 64) == 10 && adam_ring_done(&r));
}

static void test_heartbeat(void) {
    adam_link_t l;
    adam_link_init(&l);
    assert(adam_link_heartbeat_due(&l, 0));                       // never heard back yet
    adam_link_result(&l, 200, 1000, 0);                          // e.g. a voice turn succeeded
    assert(!adam_link_heartbeat_due(&l, 1000 + ADAM_HEARTBEAT_MS - 1));
    assert(adam_link_heartbeat_due(&l, 1000 + ADAM_HEARTBEAT_MS));
    adam_link_result(&l, 503, 70000, 0);                         // backing off: no heartbeat spam
    assert(!adam_link_heartbeat_due(&l, 70500));
    assert(adam_link_heartbeat_due(&l, 72000));
    adam_link_result(&l, 401, 72000, 0);                         // unpaired: silent until paired again
    assert(!adam_link_heartbeat_due(&l, 10000000));
}

static void test_pairing(void) {
    char out[128], body[256];
    assert(adam_json_string("{\"a\":1,\"b\":{\"code\":\"no\"},\"code\":\"ABC DEF\"}", "code", out, sizeof out) == 7 && !strcmp(out, "ABC DEF"));
    assert(adam_json_string(" { \"k\" : \"q\\\"\\\\/\" } ", "k", out, sizeof out) == 4 && !strcmp(out, "q\"\\/"));
    assert(adam_json_string("{\"k\":\"caf\\u00e9\"}", "k", out, sizeof out) == -1);       // not decoded: refuse
    assert(adam_json_string("{\"k\":\"abcdef\"}", "k", out, 4) == -1);                    // too long: refuse
    assert(adam_json_string("{\"k\":12}", "k", out, sizeof out) == -1);
    assert(adam_json_string("{\"k\":\"open", "k", out, sizeof out) == -1);
    assert(adam_json_string("[\"k\",\"v\"]", "k", out, sizeof out) == -1);
    assert(adam_json_string("{\"a\":[1,\"]\",{}],\"k\":\"v\"}", "k", out, sizeof out) == 1);
    assert(adam_json_string("<html>502 Bad Gateway</html>", "k", out, sizeof out) == -1);

    assert(adam_pair_start_body("Kid's \"room\"\n", body, sizeof body) > 0);
    assert(!strcmp(body, "{\"name\":\"Kid's \\\"room\\\"\"}"));
    assert(adam_pair_start_body("Kitchen", body, 12) == -1);

    // The server's actual reply shape (api/services/device-pairing.js).
    adam_pairing_t p;
    const char *start = "{\"requestId\":\"0123456789abcdef0123456789abcdef\",\"code\":\"K7M 2QX\","
        "\"pollSecret\":\"aabbccddeeff00112233445566778899aabbccddeeff0011\","
        "\"expiresAt\":\"2026-10-13T12:40:00.000Z\",\"pollSeconds\":3}";
    assert(adam_pair_parse_start(start, &p) == 0);
    assert(!strcmp(p.code, "K7M 2QX") && p.poll_ms == 3000);
    assert(adam_pair_poll_body(&p, body, sizeof body) > 0);
    assert(!strcmp(body, "{\"requestId\":\"0123456789abcdef0123456789abcdef\","
        "\"pollSecret\":\"aabbccddeeff00112233445566778899aabbccddeeff0011\"}"));
    assert(adam_pair_parse_start("{\"error\":\"Too many pairing requests.\"}", &p) == -1 && !p.code[0]);
    assert(adam_pair_parse_start("{\"requestId\":\"r\",\"code\":\"ABC DEF\",\"pollSecret\":\"s\",\"pollSeconds\":0}", &p) == 0 && p.poll_ms == 1000);

    char id[64], token[96];
    assert(adam_pair_parse_poll(200, "{\"status\":\"pending\"}", id, sizeof id, token, sizeof token) == ADAM_PAIR_PENDING);
    assert(adam_pair_parse_poll(410, "{\"status\":\"expired\"}", id, sizeof id, token, sizeof token) == ADAM_PAIR_EXPIRED);
    assert(adam_pair_parse_poll(400, "", id, sizeof id, token, sizeof token) == ADAM_PAIR_EXPIRED);
    assert(adam_pair_parse_poll(503, "", id, sizeof id, token, sizeof token) == ADAM_PAIR_BAD);   // retry the poll
    assert(adam_pair_parse_poll(0, NULL, id, sizeof id, token, sizeof token) == ADAM_PAIR_BAD);
    assert(adam_pair_parse_poll(200, "{\"status\":\"paired\",\"displayId\":\"9b2f1c1e-4d1a-4c8e-9a51-0e3c2f7d8a10\","
        "\"name\":\"Kitchen\",\"token\":\"Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6\"}",
        id, sizeof id, token, sizeof token) == ADAM_PAIR_PAIRED);
    assert(!strcmp(id, "9b2f1c1e-4d1a-4c8e-9a51-0e3c2f7d8a10") && !strcmp(token, "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6"));
    assert(adam_pair_parse_poll(200, "{\"status\":\"paired\",\"displayId\":\"d\"}", id, sizeof id, token, sizeof token) == ADAM_PAIR_BAD && !id[0]);
}

int main(void) {
    test_pairing();
    test_heartbeat();
    test_ring();
    test_iso8601();
    test_wav();
    test_sounds();
    test_link();
    puts("adam-link: all tests passed");
    return 0;
}
