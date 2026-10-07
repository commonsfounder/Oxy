#include "sound_events.h"
#include <string.h>

#define EPISODE_GAP_WINDOWS 4   // a sustained sound may drop out for up to 2 s without ending the episode

void se_init(se_t *s, const se_class_cfg_t *cfg, int classes) {
    memset(s, 0, sizeof *s);
    s->cfg = cfg;
    s->classes = classes < SE_MAX_CLASSES ? classes : SE_MAX_CLASSES;
}

void se_corroborate(se_t *s, int class_index) {
    if (class_index >= 0 && class_index < s->classes) s->corroborated[class_index] = 1;
}

int se_update(se_t *s, const float *scores, se_event_t *out, int max_out) {
    int written = 0;
    for (int i = 0; i < s->classes; i++) {
        const se_class_cfg_t *c = &s->cfg[i];
        se_class_state_t *st = &s->state[i];
        float score = scores[1 + i];
        float bar = s->corroborated[i] ? c->corroborated_threshold : c->threshold;
        s->corroborated[i] = 0;
        if (st->windows_since_report < 0xFFFFFFFFu) st->windows_since_report++;
        int counts = score >= bar;

        st->run = counts ? (uint8_t)(st->run < 255 ? st->run + 1 : 255) : 0;
        int cooled = !st->ever_reported || st->windows_since_report >= (uint32_t)c->cooldown_s * SE_WINDOWS_PER_SECOND;
        if (st->run >= c->hits && cooled && written < max_out) {
            out[written++] = (se_event_t){i, SE_HEARD, score};
            st->windows_since_report = 0;
            st->ever_reported = 1;
        }

        if (c->sustained_s) {
            if (counts) {
                st->gap = 0;
                st->sustained_run++;
            } else if (st->sustained_run) {
                if (++st->gap > EPISODE_GAP_WINDOWS) { st->sustained_run = 0; st->sustained_reported = 0; st->gap = 0; }
                else st->sustained_run++;
            }
            if (st->sustained_run >= (uint32_t)c->sustained_s * SE_WINDOWS_PER_SECOND && !st->sustained_reported && written < max_out) {
                out[written++] = (se_event_t){i, SE_SUSTAINED, score};
                st->sustained_reported = 1;
            }
        }
    }
    return written;
}
