#include "adam_net.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "nvs_flash.h"

#define TAG "adam_net"
#define MAX_REPLY_BYTES (16000 * 2 * 40)

typedef struct { char ssid[33], pass[65], url[129], id[65], token[97]; } config_t;
static config_t config;
static bool configured;
static volatile bool online;

static bool read_string(nvs_handle_t handle, const char *key, char *out, size_t capacity) {
    size_t size = capacity;
    return nvs_get_str(handle, key, out, &size) == ESP_OK;
}

static bool load_config(void) {
    nvs_handle_t handle;
    if (nvs_open("adam", NVS_READONLY, &handle) != ESP_OK) return false;
    bool ok = read_string(handle, "ssid", config.ssid, sizeof(config.ssid)) && read_string(handle, "pass", config.pass, sizeof(config.pass)) &&
              read_string(handle, "url", config.url, sizeof(config.url)) && read_string(handle, "id", config.id, sizeof(config.id)) &&
              read_string(handle, "token", config.token, sizeof(config.token));
    nvs_close(handle);
    return ok;
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) { online = false; esp_wifi_connect(); }
    else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) online = true;
}

void adam_net_init(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); err = nvs_flash_init(); }
    if (err != ESP_OK) { ESP_LOGE(TAG, "nvs init failed"); return; }
    configured = load_config();
    if (!configured) return;
    ESP_ERROR_CHECK(esp_netif_init());
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) ESP_ERROR_CHECK(err);
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));
    wifi_config_t wifi = {0};
    strlcpy((char *)wifi.sta.ssid, config.ssid, sizeof(wifi.sta.ssid));
    strlcpy((char *)wifi.sta.password, config.pass, sizeof(wifi.sta.password));
    wifi.sta.threshold.authmode = config.pass[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    ESP_ERROR_CHECK(esp_wifi_start());
}

bool adam_net_configured(void) { return configured; }
bool adam_net_online(void) { return configured && online; }

static bool copy_field(cJSON *root, const char *key, char *out, size_t capacity, bool required) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsString(item) || !item->valuestring) { if (required) return false; out[0] = 0; return true; }
    if (strlen(item->valuestring) >= capacity) return false;
    strcpy(out, item->valuestring);
    return true;
}

bool adam_net_store_config(const char *json) {
    cJSON *root = cJSON_Parse(json);
    if (!root) return false;
    config_t next = {0};
    bool ok = copy_field(root, "ssid", next.ssid, sizeof(next.ssid), true) && copy_field(root, "pass", next.pass, sizeof(next.pass), false) &&
              copy_field(root, "url", next.url, sizeof(next.url), true) && copy_field(root, "id", next.id, sizeof(next.id), true) &&
              copy_field(root, "token", next.token, sizeof(next.token), true);
    cJSON_Delete(root);
    size_t length = strlen(next.url);
    while (length && next.url[length - 1] == '/') next.url[--length] = 0;
    if (!ok || !next.ssid[0] || !next.id[0] || !next.token[0] || (strncmp(next.url, "http://", 7) && strncmp(next.url, "https://", 8))) return false;
    nvs_handle_t handle;
    if (nvs_open("adam", NVS_READWRITE, &handle) != ESP_OK) return false;
    ok = nvs_set_str(handle, "ssid", next.ssid) == ESP_OK && nvs_set_str(handle, "pass", next.pass) == ESP_OK &&
         nvs_set_str(handle, "url", next.url) == ESP_OK && nvs_set_str(handle, "id", next.id) == ESP_OK &&
         nvs_set_str(handle, "token", next.token) == ESP_OK && nvs_commit(handle) == ESP_OK;
    nvs_close(handle);
    return ok;
}

typedef struct { adam_reply_t *reply; size_t capacity; } transfer_t;

static void url_decode(const char *in, char *out, size_t capacity) {
    size_t n = 0;
    for (size_t i = 0; in[i] && n + 1 < capacity; i++) {
        if (in[i] == '%' && isxdigit((unsigned char)in[i + 1]) && isxdigit((unsigned char)in[i + 2])) {
            char hex[3] = {in[i + 1], in[i + 2], 0};
            out[n++] = (char)strtol(hex, NULL, 16); i += 2;
        } else out[n++] = in[i];
    }
    out[n] = 0;
}

static esp_err_t on_http(esp_http_client_event_t *event) {
    transfer_t *transfer = event->user_data;
    if (!transfer) return ESP_OK;
    adam_reply_t *reply = transfer->reply;
    if (event->event_id == HTTP_EVENT_ON_HEADER) {
        if (!strcasecmp(event->header_key, "X-Adam-Heard")) url_decode(event->header_value, reply->heard, sizeof(reply->heard));
        else if (!strcasecmp(event->header_key, "X-Adam-Reply")) url_decode(event->header_value, reply->reply, sizeof(reply->reply));
    } else if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
        if (reply->http_status == 0) reply->http_status = esp_http_client_get_status_code(event->client);
        if (reply->http_status != 200) return ESP_OK;  // error bodies are not audio
        if (reply->audio_bytes + event->data_len > MAX_REPLY_BYTES) return ESP_FAIL;
        if (reply->audio_bytes + event->data_len > transfer->capacity) {
            size_t capacity = transfer->capacity ? transfer->capacity * 2 : 65536;
            while (capacity < reply->audio_bytes + event->data_len) capacity *= 2;
            uint8_t *grown = heap_caps_realloc(reply->audio, capacity, MALLOC_CAP_SPIRAM);
            if (!grown) return ESP_FAIL;
            reply->audio = grown; transfer->capacity = capacity;
        }
        memcpy(reply->audio + reply->audio_bytes, event->data, event->data_len);
        reply->audio_bytes += event->data_len;
    }
    return ESP_OK;
}

static esp_http_client_handle_t open_client(const char *suffix, const char *content_type, transfer_t *transfer, int timeout_ms) {
    char url[256];
    snprintf(url, sizeof(url), "%s/display/%s/%s", config.url, config.id, suffix);
    esp_http_client_config_t http = {.url = url, .method = HTTP_METHOD_POST, .timeout_ms = timeout_ms, .buffer_size = 2048,
                                     .event_handler = on_http, .user_data = transfer, .crt_bundle_attach = esp_crt_bundle_attach};
    esp_http_client_handle_t client = esp_http_client_init(&http);
    if (!client) return NULL;
    char bearer[120];
    snprintf(bearer, sizeof(bearer), "Bearer %s", config.token);
    esp_http_client_set_header(client, "Authorization", bearer);
    esp_http_client_set_header(client, "Content-Type", content_type);
    return client;
}

bool adam_net_voice(const int16_t *pcm, size_t bytes, adam_reply_t *reply) {
    memset(reply, 0, sizeof(*reply));
    if (!adam_net_online()) return false;
    transfer_t transfer = {.reply = reply};
    esp_http_client_handle_t client = open_client("voice", "application/octet-stream", &transfer, 90000);
    if (!client) return false;
    esp_http_client_set_post_field(client, (const char *)pcm, (int)bytes);
    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK && reply->http_status == 0) reply->http_status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (err != ESP_OK) { ESP_LOGW(TAG, "voice request failed: %s", esp_err_to_name(err)); free(reply->audio); reply->audio = NULL; reply->audio_bytes = 0; return false; }
    if (reply->http_status != 200) { free(reply->audio); reply->audio = NULL; reply->audio_bytes = 0; }
    return true;
}

bool adam_net_post_json(const char *path, const char *json) {
    if (!adam_net_online()) return false;
    adam_reply_t ignored = {0};
    transfer_t transfer = {.reply = &ignored};
    esp_http_client_handle_t client = open_client(path, "application/json", &transfer, 15000);
    if (!client) return false;
    esp_http_client_set_post_field(client, json, (int)strlen(json));
    esp_err_t err = esp_http_client_perform(client);
    int status = err == ESP_OK ? esp_http_client_get_status_code(client) : 0;
    esp_http_client_cleanup(client);
    free(ignored.audio);
    return err == ESP_OK && status >= 200 && status < 300;
}
