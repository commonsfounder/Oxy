#include "alarm_pattern.h"
#include <math.h>
#include <string.h>

static const float BAND_LOW[ALARM_BANDS] = {2200.f, 380.f};
static const float BAND_HIGH[ALARM_BANDS] = {4200.f, 680.f};
#define SUSTAINED_SECONDS 30.f

// ---- a small in-place radix-2 FFT (no library needed) ----

static void fft(const alarm_pattern_t *d, float *re, float *im) {
    int n = d->frame;
    for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { float t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (int len = 2; len <= n; len <<= 1) {
        int step = n / len;
        for (int i = 0; i < n; i += len) {
            for (int k = 0; k < len / 2; k++) {
                float c = d->cos_table[k * step], s = -d->sin_table[k * step];
                int a = i + k, b = i + k + len / 2;
                float tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
            }
        }
    }
}

void alarm_pattern_init(alarm_pattern_t *d, int sample_rate) {
    memset(d, 0, sizeof *d);
    d->sample_rate = (float)sample_rate;
    int length = 128;
    while ((double)(length * 2) <= sample_rate * 0.016 && length * 2 <= ALARM_FRAME_MAX) length *= 2;
    d->frame = length;
    d->hop = sample_rate / 100 > 0 ? sample_rate / 100 : 1;
    for (int i = 0; i < length; i++) d->window[i] = 0.5f * (1.f - cosf(2.f * (float)M_PI * i / length));
    for (int i = 0; i < length / 2; i++) {
        d->cos_table[i] = cosf(2.f * (float)M_PI * i / length);
        d->sin_table[i] = sinf(2.f * (float)M_PI * i / length);
    }
    d->beeping_since = -1.f;
}

void alarm_pattern_reset(alarm_pattern_t *d) {
    d->fill = 0;
    d->run_count = 0;
    d->current_on = 0;
    d->current_length = 0;
    d->current_pitch_count = 0;
    d->beeping_since = -1.f;
    memset(d->reported, 0, sizeof d->reported);
}

// ---- one frame: is a beep sounding? ----

static int is_beep(alarm_pattern_t *d) {
    float re[ALARM_FRAME_MAX], im[ALARM_FRAME_MAX], power[ALARM_FRAME_MAX / 2];
    int n = d->frame, half = n / 2;
    for (int i = 0; i < n; i++) { re[i] = d->buffer[i] * d->window[i]; im[i] = 0.f; }
    fft(d, re, im);
    float total = 0.f;
    // x4 keeps the scale of the Swift version (Accelerate's real FFT doubles amplitudes).
    for (int k = 0; k < half; k++) power[k] = 4.f * (re[k] * re[k] + im[k] * im[k]);
    power[0] = 0.f;
    for (int k = 0; k < half; k++) total += power[k];
    if (!(total > 0.f)) return 0;

    float bin_width = d->sample_rate / (float)n;
    int beep = 0;
    float energies[ALARM_BANDS] = {0};
    for (int b = 0; b < ALARM_BANDS; b++) {
        int low = (int)(BAND_LOW[b] / bin_width); if (low < 1) low = 1;
        int high = (int)(BAND_HIGH[b] / bin_width); if (high > half - 1) high = half - 1;
        if (high <= low) continue;
        float energy = 0.f;
        int peak = low;
        for (int k = low; k <= high; k++) { energy += power[k]; if (power[k] > power[peak]) peak = k; }
        energies[b] = energy;
        if (!(energy > 0.f)) continue;
        float around = 0.f;
        for (int k = (peak - 2 > low ? peak - 2 : low); k <= (peak + 2 < high ? peak + 2 : high); k++) around += power[k];
        int inside = peak > low + 1 && peak < high - 1;
        int tonal = inside && around / energy > 0.5f;
        int dominant = energy / total > 0.3f;
        float room = d->band_floor[b] * 3.f; if (room < 1e-9f) room = 1e-9f;
        int above_room = energy > room;
        if (tonal && dominant && above_room) {
            float decayed = d->band_peak[b] * 0.995f;
            d->band_peak[b] = decayed > energy ? decayed : energy;
        }
        int near_peak = energy > d->band_peak[b] * 0.125f;
        if (tonal && dominant && above_room && near_peak && !beep) {
            beep = 1;
            d->frame_pitch = (float)peak * bin_width;
        }
    }
    if (!beep) {
        for (int b = 0; b < ALARM_BANDS; b++)
            d->band_floor[b] = d->band_floor[b] == 0.f ? energies[b] : d->band_floor[b] * 0.98f + energies[b] * 0.02f;
    }
    return beep;
}

// ---- on/off timing ----

static float median(float *values, int count) {
    if (count == 0) return 0.f;
    float copy[ALARM_PITCHES];
    memcpy(copy, values, (size_t)count * sizeof(float));
    for (int i = 1; i < count; i++) {  // insertion sort: count is small
        float v = copy[i]; int j = i - 1;
        while (j >= 0 && copy[j] > v) { copy[j + 1] = copy[j]; j--; }
        copy[j + 1] = v;
    }
    return copy[count / 2];
}

static void add_pitch(alarm_pattern_t *d, float pitch) {
    if (d->current_pitch_count < ALARM_PITCHES) d->current_pitches[d->current_pitch_count++] = pitch;
}

static int in(float v, float low, float high) { return v >= low && v <= high; }

static int groups(const alarm_pattern_t *d, int beeps, float beep_low, float beep_high, float gap_low, float gap_high, float pause_low, float pause_high) {
    int group_length = beeps * 2, count = 0, end = d->run_count;
    while (end >= group_length) {
        int ok = 1;
        float low_pitch = 1e30f, high_pitch = 0.f;
        for (int offset = 0; offset < group_length; offset++) {
            const alarm_run_t *run = &d->runs[end - group_length + offset];
            int last = offset == group_length - 1;
            if (offset % 2 == 0) {
                ok = ok && run->on && in(run->length, beep_low, beep_high);
                if (run->pitch < low_pitch) low_pitch = run->pitch;
                if (run->pitch > high_pitch) high_pitch = run->pitch;
            } else {
                ok = ok && !run->on && (last ? in(run->length, pause_low, pause_high) : in(run->length, gap_low, gap_high));
            }
        }
        // An alarm sounds one fixed note; a voice or bird call slides between notes.
        if (low_pitch <= 0.f || high_pitch / low_pitch > 1.06f) ok = 0;
        if (!ok) break;
        count++;
        end -= group_length;
    }
    return count;
}

static int steady_beeping(const alarm_pattern_t *d) {
    if (d->run_count < 20) return 0;
    const alarm_run_t *recent = &d->runs[d->run_count - 20];
    float periods[10];
    int beeps = 0, gaps = 0;
    float beep_lengths[10], gap_lengths[10];
    for (int i = 0; i < 20; i++) {
        if (recent[i].on) {
            if (!in(recent[i].length, 0.05f, 0.8f)) return 0;
            beep_lengths[beeps++ % 10] = recent[i].length;
        } else {
            if (!in(recent[i].length, 0.015f, 0.9f)) return 0;
            gap_lengths[gaps++ % 10] = recent[i].length;
        }
    }
    int pairs = beeps < gaps ? beeps : gaps;
    if (pairs == 0) return 0;
    float mean = 0.f;
    for (int i = 0; i < pairs; i++) { periods[i] = beep_lengths[i] + gap_lengths[i]; mean += periods[i]; }
    mean /= (float)pairs;
    float variance = 0.f;
    for (int i = 0; i < pairs; i++) variance += (periods[i] - mean) * (periods[i] - mean);
    return sqrtf(variance / (float)pairs) / mean < 0.3f;
}

static alarm_kind_t match(alarm_pattern_t *d) {
    if (!d->reported[ALARM_SMOKE] && groups(d, 3, 0.3f, 0.85f, 0.25f, 0.8f, 1.0f, 2.4f) >= 2) {
        d->reported[ALARM_SMOKE] = 1;
        return ALARM_SMOKE;
    }
    if (!d->reported[ALARM_CARBON_MONOXIDE] && groups(d, 4, 0.05f, 0.3f, 0.015f, 0.3f, 0.9f, 6.5f) >= 3) {
        d->reported[ALARM_CARBON_MONOXIDE] = 1;
        return ALARM_CARBON_MONOXIDE;
    }
    if (steady_beeping(d)) {
        if (d->beeping_since < 0.f) d->beeping_since = d->clock;
        if (d->clock - d->beeping_since >= SUSTAINED_SECONDS && !d->reported[ALARM_SUSTAINED_BEEPING]) {
            d->reported[ALARM_SUSTAINED_BEEPING] = 1;
            return ALARM_SUSTAINED_BEEPING;
        }
    } else {
        d->beeping_since = -1.f;
    }
    return ALARM_NONE;
}

static alarm_kind_t step(alarm_pattern_t *d, int beep) {
    float frame_seconds = (float)d->hop / d->sample_rate;
    if (beep) add_pitch(d, d->frame_pitch);
    if ((beep != 0) == (d->current_on != 0)) {
        d->current_length += frame_seconds;
        if (!d->current_on && d->current_length > 6.f) { d->run_count = 0; d->beeping_since = -1.f; }
        return ALARM_NONE;
    }
    // Ignore flickers shorter than 1.5 frames by folding them back into the previous run.
    if (d->current_length < frame_seconds * 1.5f && d->run_count > 0) {
        alarm_run_t last = d->runs[--d->run_count];
        d->current_on = last.on;
        d->current_length = last.length + d->current_length + frame_seconds;
        if (last.on) {
            float merged[ALARM_PITCHES];
            int count = 0;
            for (int i = 0; i < d->previous_pitch_count && count < ALARM_PITCHES; i++) merged[count++] = d->previous_pitches[i];
            for (int i = 0; i < d->current_pitch_count && count < ALARM_PITCHES; i++) merged[count++] = d->current_pitches[i];
            memcpy(d->current_pitches, merged, (size_t)count * sizeof(float));
            d->current_pitch_count = count;
        } else {
            d->current_pitch_count = 0;
        }
        return ALARM_NONE;
    }
    if (d->run_count == ALARM_RUNS) {
        memmove(d->runs, d->runs + 1, (ALARM_RUNS - 1) * sizeof(alarm_run_t));
        d->run_count--;
    }
    alarm_run_t *run = &d->runs[d->run_count++];
    run->on = d->current_on;
    run->length = d->current_length;
    run->pitch = d->current_on ? median(d->current_pitches, d->current_pitch_count) : 0.f;
    memcpy(d->previous_pitches, d->current_pitches, (size_t)d->current_pitch_count * sizeof(float));
    d->previous_pitch_count = d->current_pitch_count;
    d->current_on = beep != 0;
    d->current_length = frame_seconds;
    d->current_pitch_count = 0;
    if (beep) add_pitch(d, d->frame_pitch);
    return match(d);
}

alarm_kind_t alarm_pattern_process_f32(alarm_pattern_t *d, const float *samples, size_t count) {
    alarm_kind_t found = ALARM_NONE;
    for (size_t i = 0; i < count; i++) {
        d->buffer[d->fill++] = samples[i];
        if (d->fill < d->frame) continue;
        d->clock += (float)d->hop / d->sample_rate;
        alarm_kind_t kind = step(d, is_beep(d));
        if (kind != ALARM_NONE && found == ALARM_NONE) found = kind;
        memmove(d->buffer, d->buffer + d->hop, (size_t)(d->frame - d->hop) * sizeof(float));
        d->fill = d->frame - d->hop;
    }
    return found;
}

alarm_kind_t alarm_pattern_process(alarm_pattern_t *d, const int16_t *samples, size_t count) {
    alarm_kind_t found = ALARM_NONE;
    float block[256];
    for (size_t at = 0; at < count; at += 256) {
        size_t n = count - at < 256 ? count - at : 256;
        for (size_t i = 0; i < n; i++) block[i] = (float)samples[at + i] / 32768.f;
        alarm_kind_t kind = alarm_pattern_process_f32(d, block, n);
        if (kind != ALARM_NONE && found == ALARM_NONE) found = kind;
    }
    return found;
}

const char *alarm_kind_name(alarm_kind_t kind) {
    switch (kind) {
        case ALARM_SMOKE: return "smoke_alarm";
        case ALARM_CARBON_MONOXIDE: return "co_alarm";
        case ALARM_SUSTAINED_BEEPING: return "alarm_beeping";
        default: return "none";
    }
}
