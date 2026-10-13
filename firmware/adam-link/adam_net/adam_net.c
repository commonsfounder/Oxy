// Not yet compiled: no ESP-IDF toolchain was reachable where this was written. It uses only stable
// ESP-IDF v5.1+ APIs (esp_http_client, esp_crt_bundle, nvs, esp_wifi, esp_netif_sntp); build it
// with the BOX-3 firmware and fix anything the compiler finds before relying on it.
#include "adam_net.h"

#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "adam_net";
static SemaphoreHandle_t s_lock;
static EventGroupHandle_t s_wifi;
#define WIFI_UP BIT0

static uint64_t mono_ms(void) { return (uint64_t)(esp_timer_get_time() / 1000); }

uint64_t adam_net_unix_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    if (tv.tv_sec < 1704067200) return 0;   // before 2024: SNTP hasn't set the clock yet
    return (uint64_t)tv.tv_sec * 1000 + (uint64_t)(tv.tv_usec / 1000);
}

static esp_err_t read_str(nvs_handle_t h, const char *key, char *out, size_t cap) {
    size_t len = cap;
    return nvs_get_str(h, key, out, &len);
}

static void forget_pairing(adam_net_t *net) {
    nvs_handle_t h;
    if (nvs_open("adam", NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, "token");
        nvs_commit(h);
        nvs_close(h);
    }
    net->token[0] = '\0';
    ESP_LOGW(TAG, "Adam refused this device's token; pair it again from the app");
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)data;
    if (base == WIFI_EVENT && (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) {
        xEventGroupClearBits(s_wifi, WIFI_UP);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_wifi, WIFI_UP);
    }
}

esp_err_t adam_net_start(adam_net_t *net) {
    memset(net, 0, sizeof *net);
    adam_link_init(&net->link);
    adam_sounds_init(&net->sounds);
    s_lock = xSemaphoreCreateMutex();
    s_wifi = xEventGroupCreate();

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    char ssid[33] = {0}, pass[65] = {0};
    nvs_handle_t h;
    if (nvs_open("adam", NVS_READONLY, &h) != ESP_OK) return ESP_ERR_NOT_FOUND;
    err = read_str(h, "base_url", net->base_url, sizeof net->base_url);
    if (err == ESP_OK) err = read_str(h, "wifi_ssid", ssid, sizeof ssid);
    // Not paired yet is fine: adam_net_pair() fills these in.
    if (read_str(h, "display_id", net->display_id, sizeof net->display_id) != ESP_OK ||
        read_str(h, "token", net->token, sizeof net->token) != ESP_OK) {
        net->display_id[0] = net->token[0] = '\0';
    }
    if (err == ESP_OK && read_str(h, "wifi_pass", pass, sizeof pass) != ESP_OK) pass[0] = '\0';
    nvs_close(h);
    if (err != ESP_OK) return ESP_ERR_NOT_FOUND;

    ESP_ERROR_CHECK(esp_netif_init());
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;   // the board may already have one
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL));
    wifi_config_t sta = {0};
    strlcpy((char *)sta.sta.ssid, ssid, sizeof sta.sta.ssid);
    strlcpy((char *)sta.sta.password, pass, sizeof sta.sta.password);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));
    ESP_ERROR_CHECK(esp_wifi_start());

    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_netif_sntp_init(&sntp);

    xEventGroupWaitBits(s_wifi, WIFI_UP, pdFALSE, pdTRUE, pdMS_TO_TICKS(20000));
    if (net->token[0]) ESP_LOGI(TAG, "paired as %s with %s", net->display_id, net->base_url);
    else ESP_LOGI(TAG, "online, not paired with %s yet", net->base_url);
    return ESP_OK;
}

int adam_net_paired(const adam_net_t *net) { return net->token[0] && !net->link.unpaired; }

// POST a small JSON body to base_url + path (no device token) and read the reply into out.
static esp_err_t post_json(const adam_net_t *net, const char *path, const char *body, char *out, size_t cap, int *status) {
    char url[192];
    snprintf(url, sizeof url, "%s%s", net->base_url, path);
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 10000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 1024,
        .buffer_size_tx = 1024,
    };
    *status = 0;
    out[0] = '\0';
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return ESP_ERR_NO_MEM;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    int len = (int)strlen(body);
    esp_err_t err = esp_http_client_open(c, len);
    if (err == ESP_OK && esp_http_client_write(c, body, len) != len) err = ESP_FAIL;
    if (err == ESP_OK && esp_http_client_fetch_headers(c) < 0) err = ESP_FAIL;
    if (err == ESP_OK) {
        *status = esp_http_client_get_status_code(c);
        size_t got = 0;
        for (int r; got + 1 < cap && (r = esp_http_client_read(c, out + got, (int)(cap - 1 - got))) > 0;) got += (size_t)r;
        out[got] = '\0';
    }
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return err;
}

esp_err_t adam_net_pair(adam_net_t *net, const char *name, adam_show_code_fn show_code, void *ctx, uint32_t minutes) {
    static char reply[512];
    char body[256];
    adam_pairing_t p = {0};
    char display_id[sizeof net->display_id], token[sizeof net->token];
    uint64_t give_up = minutes ? mono_ms() + (uint64_t)minutes * 60000u : 0;
    uint32_t wait_ms = 3000;
    int status;

    while (!give_up || mono_ms() < give_up) {
        if (!p.code[0]) {
            // Ask for a code; on failure back off (rate limit, server down, Wi-Fi still coming up).
            if (adam_pair_start_body(name, body, sizeof body) < 0) return ESP_ERR_INVALID_ARG;
            if (post_json(net, "/devices/pairing", body, reply, sizeof reply, &status) == ESP_OK && status == 200 &&
                adam_pair_parse_start(reply, &p) == 0) {
                show_code(p.code, ctx);
                wait_ms = p.poll_ms;
            } else {
                ESP_LOGW(TAG, "pairing: no code yet (HTTP %d)", status);
                wait_ms = wait_ms < 30000 ? wait_ms * 2 : 30000;
            }
            vTaskDelay(pdMS_TO_TICKS(wait_ms));
            continue;
        }
        adam_pair_poll_body(&p, body, sizeof body);
        esp_err_t err = post_json(net, "/devices/pairing/poll", body, reply, sizeof reply, &status);
        switch (err == ESP_OK ? adam_pair_parse_poll(status, reply, display_id, sizeof display_id, token, sizeof token) : ADAM_PAIR_BAD) {
        case ADAM_PAIR_PAIRED: {
            // The server hands the token over once: it goes to flash before anything else.
            nvs_handle_t h;
            err = nvs_open("adam", NVS_READWRITE, &h);
            if (err == ESP_OK) {
                err = nvs_set_str(h, "display_id", display_id);
                if (err == ESP_OK) err = nvs_set_str(h, "token", token);
                if (err == ESP_OK) err = nvs_commit(h);
                nvs_close(h);
            }
            strlcpy(net->display_id, display_id, sizeof net->display_id);
            strlcpy(net->token, token, sizeof net->token);
            adam_link_init(&net->link);
            memset(token, 0, sizeof token);
            if (err != ESP_OK) ESP_LOGW(TAG, "paired, but saving to NVS failed (%d): this lasts until restart", (int)err);
            ESP_LOGI(TAG, "paired as %s", net->display_id);
            return ESP_OK;
        }
        case ADAM_PAIR_EXPIRED:
            p.code[0] = '\0';           // ten minutes passed or the server restarted: show a new code
            wait_ms = 3000;
            continue;
        case ADAM_PAIR_PENDING:
            break;
        case ADAM_PAIR_BAD:
            ESP_LOGW(TAG, "pairing poll failed (HTTP %d); retrying", status);
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(p.poll_ms));
    }
    return ESP_ERR_TIMEOUT;
}

static esp_http_client_handle_t open_post(adam_net_t *net, const char *route, const char *type, int timeout_ms) {
    char url[256], auth[112];
    snprintf(url, sizeof url, "%s/display/%s/%s", net->base_url, net->display_id, route);
    snprintf(auth, sizeof auth, "Bearer %s", net->token);
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = timeout_ms,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
        .buffer_size_tx = 1024,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return NULL;
    esp_http_client_set_header(c, "Authorization", auth);
    esp_http_client_set_header(c, "Content-Type", type);
    return c;
}

esp_err_t adam_net_voice(adam_net_t *net, const int16_t *pcm, size_t samples,
                         uint8_t *reply, size_t reply_cap, size_t *reply_len, int *status) {
    *reply_len = 0;
    *status = 0;
    if (!net->token[0] || net->link.unpaired) return ESP_ERR_INVALID_STATE;
    if (samples > (size_t)ADAM_SAMPLE_RATE * ADAM_MAX_CAPTURE_SECONDS) samples = (size_t)ADAM_SAMPLE_RATE * ADAM_MAX_CAPTURE_SECONDS;

    // A spoken turn runs the whole agent; give it as long as a person would wait.
    esp_http_client_handle_t c = open_post(net, "voice", "audio/wav", 60000);
    if (!c) return ESP_ERR_NO_MEM;
    uint8_t header[ADAM_WAV_HEADER_BYTES];
    uint32_t pcm_bytes = (uint32_t)(samples * 2);
    adam_wav_header(header, pcm_bytes);
    esp_err_t err = esp_http_client_open(c, (int)(sizeof header + pcm_bytes));
    if (err == ESP_OK && esp_http_client_write(c, (const char *)header, sizeof header) != (int)sizeof header) err = ESP_FAIL;
    for (size_t sent = 0; err == ESP_OK && sent < pcm_bytes;) {
        int chunk = (int)(pcm_bytes - sent > 4096 ? 4096 : pcm_bytes - sent);
        int w = esp_http_client_write(c, (const char *)pcm + sent, chunk);
        if (w <= 0) err = ESP_FAIL;
        else sent += (size_t)w;
    }
    if (err == ESP_OK && esp_http_client_fetch_headers(c) < 0) err = ESP_FAIL;
    if (err == ESP_OK) {
        *status = esp_http_client_get_status_code(c);
        while (*reply_len < reply_cap) {
            int r = esp_http_client_read(c, (char *)reply + *reply_len, (int)(reply_cap - *reply_len));
            if (r <= 0) break;
            *reply_len += (size_t)r;
        }
    }
    esp_http_client_close(c);
    esp_http_client_cleanup(c);

    adam_link_result_t result = adam_link_result(&net->link, *status, mono_ms(), esp_random() % 1000);
    if (result == ADAM_LINK_UNPAIRED) forget_pairing(net);
    return err;
}

esp_err_t adam_net_voice_stream(adam_net_t *net, const int16_t *pcm, size_t samples, adam_ring_t *ring, int *status) {
    *status = 0;
    if (!net->token[0] || net->link.unpaired) { adam_ring_finish(ring); return ESP_ERR_INVALID_STATE; }
    if (samples > (size_t)ADAM_SAMPLE_RATE * ADAM_MAX_CAPTURE_SECONDS) samples = (size_t)ADAM_SAMPLE_RATE * ADAM_MAX_CAPTURE_SECONDS;

    esp_http_client_handle_t c = open_post(net, "voice?stream=1", "audio/wav", 60000);
    if (!c) { adam_ring_finish(ring); return ESP_ERR_NO_MEM; }
    uint8_t header[ADAM_WAV_HEADER_BYTES];
    uint32_t pcm_bytes = (uint32_t)(samples * 2);
    adam_wav_header(header, pcm_bytes);
    esp_err_t err = esp_http_client_open(c, (int)(sizeof header + pcm_bytes));
    if (err == ESP_OK && esp_http_client_write(c, (const char *)header, sizeof header) != (int)sizeof header) err = ESP_FAIL;
    for (size_t sent = 0; err == ESP_OK && sent < pcm_bytes;) {
        int chunk = (int)(pcm_bytes - sent > 4096 ? 4096 : pcm_bytes - sent);
        int w = esp_http_client_write(c, (const char *)pcm + sent, chunk);
        if (w <= 0) err = ESP_FAIL;
        else sent += (size_t)w;
    }
    if (err == ESP_OK && esp_http_client_fetch_headers(c) < 0) err = ESP_FAIL;
    if (err == ESP_OK) {
        *status = esp_http_client_get_status_code(c);
        static uint8_t chunk[2048];
        while (*status == 200) {
            int r = esp_http_client_read(c, (char *)chunk, sizeof chunk);
            if (r <= 0) break;
            // The speaker drains the ring concurrently; wait for room rather than drop audio.
            for (size_t taken = 0; taken < (size_t)r;) {
                taken += adam_ring_write(ring, chunk + taken, (size_t)r - taken);
                if (taken < (size_t)r) vTaskDelay(pdMS_TO_TICKS(5));
            }
        }
    }
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    adam_ring_finish(ring);

    adam_link_result_t result = adam_link_result(&net->link, *status, mono_ms(), esp_random() % 1000);
    if (result == ADAM_LINK_UNPAIRED) forget_pairing(net);
    return err;
}

esp_err_t adam_net_heartbeat(adam_net_t *net) {
    if (!net->token[0] || !adam_link_heartbeat_due(&net->link, mono_ms())) return ESP_OK;
    esp_http_client_handle_t c = open_post(net, "heartbeat", "application/json", 10000);
    if (!c) return ESP_ERR_NO_MEM;
    esp_http_client_set_post_field(c, "{}", 2);
    esp_err_t err = esp_http_client_perform(c);
    int status = err == ESP_OK ? esp_http_client_get_status_code(c) : 0;
    esp_http_client_cleanup(c);
    if (adam_link_result(&net->link, status, mono_ms(), esp_random() % 1000) == ADAM_LINK_UNPAIRED) forget_pairing(net);
    return err;
}

void adam_net_heard_alarm(adam_net_t *net, alarm_kind_t kind) {
    const char *key = adam_alarm_key(kind);
    if (!key) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    adam_sounds_push(&net->sounds, key, 0, 0.95f, adam_net_unix_ms());
    xSemaphoreGive(s_lock);
}

void adam_net_heard_model(adam_net_t *net, const se_class_cfg_t *cfg, int classes, const se_event_t *events, int n) {
    if (n <= 0) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    adam_sounds_push_model(&net->sounds, cfg, classes, events, n, adam_net_unix_ms());
    xSemaphoreGive(s_lock);
}

esp_err_t adam_net_flush_sounds(adam_net_t *net) {
    static char body[2048];
    int covered = 0, events;
    if (!net->token[0] || !adam_link_may_send(&net->link, mono_ms())) return ESP_OK;
    uint64_t now = adam_net_unix_ms();
    if (!now) return ESP_OK;                    // keep detections until the clock is real
    xSemaphoreTake(s_lock, portMAX_DELAY);
    events = adam_sounds_body(&net->sounds, now, body, sizeof body, &covered);
    xSemaphoreGive(s_lock);
    if (events <= 0) return events < 0 ? ESP_ERR_NO_MEM : ESP_OK;

    esp_http_client_handle_t c = open_post(net, "sounds", "application/json", 10000);
    if (!c) return ESP_ERR_NO_MEM;
    esp_http_client_set_post_field(c, body, (int)strlen(body));
    esp_err_t err = esp_http_client_perform(c);
    int status = err == ESP_OK ? esp_http_client_get_status_code(c) : 0;
    esp_http_client_cleanup(c);

    adam_link_result_t result = adam_link_result(&net->link, status, mono_ms(), esp_random() % 1000);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    // Sent, or refused for good (4xx): either way don't resend. Anything else stays for the retry.
    if (result == ADAM_LINK_OK || result == ADAM_LINK_REJECTED) adam_sounds_sent(&net->sounds, covered);
    xSemaphoreGive(s_lock);
    if (result == ADAM_LINK_UNPAIRED) forget_pairing(net);
    ESP_LOGI(TAG, "sent %d sound(s): HTTP %d", events, status);
    return err;
}
