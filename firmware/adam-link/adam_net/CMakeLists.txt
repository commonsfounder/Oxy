# Add this directory to the BOX-3 project: set(EXTRA_COMPONENT_DIRS <Oxy>/firmware/adam-link/adam_net)
idf_component_register(
    SRCS "adam_net.c" "../adam_link.c" "../../sound-events/sound_events.c" "../../alarm-pattern/alarm_pattern.c"
    INCLUDE_DIRS "." ".." "../../sound-events" "../../alarm-pattern"
    REQUIRES esp_http_client esp-tls esp_wifi esp_netif esp_event esp_timer nvs_flash mbedtls
)
