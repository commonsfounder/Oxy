// Smoke / carbon monoxide alarm recognition by beep pattern. A C port of
// OxyApp/OxyApp/Services/AlarmPatternDetector.swift: same thresholds, same timing, same results on the
// same recordings (run `make test`). No heap, no OS; about 7 KB of RAM and one 256-point FFT per 10 ms at 16 kHz.
//
//   alarm_pattern_t detector;
//   alarm_pattern_init(&detector, 16000);
//   // for every block of microphone samples (mono, 16-bit, any block size):
//   alarm_kind_t kind = alarm_pattern_process(&detector, samples, count);
//   if (kind != ALARM_NONE) { /* report it once; the detector will not repeat until reset */ }
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    ALARM_NONE = 0,
    ALARM_SMOKE,            // three ~0.5 s beeps, pause, repeating (ISO 8201 T3)
    ALARM_CARBON_MONOXIDE,  // four short beeps, pause, repeating (T4)
    ALARM_SUSTAINED_BEEPING // steady rapid beeping for 30 s, neither pattern (a clock, or an unknown alarm)
} alarm_kind_t;

#define ALARM_FRAME_MAX 512
#define ALARM_RUNS 40
#define ALARM_PITCHES 96
#define ALARM_BANDS 2

typedef struct { uint8_t on; float length; float pitch; } alarm_run_t;

typedef struct {
    float sample_rate;
    int frame, hop, fill;
    float clock;
    float window[ALARM_FRAME_MAX];
    float cos_table[ALARM_FRAME_MAX / 2], sin_table[ALARM_FRAME_MAX / 2];
    float buffer[ALARM_FRAME_MAX];
    float band_floor[ALARM_BANDS], band_peak[ALARM_BANDS];
    float frame_pitch;

    alarm_run_t runs[ALARM_RUNS];
    int run_count;
    uint8_t current_on;
    float current_length;
    float current_pitches[ALARM_PITCHES], previous_pitches[ALARM_PITCHES];
    int current_pitch_count, previous_pitch_count;
    float beeping_since;  // negative when not beeping
    uint8_t reported[4];
} alarm_pattern_t;

void alarm_pattern_init(alarm_pattern_t *d, int sample_rate);
// Forget any pattern in progress and allow every kind to be reported again (the room's quiet level is kept).
void alarm_pattern_reset(alarm_pattern_t *d);
alarm_kind_t alarm_pattern_process(alarm_pattern_t *d, const int16_t *samples, size_t count);
alarm_kind_t alarm_pattern_process_f32(alarm_pattern_t *d, const float *samples, size_t count);
const char *alarm_kind_name(alarm_kind_t kind);

#ifdef __cplusplus
}
#endif
