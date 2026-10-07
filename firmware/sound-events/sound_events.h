// Turns a sound model's per-window class scores into alerts: how many windows in a row must agree, a cooldown so one
// event is reported once, and "sustained" events for things that only matter after a while (a tap left running).
// Plain C, no heap, no OS. Call se_update() once per model window (every 0.5 s with the models in
// test/dev/sound-eval). The thresholds in sound_events_config.h are calibrated by test/dev/sound-eval/tiny/calibrate.py.
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SE_MAX_CLASSES 24
#define SE_WINDOWS_PER_SECOND 2

typedef struct {
    const char *name;
    float threshold;            // score a window needs to count
    float corroborated_threshold; // lower bar when another sensor agrees (motion, door); same as threshold if unused
    uint8_t hits;               // windows in a row that must count
    uint16_t cooldown_s;        // after reporting, stay quiet this long
    uint16_t sustained_s;       // 0 = off; else also report once the sound has gone on this long
    uint8_t urgent;             // whoever receives the event should interrupt
} se_class_cfg_t;

typedef enum { SE_HEARD = 1, SE_SUSTAINED = 2 } se_kind_t;

typedef struct {
    int class_index;
    se_kind_t kind;
    float confidence;
} se_event_t;

typedef struct {
    uint8_t run;
    uint32_t windows_since_report;
    uint32_t sustained_run;     // windows of the current episode
    uint8_t gap;                // windows below threshold inside the episode
    uint8_t sustained_reported;
    uint8_t ever_reported;
} se_class_state_t;

typedef struct {
    const se_class_cfg_t *cfg;
    int classes;                // number of entries in cfg; score arrays hold one extra background score first
    se_class_state_t state[SE_MAX_CLASSES];
    uint8_t corroborated[SE_MAX_CLASSES];
} se_t;

void se_init(se_t *s, const se_class_cfg_t *cfg, int classes);
// Tell the engine another sensor currently agrees that this class may be happening (applies to the next update only).
void se_corroborate(se_t *s, int class_index);
// scores[0] is background, scores[1 + i] belongs to cfg[i]. Returns how many events were written to out.
int se_update(se_t *s, const float *scores, se_event_t *out, int max_out);

#ifdef __cplusplus
}
#endif
