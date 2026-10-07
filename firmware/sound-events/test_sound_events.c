// Host test: scripted score streams and the events they must (and must not) produce.  make test
#include "sound_events.h"
#include <stdio.h>

static int failures;
#define CHECK(cond, msg) do { if (!(cond)) { printf("FAIL: %s\n", msg); failures++; } } while (0)

static const se_class_cfg_t CFG[] = {
    {"glass", 0.9f, 0.7f, 1, 60, 0, 1},
    {"baby", 0.8f, 0.8f, 2, 300, 0, 0},
    {"water", 0.8f, 0.8f, 2, 60, 600, 0},
};

static int feed(se_t *s, float glass, float baby, float water, se_event_t *ev) {
    float scores[4] = {0.1f, glass, baby, water};
    return se_update(s, scores, ev, 8);
}

int main(void) {
    se_t s; se_event_t ev[8];
    se_init(&s, CFG, 3);

    CHECK(feed(&s, 0.95f, 0, 0, ev) == 1 && ev[0].class_index == 0 && ev[0].kind == SE_HEARD, "one loud glass window fires immediately");
    CHECK(feed(&s, 0.95f, 0, 0, ev) == 0, "cooldown: the same glass is not reported twice");
    for (int i = 0; i < 118; i++) feed(&s, 0.0f, 0, 0, ev);
    CHECK(feed(&s, 0.95f, 0, 0, ev) == 1, "after the 60 s cooldown glass can fire again");

    CHECK(feed(&s, 0, 0.9f, 0, ev) == 0, "baby needs two windows in a row");
    CHECK(feed(&s, 0, 0.1f, 0, ev) == 0, "a gap resets the baby count");
    CHECK(feed(&s, 0, 0.9f, 0, ev) == 0 && feed(&s, 0, 0.9f, 0, ev) == 1, "two in a row fire");

    se_init(&s, CFG, 3);
    se_corroborate(&s, 0);
    CHECK(feed(&s, 0.75f, 0, 0, ev) == 1, "glass at 0.75 fires when motion agrees");
    CHECK(feed(&s, 0.75f, 0, 0, ev) == 0, "and not again without it");
    se_init(&s, CFG, 3);
    CHECK(feed(&s, 0.75f, 0, 0, ev) == 0, "glass at 0.75 stays quiet on its own");

    se_init(&s, CFG, 3);
    int sustained = 0, heard = 0;
    for (int i = 0; i < 1200 + 8; i++) {   // 10 minutes of a running tap, with brief dropouts
        int n = feed(&s, 0, 0, (i % 100 < 98) ? 0.9f : 0.2f, ev);
        for (int k = 0; k < n; k++) { if (ev[k].kind == SE_SUSTAINED) sustained++; else heard++; }
    }
    CHECK(sustained == 1, "tap running 10 minutes reports exactly one sustained event");
    CHECK(heard >= 10, "and the plain 'heard' event repeats once a minute");
    se_init(&s, CFG, 3);
    sustained = 0;
    for (int i = 0; i < 1500; i++) {   // a minute of tap, then it stops for 3 s, repeated: never 10 minutes in a row
        float w = (i % 120 < 118) ? 0.9f : 0.0f;
        int n = feed(&s, 0, 0, (i % 120 < 100) ? w : 0.0f, ev);
        for (int k = 0; k < n; k++) if (ev[k].kind == SE_SUSTAINED) sustained++;
    }
    CHECK(sustained == 0, "short bursts never add up to a sustained event");
    printf(failures ? "FAILED\n" : "ALL PASS\n");
    return failures != 0;
}
